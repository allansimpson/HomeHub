namespace HomeHub.Api.Controllers;

using System.Text;
using HomeHub.Api.Ai;
using HomeHub.Api.Assist;
using HomeHub.Api.Auth;
using HomeHub.Api.Data;
using HomeHub.Api.Settings;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// Assist — the household's chat system (ASSIST.md).
///
/// <para>
/// <b>This controller owns the ledger; Hermes owns the memory.</b> The split is the whole design:
/// unread state, pinning, archiving, titles and per-member scoping are inbox metadata that the agent
/// has no reason to hold, while the conversation's *meaning* to the agent lives in a Hermes session
/// this table only points at. Deleting a chat drops both, which is what makes the delete modal's
/// promise true.
/// </para>
/// <para>
/// It replaces <see cref="AssistantController"/>, which is kept alive as a thin shim for the Pi voice
/// bridge and anything else still posting a client-supplied history array.
/// </para>
/// </summary>
[ApiController]
[Route("api/assist")]
public class AssistController : ControllerBase
{
    private readonly HomeHubDbContext _db;
    private readonly AssistTurnService _turns;
    private readonly AgentRoster _roster;
    private readonly AgentAccess _access;
    private readonly HermesClient _hermes;
    private readonly SessionDeletionWorker _deletions;
    private readonly ConversationLocks _locks;
    private readonly TurnRegistry _turnRegistry;
    private readonly ConversationTitler _titler;
    private readonly AssistRetention _retention;
    private readonly LineageChallenges _challenges;
    private readonly LineageAudit _audit;
    private readonly ILogger<AssistController> _logger;

    public AssistController(
        HomeHubDbContext db,
        AssistTurnService turns,
        AgentRoster roster,
        AgentAccess access,
        HermesClient hermes,
        SessionDeletionWorker deletions,
        ConversationLocks locks,
        TurnRegistry turnRegistry,
        ConversationTitler titler,
        AssistRetention retention,
        LineageChallenges challenges,
        LineageAudit audit,
        ILogger<AssistController> logger)
    {
        _db = db;
        _turns = turns;
        _roster = roster;
        _access = access;
        _hermes = hermes;
        _deletions = deletions;
        _locks = locks;
        _turnRegistry = turnRegistry;
        _titler = titler;
        _retention = retention;
        _challenges = challenges;
        _audit = audit;
        _logger = logger;
    }

    // ---- Reading ----

    /// <summary>
    /// The main screen in one call: the active chats for this member and agent, the archived count
    /// for the footer row, the policy, and the roster with per-agent unread counts.
    /// </summary>
    /// <remarks>
    /// <b>The member is the caller</b> (AUDIT A1.2). This used to take <c>?profileId=</c>, which was
    /// the single worst instance of the pattern: changing a number in the URL returned somebody
    /// else's entire chat history to anything on the LAN. There is nothing to validate now, because
    /// there is no longer an input to validate.
    /// </remarks>
    [HttpGet("conversations")]
    public async Task<ConversationListDto> List(string? agent, CancellationToken ct)
    {
        var profileId = this.CallerId();
        var settings = await GetSettings(ct);
        await SweepAsync(profileId, settings, ct);

        // Resolved against what this member may use, not against the whole roster: an agent they were
        // never given must not become the list they are shown just because the URL named it.
        var agentKey = (await _access.ResolveForAsync(profileId, agent, ct)).Key;

        var rows = await Scope(profileId, agentKey)
            .Where(c => c.ArchivedAtUtc == null)
            .OrderByDescending(c => c.Pinned)
            .ThenByDescending(c => c.LastAtUtc)
            .Include(c => c.Messages)
            .ToListAsync(ct);

        var archived = await Scope(profileId, agentKey).CountAsync(c => c.ArchivedAtUtc != null, ct);
        var speaker = await SpeakerNameAsync(profileId, ct);

        return new ConversationListDto(
            [.. rows.Select(c => ToDto(c, speaker, _roster.Resolve(c.AgentKey).Name))],
            archived,
            settings.StoreConversations,
            settings.ConversationRetentionDays,
            await RosterAsync(profileId, ct));
    }

    /// <summary>
    /// The §3.1 lineage repair report. **Reads only — deletes and mutates nothing.**
    /// </summary>
    /// <remarks>
    /// <para>
    /// On demand rather than scheduled. It enumerates every session on every configured agent, which
    /// is not work to start on a timer behind a wall panel, and its output is for a person deciding
    /// whether the backfill can safely run — not for a screen.
    /// </para>
    /// <para>
    /// <b>What a clean report unlocks, and only then:</b> the lineage backfill, retention deletion,
    /// and D4's stronger delete-modal wording. <c>permittedDeleteCopy</c> in the response is the
    /// strongest thing the modal may currently say, so the gate travels with the evidence.
    /// </para>
    /// <para>
    /// It returns session ids and no session content — no titles, no previews — because it reads
    /// sessions HomeHub does not own in order to classify them, and reporting their content would be
    /// a worse privacy trade than the one it exists to fix.
    /// </para>
    /// </remarks>
    /// <remarks>
    /// <b>Read-only, and it changes no authority.</b> One revision of this stamped the household's
    /// deletion gate as a side effect of the GET, which is wrong twice over: a GET that changes global
    /// destructive authority is a thing a link preview or a refresh can trigger, and "somebody opened
    /// the report" was never the safety property anyway. Reconciling is
    /// <see cref="ReconcileLineage"/>, which is a POST and says what it did.
    /// </remarks>
    [HttpGet("lineage/report")]
    public Task<LineageReport> LineageReport(CancellationToken ct) => _audit.RunAsync(ct);

    /// <summary>
    /// Run the audit and record what it found, which is what releases deletion when it is clean.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A POST because it decides something. The verdict is the audit's, not the caller's: clean moves
    /// the household to <see cref="LineageState.Clean"/> and unclean to
    /// <see cref="LineageState.Blocked"/>, which keeps deletion refused. Running it again after
    /// repairing the agent is how a blocked household gets out; running it repeatedly does not wear it
    /// down.
    /// </para>
    /// <para>
    /// An unclean result also issues a <b>challenge</b> — the opaque, expiring token an administrator
    /// must return to authorise a specific deletion. It is bound to a digest of the whole report, so
    /// it can only have come from reading one, and only from reading <i>this</i> one.
    /// </para>
    /// </remarks>
    [HttpPost("lineage/reconcile")]
    public async Task<LineageReconciliation> ReconcileLineage(CancellationToken ct)
    {
        var report = await _audit.RunAsync(ct);
        var settings = await TrackedSettingsAsync(ct);

        settings.LineageState = report.Clean ? LineageState.Clean : LineageState.Blocked;
        settings.LineageAuditedAtUtc = DateTime.UtcNow;
        await _db.SaveChangesAsync(ct);

        return await ReconciliationOf(report, settings.LineageState, ct);
    }

    /// <summary>
    /// Authorise the deletion of named conversations against an unclean lineage. <b>Administrators only.</b>
    /// </summary>
    /// <remarks>
    /// <para>
    /// The way past <see cref="LineageState.Blocked"/> when the damage cannot be repaired, and it is
    /// built to be hard to do by accident or at a distance.
    /// </para>
    /// <para>
    /// <b>The confirmation is the challenge, not the session list.</b> It was the session list, and
    /// that was fail-open in exactly the case that matters most: an agent that cannot be read
    /// enumerates no sessions, so the unresolved set is empty, so an empty acknowledgement matched it
    /// — and an acceptance could be issued having read nothing at all. Matching an enumeration cannot
    /// represent a failure *of* enumeration. The challenge is bound to reachability and blocking
    /// reasons as well, so the inability to enumerate is part of what is signed.
    /// </para>
    /// <para>
    /// <b>And it authorises a deletion rather than a household.</b> It names the conversations, it is
    /// used once, it expires, and it is refused if the report has changed since it was issued. It
    /// never releases background retention: that reads the household's state, which stays
    /// <see cref="LineageState.Blocked"/> throughout.
    /// </para>
    /// </remarks>
    [HttpPost("lineage/accept-risk")]
    [Authorize(Policy = Household.AdminPolicy)]
    public async Task<ActionResult<LineageAcceptanceResult>> AcceptLineageRisk(
        AcceptLineageRiskRequest req, CancellationToken ct)
    {
        var conversationIds = (req.ConversationIds ?? []).Distinct().OrderBy(x => x).ToList();
        if (conversationIds.Count == 0)
            return BadRequest("Name the conversations this authorises. A blanket acceptance is not one.");

        if (string.IsNullOrWhiteSpace(req.Challenge))
            return BadRequest("Reconcile the lineage first and return the challenge it issues.");

        var report = await _audit.RunAsync(ct);
        if (report.Clean)
        {
            return BadRequest(
                "This household's lineage is reconciled clean; there is nothing to accept. Reconcile "
                + "instead and delete normally.");
        }

        var digest = await FingerprintAsync(report, ct);
        if (_challenges.Open(req.Challenge) is not { } challenge)
            return Conflict("That challenge is not readable. Reconcile the lineage and use the challenge it returns.");
        if (challenge.ExpiresAtUtc <= DateTime.UtcNow)
            return Conflict("That challenge has expired. Reconcile the lineage again.");
        if (!string.Equals(challenge.Digest, digest, StringComparison.Ordinal))
        {
            return Conflict(
                "The lineage has changed since that challenge was issued, so it no longer describes "
                + "what would be accepted. Reconcile again and read the new report.");
        }

        // Replay is refused by the nonce being unique, not by hoping it is not reused.
        if (await _db.LineageRiskAcceptances.AnyAsync(a => a.Nonce == challenge.Nonce, ct))
            return Conflict("That challenge has already been used. Reconcile the lineage again.");

        _db.LineageRiskAcceptances.Add(new LineageRiskAcceptance
        {
            Nonce = challenge.Nonce,
            ReportDigest = digest,
            ConversationIds = string.Join(',', conversationIds),
            BlockingReasons = string.Join(" | ", report.BlockingReasons),
            AcceptedByProfileId = this.CallerId(),
            AcceptedAtUtc = DateTime.UtcNow,
            ExpiresAtUtc = DateTime.UtcNow.Add(LineageChallenges.AcceptanceLifetime),
        });
        await _db.SaveChangesAsync(ct);

        _logger.LogWarning(
            "Profile {ProfileId} authorised deleting {Count} conversation(s) against an unclean Hermes "
            + "lineage. Background retention remains paused.",
            this.CallerId(), conversationIds.Count);

        return new LineageAcceptanceResult(conversationIds, report.BlockingReasons);
    }

    /// <summary>
    /// The unspent acceptance that authorises deleting exactly these conversations, or why there is none.
    /// </summary>
    /// <remarks>
    /// The audit runs here, and that is deliberate: "the report has not changed" cannot be established
    /// from a stored digest alone. It is the exceptional path — an unclean household deleting by hand —
    /// so the cost falls where the risk is rather than on every ordinary deletion.
    /// </remarks>
    private async Task<(LineageRiskAcceptance? Acceptance, string? Refusal)> AuthorisedByAcceptanceAsync(
        IReadOnlyList<int> ids, CancellationToken ct)
    {
        var wanted = string.Join(',', ids.Distinct().OrderBy(x => x));
        var now = DateTime.UtcNow;

        var candidates = await _db.LineageRiskAcceptances
            .Where(a => a.ConsumedAtUtc == null && a.ExpiresAtUtc > now && a.ConversationIds == wanted)
            .ToListAsync(ct);

        if (candidates.Count == 0)
        {
            return (null, "This panel's assistant lineage is not reconciled clean, so deleting could "
                + "leave transcripts on the assistant that nothing could find afterwards. Reconcile the "
                + "lineage; if it cannot be repaired, an administrator can authorise these exact "
                + "conversations after reading the report.");
        }

        // The digest is recomputed rather than trusted: an acceptance describes the lineage as it was,
        // and what matters is whether that is still what deleting would do.
        var report = await _audit.RunAsync(ct);
        var digest = await FingerprintAsync(report, ct);
        var usable = candidates.FirstOrDefault(a => string.Equals(a.ReportDigest, digest, StringComparison.Ordinal));

        return usable is null
            ? (null, "The assistant's lineage has changed since that deletion was authorised, so the "
                + "authorisation no longer describes what would happen. Reconcile again and read the "
                + "new report.")
            : (usable, null);
    }

    /// <summary>Everything a reconciliation reports, including a challenge when it is not clean.</summary>
    private async Task<LineageReconciliation> ReconciliationOf(
        LineageReport report, LineageState state, CancellationToken ct) =>
        new(state,
            report.Clean,
            report.BlockingReasons,
            UnresolvedSessions(report),
            report.Clean ? null : _challenges.Issue(await FingerprintAsync(report, ct)));

    /// <summary>
    /// The report's fingerprint, including the local anchors it would have been reconciled against.
    /// </summary>
    /// <remarks>
    /// The anchors are in the digest because a conversation created or re-sessioned after the
    /// administrator read the report is damage they did not accept.
    /// </remarks>
    private async Task<string> FingerprintAsync(LineageReport report, CancellationToken ct)
    {
        var anchors = await _db.Conversations
            .AsNoTracking()
            .Select(c => c.Id + ":" + (c.HermesSessionId ?? ""))
            .ToListAsync(ct);
        var references = await _db.HermesSessionReferences
            .AsNoTracking()
            .Select(r => r.ConversationId + ">" + r.SessionId)
            .ToListAsync(ct);

        return LineageFingerprint.Of(report, anchors.Concat(references));
    }

    /// <summary>Every session the report could not vouch for, deduplicated across agents.</summary>
    private static IReadOnlyList<string> UnresolvedSessions(LineageReport report) =>
        [.. report.Agents
            .SelectMany(a => a.Findings)
            .Select(f => f.SessionId)
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(id => id, StringComparer.Ordinal)];

    /// <summary>
    /// The settings row, tracked.
    /// </summary>
    /// <remarks>
    /// Deliberately not <see cref="GetSettings"/>, which reads <c>AsNoTracking</c> — writing to what
    /// that returns changes nothing and saves nothing. One revision of the lineage stamp did exactly
    /// that and was a silent no-op.
    /// </remarks>
    private async Task<HouseholdSettings> TrackedSettingsAsync(CancellationToken ct) =>
        await _db.Settings.FirstOrDefaultAsync(x => x.Id == 1, ct)
        ?? throw new InvalidOperationException("Household settings row is missing.");

    /// <summary>The archive (ASSIST.md · `1h`) — same rows, opposite side of the flag.</summary>
    [HttpGet("conversations/archived")]
    public async Task<IReadOnlyList<ConversationDto>> Archived(string? agent, CancellationToken ct)
    {
        var profileId = this.CallerId();
        var agentKey = (await _access.ResolveForAsync(profileId, agent, ct)).Key;
        var rows = await Scope(profileId, agentKey)
            .Where(c => c.ArchivedAtUtc != null)
            .OrderByDescending(c => c.ArchivedAtUtc)
            .Include(c => c.Messages)
            .ToListAsync(ct);

        var speaker = await SpeakerNameAsync(profileId, ct);
        return [.. rows.Select(c => ToDto(c, speaker, _roster.Resolve(c.AgentKey).Name))];
    }

    /// <summary>
    /// One conversation with its turns. **Marks it read** — opening a chat is the act that clears its
    /// badge, so there is no separate "mark read" call for the client to forget.
    /// </summary>
    /// <remarks>
    /// Scoped to the caller (AUDIT A1.2). Without this, making the *list* session-scoped would have
    /// achieved nothing: the ids are small integers, and reading somebody else's chat would have
    /// been a matter of counting. <c>NotFound</c> rather than <c>Forbid</c> on purpose — telling an
    /// unauthorised caller that a conversation exists but is not theirs is itself an answer they
    /// should not get.
    /// </remarks>
    [HttpGet("conversations/{id:int}")]
    public async Task<ActionResult<ConversationDetailDto>> Detail(int id, CancellationToken ct)
    {
        var convo = await _db.Conversations.Include(c => c.Messages).FirstOrDefaultAsync(c => c.Id == id, ct);
        if (convo is null || !Owns(convo)) return NotFound();

        convo.ReadAtUtc = DateTime.UtcNow;
        await _db.SaveChangesAsync(ct);

        var speaker = await SpeakerNameAsync(convo.ProfileId, ct);
        return new ConversationDetailDto(
            ToDto(convo, speaker, _roster.Resolve(convo.AgentKey).Name),
            [.. convo.Messages.OrderBy(m => m.AtUtc).ThenBy(m => m.Id).Select(ToDto)]);
    }

    /// <summary>The agent roster for this member, with the unread counts the dropdown badge needs.</summary>
    [HttpGet("agents")]
    public Task<IReadOnlyList<AgentDto>> Agents(CancellationToken ct) => RosterAsync(this.CallerId(), ct);

    /// <summary>
    /// **Every** configured agent, with whether this member has it — the Config assignment editor.
    /// </summary>
    /// <remarks>
    /// Deliberately not the same endpoint as <see cref="Agents"/>. That one answers "what may I switch
    /// between", and returning unassigned agents there would put agents nobody granted into the
    /// switcher. This one answers "what could this member be given", which is a different question
    /// asked from a different screen by (usually) a different person.
    /// </remarks>
    [HttpGet("assignments/{profileId:int}")]
    public async Task<ActionResult<AgentAssignmentsDto>> Assignments(int profileId, CancellationToken ct)
    {
        // Self-or-admin (AUDIT A1.4). The id is a real argument here — this endpoint is *about* a
        // named member, reached from a settings screen that may be administering someone else — so
        // it stays a parameter and the authorisation is what stops being the caller's to decide.
        if (!this.MayActFor(profileId)) return Forbid();
        if (!await _db.Profiles.AnyAsync(p => p.Id == profileId, ct)) return NotFound();

        var mine = await _access.ForAsync(profileId, ct);
        var def = _roster.Default;
        // Resolved rather than read raw, so a preference naming a revoked or removed agent shows the
        // editor what Assist will actually do — which is fall back to the household agent.
        var opensOn = await _access.DefaultForAsync(profileId, ct);

        return new AgentAssignmentsDto(
            [.. _roster.All.Select(a => new AssignableAgentDto(
                a.Key,
                a.Name,
                a.Tagline,
                a.IsConfigured,
                string.Equals(a.Key, def.Key, StringComparison.OrdinalIgnoreCase),
                mine.Any(m => string.Equals(m.Key, a.Key, StringComparison.OrdinalIgnoreCase)),
                string.Equals(a.Key, opensOn.Key, StringComparison.OrdinalIgnoreCase)))]);
    }

    /// <summary>Replace a member's agent assignments.</summary>
    /// <remarks>
    /// Whole-list rather than grant/revoke, so two people editing the same member cannot interleave
    /// into a set neither of them chose. The default agent is implicit: sending it changes nothing,
    /// and omitting it does not take it away (see <see cref="ProfileAgent"/>).
    /// </remarks>
    [HttpPut("assignments/{profileId:int}")]
    public async Task<ActionResult<AgentAssignmentsDto>> SetAssignments(
        int profileId, SetAgentAssignmentsRequest req, CancellationToken ct)
    {
        // Administrators only, and unlike the reader above this one is not self-or-admin: granting
        // yourself an agent is exactly the decision the roster exists to be somebody else's.
        if (!User.IsHouseholdAdmin()) return Forbid();
        if (!await _db.Profiles.AnyAsync(p => p.Id == profileId, ct)) return NotFound();

        await _access.SetAsync(profileId, req.AgentKeys ?? [], ct);
        return await Assignments(profileId, ct);
    }

    /// <summary>Choose which of a member's agents Assist opens on.</summary>
    /// <remarks>
    /// <para>
    /// Separate from the assignment editor above, and refuses rather than grants: giving somebody an
    /// agent and picking which of theirs comes up first are different decisions, usually made by
    /// different people, and a "default" that quietly assigned would let the smaller decision make the
    /// larger one.
    /// </para>
    /// <para>
    /// A 404 means no such member; a 400 means the agent is not one of theirs. The panel cannot
    /// normally produce either — the picker is drawn from this member's own list — so both are
    /// answers to a request that raced a revocation, and saying which went wrong is worth more than a
    /// shared code.
    /// </para>
    /// </remarks>
    [HttpPut("assignments/{profileId:int}/default")]
    public async Task<ActionResult<AgentAssignmentsDto>> SetDefaultAgent(
        int profileId, SetDefaultAgentRequest req, CancellationToken ct)
    {
        // Self-or-admin, unlike the grant above: this picks between agents the member already has,
        // so it is a preference rather than a grant and it is theirs to express.
        if (!this.MayActFor(profileId)) return Forbid();
        if (!await _db.Profiles.AnyAsync(p => p.Id == profileId, ct)) return NotFound();
        if (!await _access.SetDefaultAsync(profileId, req.AgentKey, ct))
            return BadRequest($"'{req.AgentKey}' is not an agent this member has.");

        return await Assignments(profileId, ct);
    }

    /// <summary>
    /// How often a turn with nothing to say says so anyway.
    /// </summary>
    /// <remarks>
    /// Well inside the timeouts an intermediary is likely to have — nginx's <c>proxy_read_timeout</c>
    /// defaults to 60s, and the dev server's proxy hop has one of its own — while being rare enough
    /// that it is invisible in a capture of an ordinary turn.
    /// </remarks>
    private static readonly TimeSpan KeepAliveEvery = TimeSpan.FromSeconds(15);

    // ---- Writing ----

    /// <summary>
    /// One turn, streamed to the browser as it arrives.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The path that matters for how the panel *feels*. Headers are committed before Hermes is asked
    /// anything, each delta is forwarded and flushed the instant it arrives, and the reply is
    /// accumulated only so it can be persisted — never so it can be sent. The number worth measuring
    /// is browser-submit to first painted character, which is why nothing between those two points
    /// waits on anything it does not have to.
    /// </para>
    /// <para>
    /// <b>Visible completion is not blocked by bookkeeping.</b> The <c>done</c> event goes out as soon
    /// as the turn is persisted and carries everything the panel needs. Reconciliation and repair
    /// happen after it, while the conversation lock is still held — the household is not kept waiting
    /// on work they cannot see.
    /// </para>
    /// <para>
    /// <b>The turn outlives the connection.</b> Everything after the response is committed runs on the
    /// turn's own token, not on <c>RequestAborted</c>, and the ledger write is never given a token at
    /// all. A reader who walks to another screen, a display that sleeps, a wifi blink — none of those
    /// is a decision to abandon what was asked, and each of them used to lose the member's message
    /// outright, because nothing is written until the turn ends. Stopping is a separate request:
    /// <see cref="CancelTurn"/>, named by the id in the <c>open</c> frame.
    /// </para>
    /// <para>
    /// Errors after the stream has opened are an <c>error</c> event rather than a status code: the
    /// response was committed the moment streaming began, so there is no status left to send.
    /// </para>
    /// </remarks>
    [EnableRateLimiting(RateLimits.AssistTurn)]
    [HttpPost("chat/stream")]
    public async Task StreamChat(AssistChatRequest req, CancellationToken ct)
    {
        using var sse = new SseWriter(Response);
        var prompt = (req.Prompt ?? "").Trim();

        if (IsEmptyTurn(req, prompt) || IsOversized(req))
        {
            Response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }
        if (prompt.Length > AssistFieldLimits.MaxPromptChars)
        {
            Response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }

        var settings = await GetSettings(ct);
        var now = DateTime.UtcNow;

        Conversation? convo = null;
        if (req.ConversationId is { } cid)
        {
            convo = await _db.Conversations.FirstOrDefaultAsync(c => c.Id == cid, ct);
            if (convo is null || !Owns(convo))
            {
                Response.StatusCode = StatusCodes.Status404NotFound;
                return;
            }
        }

        // Whether this turn is about to open a chat, remembered before `PersistAsync` opens it. Only
        // a chat's *first* turn is worth naming, and afterwards there is no way to tell which it was.
        var opening = convo is null;

        // The conversation owns its agent — see Chat above for why this is not a preference.
        Agent agent;
        if (convo is not null)
        {
            agent = _roster.Resolve(convo.AgentKey);
            if (!await _access.CanUseAsync(convo.ProfileId, convo.AgentKey, ct))
            {
                Response.StatusCode = StatusCodes.Status403Forbidden;
                return;
            }
        }
        else
        {
            if (req.AgentKey is { Length: > 0 } requested && !_roster.Knows(requested))
            {
                Response.StatusCode = StatusCodes.Status400BadRequest;
                return;
            }
            agent = await _access.ResolveForAsync(this.CallerId(), req.AgentKey, ct);
        }

        using var gate = convo is null ? null : await _locks.AcquireAsync(convo.Id, ct);

        // Commit the response now. Everything above is local; everything below can take seconds.
        await sse.StartAsync(ct);

        /*
         * The turn's own lifetime, which is deliberately not the request's.
         *
         * Everything from here runs on `turn.Token`. `ct` is RequestAborted, and on a wall panel that
         * fires for reasons that have nothing to do with wanting the answer any less: somebody moved
         * to another screen, the display dimmed out, the wifi blinked. Stopping is something a member
         * does on purpose, and they do it by name — see TurnRegistry and CancelTurn.
         */
        using var turn = _turnRegistry.Begin(this.CallerId());

        // A reader who has gone must not take the turn with them, so every send from here down is
        // best-effort. See SseWriter.TrySendAsync.
        Task Tell<T>(string name, T payload) => sse.TrySendAsync(name, payload, ct);

        // An agent that thinks for four minutes writes nothing at all in the meantime, and an idle
        // connection is what proxies reap. Held for the whole turn, released before the response ends.
        await using var beat = sse.KeepAlive(KeepAliveEvery, turn.Token);

        // The id before anything it identifies: a Stop pressed while the first token is still on its
        // way has to have something to name.
        await Tell("open", new { turnId = turn.Id });

        // Actions-first still runs first, and still never reaches Hermes. Its reply is whole rather
        // than streamed because there is nothing to stream — no model was involved.
        if (await _turns.TryActionAsync(string.IsNullOrEmpty(req.ImageBase64) ? prompt : "", this.CallerId(), turn.Token)
            is { } action)
        {
            var (id, msg) = await PersistAsync(convo, agent, req, prompt, action, now, settings, CancellationToken.None);
            // Recorded before it is sent, for the same reason as the streamed path below: the send is
            // best-effort and the record is what a panel that never received it comes back to read.
            _turnRegistry.Complete(turn.Id, new TurnOutcome(
                this.CallerId(), id, msg?.Id ?? 0, "stop", action.Text, action.Action));
            await Tell("delta", new { text = action.Text });
            await Tell("done", new
            {
                conversationId = id,
                messageId = msg?.Id ?? 0,
                origin = action.Origin.ToString(),
                action = action.Action,
                finishReason = "stop",
            });
            return;
        }

        // Before opening a session, not after: an agent with no gateway configured has nothing to
        // open one against, and this reads as the precondition it is.
        if (!_hermes.IsConfigured(agent.Key))
        {
            await Tell("error", new { message = "No assistant is set up on this panel yet.", retryable = false });
            return;
        }

        var sessionId = convo?.HermesSessionId
            ?? await _hermes.CreateSessionAsync(agent.Key, AssistTitle.From(prompt), turn.Token);

        // A chat with no session is not a chat, and must not be attempted as one.
        //
        // `CreateSessionAsync` returns null when Hermes refuses — which it does for reasons that have
        // nothing to do with this request, an expired provider credential among them. Without this the
        // turn went on to stream against a null session: Hermes answers 200 in under a millisecond,
        // sends nothing a reader can use, and the panel sits on `open` forever. A member watching that
        // has no way to tell a dead turn from a slow one, which is the worst thing this screen can do.
        // Said in the same shape as the precondition above, and retryable, because the usual cause is
        // something upstream that will be fixed without the household changing anything.
        if (sessionId is null or { Length: 0 })
        {
            _logger.LogWarning("No Hermes session for agent '{Agent}'; the turn was not attempted.", agent.Key);
            await Tell("error", new { message = "The assistant is unreachable right now. Please try again.", retryable = true });
            return;
        }

        var text = new StringBuilder();
        string? finishReason = null;
        var interrupted = false;
        HermesStreamEnd? end = null;

        try
        {
            await foreach (var item in _hermes.StreamChatAsync(
                agent.Key, sessionId, BuildContent(req, prompt), turn.Token))
            {
                switch (item)
                {
                    case HermesTextDelta d:
                        text.Append(d.Text);
                        // Forwarded immediately. Accumulating first would make this endpoint an
                        // expensive way to do what the non-streaming one already does.
                        await Tell("delta", new { text = d.Text });
                        break;

                    // The working, not the answer. Forwarded on its own event and deliberately never
                    // appended to `text`: reasoning contradicts itself and abandons conclusions, and
                    // folding it into the reply would write sentences the agent decided not to say
                    // into the ledger. Whether it is *shown* is the member's choice, made on the
                    // panel — see `assistPrefs.ts` — which is why this is not conditional here.
                    case HermesReasoningDelta r:
                        await Tell("thinking", new { text = r.Text });
                        break;

                    // Live activity only. A tool that started is not a write that committed, so this
                    // never becomes a receipt — and Hermes's own `tool_describe` is not the house.
                    case HermesToolProgress p when p.HouseMethod is { } method:
                        await Tell("tool", new { tool = method, status = p.Status, p.ToolCallId });
                        break;

                    case HermesTurnComplete c:
                        finishReason = c.FinishReason;
                        break;

                    case HermesStreamEnd e:
                        end = e;
                        break;
                }
            }
        }
        catch (OperationCanceledException)
        {
            // The member pressed Stop — the only thing that cancels this token now. Hermes is told,
            // but it notices on its next write and its tools stop cooperatively, so this is
            // *cancellation requested* rather than a turn that certainly stopped. Whatever arrived is
            // kept: a partial answer is worth more than a blank.
            interrupted = true;
        }
        catch (HermesBusyException)
        {
            await Tell("error", new { message = "The assistant is handling something else right now.", retryable = true });
            return;
        }
        catch (HermesAuthException ex)
        {
            _logger.LogError("Hermes rejected HomeHub's credential for agent '{Agent}' ({Status}).", ex.AgentKey, (int)ex.Status);
            await Tell("error", new { message = "The assistant is unreachable right now.", retryable = false });
            return;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "Streamed turn failed for agent '{Agent}'.", agent.Key);
            if (text.Length == 0)
            {
                await Tell("error", new { message = "The assistant is unreachable right now. Please try again.", retryable = true });
                return;
            }
            interrupted = true; // partial answer already delivered — keep it
        }

        var result = new AssistTurnResult(text.ToString(), AssistantOrigin.Agent, SessionId: sessionId);
        // Never on `ct`. This is the write that makes the turn exist at all — the member's own words
        // as much as the reply — and handing it the request's token meant a browser that had already
        // gone cancelled the save, so the thing that was said was kept nowhere. The comment in the
        // interruption handler above said the partial answer was kept; on that token, it was not.
        var (finalId, reply) = await PersistAsync(convo, agent, req, prompt, result, now, settings, CancellationToken.None);

        var outcome = Outcome(interrupted, end, finishReason);

        // Written down before it is sent. "When there is anyone left to show it to" is the whole
        // problem: the send below is best-effort, and the reader it is most likely to miss is a phone
        // whose network was frozen the moment its screen went off. This record is what that panel
        // comes back and asks for — see TurnState — so it has to exist whether or not the frame
        // beneath it ever leaves the building.
        _turnRegistry.Complete(turn.Id, new TurnOutcome(
            this.CallerId(), finalId, reply?.Id ?? 0, outcome, text.ToString(), reply?.Action));

        // Visible completion, when there is anyone left to show it to.
        await Tell("done", new
        {
            conversationId = finalId,
            messageId = reply?.Id ?? 0,
            origin = "Agent",
            finishReason = outcome,
        });

        // Name the chat, off this connection entirely — see ConversationTitler. Only an opening turn,
        // and only one that produced something to name: a chat whose first reply never arrived keeps
        // the household's own words, which is the more honest of the two things we could show.
        if (opening && finalId > 0 && text.Length > 0)
            _titler.Schedule(finalId, agent.Key, AssistTitle.From(prompt), prompt, text.ToString());

        // Repair, after the answer is on screen and while the lock is still held. Only when the turn
        // was interrupted: under in-place compaction an ordinary turn's session id does not change,
        // so reconciling every turn would be a round-trip that can never find anything.
        if (interrupted && sessionId is { Length: > 0 })
        {
            var effective = await _hermes.ResolveSessionAsync(agent.Key, sessionId, CancellationToken.None);
            if (effective is { Length: > 0 } && effective != sessionId && finalId > 0)
            {
                var row = await _db.Conversations.Include(c => c.SessionReferences)
                    .FirstOrDefaultAsync(c => c.Id == finalId, CancellationToken.None);
                if (row is not null)
                {
                    await RecordSessionAsync(row, agent.Key, effective, DateTime.UtcNow, CancellationToken.None);
                    await _db.SaveChangesAsync(CancellationToken.None);
                }
            }
        }
    }

    /// <summary>
    /// Stop a streamed turn — the Stop control under a reply that is still arriving.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Its own request rather than a hung-up connection, which is the entire point: those two things
    /// look identical to the server and mean opposite things to the household. See
    /// <see cref="TurnRegistry"/>. The id comes from the <c>open</c> frame at the head of the
    /// stream.
    /// </para>
    /// <para>
    /// 202 rather than 200, because that is what actually happened: HomeHub asks Hermes to stop, and
    /// Hermes notices on its next write while its tools stop cooperatively. Whatever had already been
    /// produced is still written to the ledger — a stopped reply is a short one, not a discarded one.
    /// </para>
    /// <para>
    /// 404 means no turn by that name is running, which almost always means it finished a moment
    /// before the tap landed. Nothing to apologise for, and nothing for the panel to show.
    /// </para>
    /// </remarks>
    [HttpPost("chat/turns/{turnId}/cancel")]
    public IActionResult CancelTurn(string turnId)
        => _turnRegistry.Cancel(turnId) ? Accepted() : NotFound();

    /// <summary>
    /// What became of a turn whose stream the panel lost.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>The endpoint that tells a dropped connection from a failed turn.</b> Everything else here
    /// is built on a turn outliving its stream — but the browser at the other end had no way to find
    /// that out, so it reported what it could see, which was a network failure, and handed the member
    /// their message back to send again. The turn had usually succeeded. Re-sending it asked the
    /// agent to do the same job twice, and the household's evidence that the panel was broken was a
    /// reply saying "I have already done this".
    /// </para>
    /// <para>
    /// A backgrounded phone is the ordinary case, not an exotic one: the operating system freezes a
    /// hidden tab's network within seconds of the screen going off, which kills the read while the
    /// server carries on writing. So the panel comes back, asks by name, and is told — running, or
    /// finished and here is where it landed.
    /// </para>
    /// <para>
    /// 404 covers three things deliberately: no such turn, a turn older than <see cref="TurnRegistry.Memory"/>,
    /// and a turn belonging to somebody else. The last is why this is not merely a lookup on an
    /// unguessable id — the record carries a reply, and "unguessable" is not the same claim as
    /// "checked". A panel that gets a 404 falls back to reading the stored transcript, which is the
    /// right thing to do in all three cases.
    /// </para>
    /// </remarks>
    [HttpGet("chat/turns/{turnId}")]
    public ActionResult<TurnStatusDto> TurnState(string turnId)
    {
        var status = _turnRegistry.Look(turnId, this.CallerId());
        if (status is null) return NotFound();
        if (status.Running) return new TurnStatusDto("running", 0, 0, null, null, null);

        var o = status.Outcome!;
        return new TurnStatusDto("done", o.ConversationId, o.MessageId, o.FinishReason, o.Text, o.Action);
    }

    /// <summary>
    /// Write the user turn and the reply, creating the conversation if this is the first turn.
    /// </summary>
    /// <remarks>
    /// Shared by the streaming and non-streaming paths so the ledger cannot diverge between them —
    /// two copies of "what a turn looks like once stored" is how a chat ends up rendering differently
    /// depending on which endpoint produced it.
    /// </remarks>
    /// <summary>
    /// What to tell the panel a streamed turn actually did.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>"Some text arrived" never means "the turn succeeded".</b> Reporting <c>stop</c> whenever
    /// no error was thrown is the easy version of this, and it is wrong in the case that matters: a
    /// gateway that dies mid-sentence still delivered sentences, and the panel would present a
    /// severed answer as a finished one. Nobody re-asks a question that looks answered.
    /// </para>
    /// <para>
    /// So <c>stop</c> has to be earned — the transport framed a complete turn (terminal chunk, then
    /// <c>[DONE]</c>) *and* the model said why it stopped. Everything else is named for what it was.
    /// </para>
    /// </remarks>
    private static string Outcome(bool interrupted, HermesStreamEnd? end, string? finishReason)
    {
        // The member pressed Stop. Their choice, and the most specific truth available.
        if (interrupted) return "interrupted";

        // The stream never framed a finished turn — no terminal chunk, or no [DONE] after it.
        if (end is not { Complete: true }) return "incomplete";

        // Hermes hit the token ceiling. A well-framed stream carrying a truncated answer: the
        // transport behaved, the reply is still cut off, and only the second half is the household's
        // problem.
        if (string.Equals(finishReason, "length", StringComparison.Ordinal)) return "length";

        return finishReason ?? "incomplete";
    }

    private async Task<(int ConversationId, ConversationMessage? Reply)> PersistAsync(
        Conversation? convo, Agent agent, AssistChatRequest req, string prompt,
        AssistTurnResult result, DateTime now, HouseholdSettings settings, CancellationToken ct)
    {
        if (!settings.StoreConversations) return (0, null);

        // A turn that never reached an agent is not a turn. Persisting the canned line would put
        // words in the agent's mouth and leave a permanent record of a transient outage — and the
        // member's own message would sit above it, unanswered, forever. The panel says what happened
        // in a banner instead, which is transient like the failure.
        if (result.Failure is not null) return (convo?.Id ?? 0, null);

        if (convo is null)
        {
            convo = new Conversation
            {
                ProfileId = this.CallerId(),
                AgentKey = agent.Key,
                Title = AssistTitle.From(prompt),
                StartedAtUtc = now,
                LastAtUtc = now,
                ReadAtUtc = now,
            };
            _db.Conversations.Add(convo);
        }

        if (result.SessionId is { Length: > 0 } sid) await RecordSessionAsync(convo, agent.Key, sid, now, ct);

        var attachment = Attachment.Read(req);

        _db.ConversationMessages.Add(new ConversationMessage
        {
            Conversation = convo,
            Role = "user",
            // A turn can be an attachment and nothing else — handing over a photo with no question is
            // a perfectly ordinary thing to do. The placeholder is only for the case where there is
            // also nothing attached to name, which the endpoint rejects before this is reached.
            Text = prompt.Length > 0 ? prompt : attachment is null ? "[Image]" : "",
            AtUtc = now,
            AttachmentName = attachment?.Name,
            AttachmentKind = attachment?.Kind,
            AttachmentBytes = attachment?.Bytes,
        });

        var reply = new ConversationMessage
        {
            Conversation = convo,
            Role = "assistant",
            Text = result.Text,
            AtUtc = now.AddMilliseconds(1),
            Origin = result.Origin.ToString(),
            Action = result.Action,
        };
        _db.ConversationMessages.Add(reply);

        convo.LastAtUtc = reply.AtUtc;
        convo.ReadAtUtc = reply.AtUtc;
        convo.ArchivedAtUtc = null;

        await _db.SaveChangesAsync(ct);
        return (convo.Id, reply);
    }

    /// <summary>
    /// One turn, awaited whole.
    /// </summary>
    /// <remarks>
    /// The streaming endpoint above is what the chat screen uses. This remains for the callers with
    /// nothing to stream *to*: a spoken turn, whose reply goes to text-to-speech in one piece, and the
    /// inbox composer, which has no transcript on screen to grow.
    /// </remarks>
    [EnableRateLimiting(RateLimits.AssistTurn)]
    [HttpPost("chat")]
    public async Task<ActionResult<AssistChatResponse>> Chat(AssistChatRequest req, CancellationToken ct)
    {
        var prompt = (req.Prompt ?? "").Trim();
        if (IsEmptyTurn(req, prompt))
            return BadRequest("A message, a picture or a file is required.");
        if (IsOversized(req))
            return BadRequest($"A picture is limited to {AssistFieldLimits.MaxImageBytes / (1024 * 1024)} MB.");
        if (prompt.Length > AssistFieldLimits.MaxPromptChars)
            return BadRequest($"A turn is limited to {AssistFieldLimits.MaxPromptChars} characters.");

        var settings = await GetSettings(ct);
        var now = DateTime.UtcNow;

        // Load the chat first: the agent path needs its Hermes session id, and a bad id should fail
        // before a model is spoken to rather than after.
        Conversation? convo = null;
        if (req.ConversationId is { } cid)
        {
            convo = await _db.Conversations.FirstOrDefaultAsync(c => c.Id == cid, ct);
            if (convo is null || !Owns(convo))
                return NotFound("That conversation no longer exists.");
        }

        // Remembered before the chat is opened below — see the streamed path for why.
        var opening = convo is null;

        // ---- Which agent answers ----
        //
        // An existing conversation's own AgentKey wins outright; `req.AgentKey` is consulted only when
        // opening a new chat.
        //
        // This is not a preference. A conversation holds a Hermes session id, and Hermes profiles are
        // isolated — Barnaby's state.db cannot see Geist's. Honouring a request that named a different
        // agent would send a Barnaby session to `/p/geist`, which is not a permissions mistake but a
        // reference into a database that does not contain it. Reachable from the panel, too: switch
        // agents in the inbox with a chat screen still mounted.
        Agent agent;
        if (convo is not null)
        {
            agent = _roster.Resolve(convo.AgentKey);
            // Access can be revoked while a chat is open. Reading stays allowed — revoking removes
            // access, not history — but a new turn to an agent this member no longer has is refused.
            if (!await _access.CanUseAsync(convo.ProfileId, convo.AgentKey, ct))
                return StatusCode(StatusCodes.Status403Forbidden,
                    $"This conversation belongs to an agent {(convo.ProfileId is null ? "this panel" : "you")} can no longer use.");
        }
        else
        {
            // A browser may name an agent; it may never name an address. An unknown key is refused
            // outright here rather than silently resolved, because on a *new* chat the key decides
            // which gateway the conversation is bound to for the rest of its life.
            if (req.AgentKey is { Length: > 0 } requested && !_roster.Knows(requested))
                return BadRequest($"'{requested}' is not an agent on this panel.");

            agent = await _access.ResolveForAsync(this.CallerId(), req.AgentKey, ct);
        }

        // Serialise on the conversation, not on its Hermes session id — the session id is the thing
        // that changes when Hermes compresses, which is precisely what this guards (ConversationLocks).
        // A brand-new chat has no id yet and nothing to contend with.
        using var gate = convo is null
            ? null
            : await _locks.AcquireAsync(convo.Id, ct);

        // Actions-first: a recognised command ("add carrots to the grocery list") is executed directly
        // — deterministic, instant, and working with every agent offline. It never reaches Hermes,
        // which is what stops the same imperative being carried out twice: the house did the thing,
        // not the agent.
        var result = await _turns.TryActionAsync(
            string.IsNullOrEmpty(req.ImageBase64) ? prompt : "", this.CallerId(), ct);

        if (result is null)
        {
            // No transcript is sent. With a session id present Hermes loads history from its own
            // profile-local state.db, so replaying HomeHub's ledger would duplicate every prior turn
            // into the agent's context.
            var sessionId = convo?.HermesSessionId
                ?? await _hermes.CreateSessionAsync(agent.Key, AssistTitle.From(prompt), ct);

            var content = BuildContent(req, prompt);
            result = await _turns.AskAsync(agent.Key, sessionId, content, ct);
        }

        // Storing off means the chat in front of you is all there is: answer, persist nothing, and
        // hand back id 0 so the client knows not to try to reopen it.
        if (!settings.StoreConversations)
        {
            return new AssistChatResponse(
                0, AssistTitle.From(prompt),
                new MessageDto(0, "assistant", result.Text, now, result.Origin.ToString(), false, result.Action),
                result.Origin.ToString(), false, null);
        }

        if (convo is null)
        {
            convo = new Conversation
            {
                ProfileId = this.CallerId(),
                AgentKey = agent.Key,
                Title = AssistTitle.From(prompt),
                StartedAtUtc = now,
                LastAtUtc = now,
                // The member is looking at the chat they just started, so it is read by construction.
                ReadAtUtc = now,
            };
            _db.Conversations.Add(convo);
        }

        // Record the session Hermes actually answered in — see RecordSessionAsync. Deliberately part
        // of the same SaveChanges as the messages below: a reply persisted without its session having
        // been recorded is how a lineage ID goes missing.
        if (result.SessionId is { Length: > 0 } sid) await RecordSessionAsync(convo, agent.Key, sid, now, ct);

        var userText = prompt.Length > 0 ? prompt : "[Image]";
        _db.ConversationMessages.Add(new ConversationMessage
        {
            Conversation = convo, Role = "user", Text = userText, AtUtc = now,
        });

        var replyRow = new ConversationMessage
        {
            Conversation = convo,
            Role = "assistant",
            Text = result.Text,
            // A tick later than the user turn so the transcript's time ordering is total rather than
            // dependent on insertion order for two rows written in the same instant.
            AtUtc = now.AddMilliseconds(1),
            Origin = result.Origin.ToString(),
            Action = result.Action,
        };
        _db.ConversationMessages.Add(replyRow);

        convo.LastAtUtc = replyRow.AtUtc;
        // Written from this device, by this member, who is watching it arrive.
        convo.ReadAtUtc = replyRow.AtUtc;
        // A reply into an archived chat brings it back: the household re-engaged with it, and leaving
        // it in the archive would hide a conversation that is currently happening.
        convo.ArchivedAtUtc = null;

        await _db.SaveChangesAsync(ct);

        // Same naming pass as the streamed path, and the same two conditions: an opening turn, and one
        // an agent actually answered. A turn the *house* answered deliberately never reaches Hermes
        // (`AssistTurnService.TryActionAsync`), and sending it away to be named would undo that in the
        // one place nobody would think to look.
        if (opening && result.Origin == AssistantOrigin.Agent)
            _titler.Schedule(convo.Id, agent.Key, AssistTitle.From(prompt), prompt, result.Text);

        return new AssistChatResponse(
            convo.Id, convo.Title, ToDto(replyRow), result.Origin.ToString(), false, null);
    }

    /// <summary>Pin (swipe right), archive (swipe left), mark read, or rename. Absent fields are left alone.</summary>
    /// <remarks>
    /// <b>Renaming is a person overruling a machine</b>, so it is the one field here that can be got
    /// wrong: a title is generated from the opening turn and then, moments later, replaced by one the
    /// agent suggested (<see cref="ConversationTitler"/>). Whatever arrives here wins outright and
    /// permanently — the titler only ever writes over the *provisional* title, so a rename can never
    /// be undone by a naming call that was already in flight when it landed.
    /// <para>
    /// An all-whitespace title is refused rather than accepted-and-ignored: a row with no name is not
    /// a state the list can draw, and silently keeping the old one would look like the rename failed
    /// to save.
    /// </para>
    /// </remarks>
    [HttpPatch("conversations/{id:int}")]
    public async Task<ActionResult<ConversationDto>> Update(int id, UpdateConversationRequest req, CancellationToken ct)
    {
        var convo = await _db.Conversations.Include(c => c.Messages).FirstOrDefaultAsync(c => c.Id == id, ct);
        // Renaming, pinning and archiving somebody else's chat is not as bad as reading it, but it
        // is the same missing check — so it is the same answer. See Detail.
        if (convo is null || !Owns(convo)) return NotFound();

        if (req.Title is { } title)
        {
            if (string.IsNullOrWhiteSpace(title)) return BadRequest("A chat needs a name.");
            // Through the same collapse-and-trim as every other title, so a name typed with a stray
            // newline in it is stored the way the row will draw it.
            convo.Title = AssistTitle.From(title);
        }

        if (req.Pinned is { } pinned) convo.Pinned = pinned;
        if (req.Archived is { } archived) convo.ArchivedAtUtc = archived ? DateTime.UtcNow : null;
        if (req.Read is { } read) convo.ReadAtUtc = read ? DateTime.UtcNow : null;

        await _db.SaveChangesAsync(ct);

        var speaker = await SpeakerNameAsync(convo.ProfileId, ct);
        return ToDto(convo, speaker, _roster.Resolve(convo.AgentKey).Name);
    }

    /// <summary>
    /// Delete conversations outright — the multi-select path, the only destructive action in Assist.
    /// </summary>
    /// <remarks>
    /// Deletes the household's rows <b>and</b> the agent's session transcripts, in that order. The
    /// Hermes call is best-effort: a person must be able to delete their own conversation while the
    /// agent is down, and the count of transcripts actually removed comes back so a gap between the
    /// promise and the outcome is visible rather than assumed away.
    /// </remarks>
    [HttpPost("conversations/delete")]
    public async Task<ActionResult<DeleteConversationsResponse>> Delete(DeleteConversationsRequest req, CancellationToken ct)
    {
        var ids = (req.Ids ?? []).Distinct().ToList();
        if (ids.Count == 0) return new DeleteConversationsResponse(0, 0);

        /*
         * Refused until this database's lineage has been audited — see `LineageReport`.
         *
         * The tombstones written below cover every session HomeHub knows about, and on a database that
         * predates lineage recording that is not every session there is. Deleting the local row
         * destroys the anchor, so an intermediate transcript nobody enumerated stays on the agent
         * permanently while this endpoint reports success. Refusing is the fail-closed answer and it is
         * not a dead end: the report is one request away and releases this for good.
         */
        /*
         * Clean, or a single acceptance that names exactly these conversations.
         *
         * The previous version read one enum: the household sat in a `RiskAccepted` state and every
         * later deletion was authorised by an acceptance granted once, against a report that may have
         * described a different set of conversations and a different set of damage. An acceptance
         * authorises a deletion now, and is spent by it.
         */
        var household = await GetSettings(ct);
        LineageRiskAcceptance? acceptance = null;
        if (household.LineageState != LineageState.Clean)
        {
            var authorisation = await AuthorisedByAcceptanceAsync(ids, ct);
            if (authorisation.Refusal is { } refusal) return Conflict(refusal);
            acceptance = authorisation.Acceptance;
        }

        var callerId = this.CallerId();
        var rows = await _db.Conversations
            // Scoped to the caller (AUDIT A1.2). Filtered rather than refused: a batch containing an
            // id that is not the caller's deletes the ones that are and silently skips the rest,
            // which is both the safe behaviour and the one that does not confirm the other ids exist.
            .Where(c => ids.Contains(c.Id) && c.ProfileId == callerId)
            .Include(c => c.SessionReferences)
            .ToListAsync(ct);
        if (rows.Count == 0) return new DeleteConversationsResponse(0, 0);

        // Snapshot every session in every lineage BEFORE deleting anything, and write the promise to
        // delete them down as a durable row.
        //
        // Two reasons the obvious version is wrong. One conversation can span several Hermes sessions
        // — compression ends one and starts a child, and both keep their messages — so deleting only
        // the current id leaves most of a long conversation behind. And if the agent is unreachable
        // while we remove our own row, the session ids vanish with it: the transcripts are orphaned
        // forever and nothing is left that knows to retry.
        var now = DateTime.UtcNow;
        foreach (var row in rows)
        {
            var lineage = row.SessionReferences
                .Select(s => s.SessionId)
                .Concat(row.HermesSessionId is { Length: > 0 } cur ? [cur] : Array.Empty<string>())
                .Distinct(StringComparer.Ordinal);

            foreach (var sessionId in lineage)
            {
                _db.HermesSessionDeletions.Add(new HermesSessionDeletion
                {
                    ConversationId = row.Id,
                    // The profile travels with the id. A Barnaby session means nothing to Geist's
                    // database, so this is the only endpoint it may ever be sent to.
                    AgentKey = row.AgentKey,
                    SessionId = sessionId,
                    RequestedAtUtc = now,
                });
            }
        }

        // Messages and lineage references go with the conversations by cascade — see HomeHubDbContext,
        // where that cascade is a privacy guarantee rather than a convenience. The tombstones do not
        // cascade, which is the entire point of them.
        _db.Conversations.RemoveRange(rows);
        await _db.SaveChangesAsync(ct);

        if (acceptance is not null)
        {
            // Spent, in the same save as the deletion it authorised. An acceptance that survived the
            // act it permitted would be the durable authority this replaced.
            acceptance.ConsumedAtUtc = DateTime.UtcNow;
            await _db.SaveChangesAsync(ct);
        }

        // Try immediately so the ordinary case — agent up, one or two sessions — is finished by the
        // time the response lands. Whatever does not succeed is already queued and will be retried.
        var removed = await _deletions.DrainAsync(ct);

        return new DeleteConversationsResponse(rows.Count, removed);
    }

    // ---- Search ----

    /// <summary>
    /// Full-transcript search across this member's chats with the current agent, active and archived.
    /// </summary>
    /// <remarks>
    /// Matched here, on the home server, and never in the cloud — that is the promise the design makes
    /// and the reason this is not an assistant call. Results are per <b>match</b>, not per chat: a
    /// conversation mentioning the term three times is three rows, because the useful answer is the
    /// line, not the chat it happened to be in.
    /// </remarks>
    [HttpGet("search")]
    public async Task<SearchResultsDto> Search(string? agent, string? q, CancellationToken ct)
    {
        var profileId = this.CallerId();
        var term = (q ?? "").Trim();
        if (term.Length < AssistFieldLimits.MinSearchChars) return new SearchResultsDto([], 0, 0);

        var agentKey = (await _access.ResolveForAsync(profileId, agent, ct)).Key;

        // EF.Functions.Like keeps the match in SQL Server rather than pulling every transcript the
        // household has ever had into memory to scan it. The escape covers the wildcards a person can
        // actually type — a title with a % in it must not match everything.
        var pattern = "%" + term.Replace("[", "[[]").Replace("%", "[%]").Replace("_", "[_]") + "%";

        var matches = await (
            from m in _db.ConversationMessages
            join c in _db.Conversations on m.ConversationId equals c.Id
            where c.ProfileId == profileId && c.AgentKey == agentKey && EF.Functions.Like(m.Text, pattern)
            orderby m.AtUtc descending
            select new { m.Text, m.AtUtc, c.Id, c.Title, c.ArchivedAtUtc })
            .Take(200)
            .ToListAsync(ct);

        var hits = matches
            .Select(x =>
            {
                var (snippet, start) = Snippet(x.Text, term);
                return new SearchHitDto(x.Id, x.Title, x.AtUtc, x.ArchivedAtUtc != null, snippet, start, term.Length);
            })
            .ToList();

        return new SearchResultsDto(hits, hits.Count, hits.Select(h => h.ConversationId).Distinct().Count());
    }

    /// <summary>
    /// A window of the matching line around the term, with ellipses — the design's
    /// `…confirmed the piano tuner for Friday 1 PM…`.
    /// </summary>
    /// <remarks>
    /// Returns the offset of the term within the snippet as well as the text, so the client can draw
    /// the brass highlight without re-searching a string that may contain the term more than once and
    /// highlighting the wrong one.
    /// </remarks>
    internal static (string Snippet, int MatchStart) Snippet(string text, string term, int window = 44)
    {
        var flat = text.Replace('\r', ' ').Replace('\n', ' ');
        var at = flat.IndexOf(term, StringComparison.OrdinalIgnoreCase);
        if (at < 0) return (flat.Length <= window * 2 ? flat : flat[..(window * 2)] + "…", 0);

        var from = Math.Max(0, at - window);
        var to = Math.Min(flat.Length, at + term.Length + window);
        var body = flat[from..to];

        var prefix = from > 0 ? "…" : "";
        var suffix = to < flat.Length ? "…" : "";
        return (prefix + body + suffix, at - from + prefix.Length);
    }

    // ---- Internals ----

    /// <summary>
    /// Record the Hermes session a turn ran in, accumulating lineage rather than overwriting.
    /// </summary>
    /// <remarks>
    /// Hermes compresses a conversation by ending its session and starting a <b>child</b>; the parent
    /// row and its messages survive. So a rotation is not "the id changed" — it is "there is now one
    /// more session holding part of this conversation", and both have to be deletable later.
    /// <para>
    /// Called on every turn, including the overwhelmingly common one where the id is unchanged: the
    /// unique index makes a repeat a no-op, and the alternative — only recording when it *looks*
    /// different — is how the first compression goes unnoticed.
    /// </para>
    /// <para>
    /// Staged into the caller's transaction, not saved here. The lock is held until that commit, so
    /// no other turn can observe a half-updated lineage.
    /// </para>
    /// </remarks>
    private async Task RecordSessionAsync(
        Conversation convo, string agentKey, string sessionId, DateTime now, CancellationToken ct)
    {
        if (string.Equals(convo.HermesSessionId, sessionId, StringComparison.Ordinal)
            && convo.Id != 0
            && await _db.HermesSessionReferences.AnyAsync(
                r => r.ConversationId == convo.Id && r.SessionId == sessionId, ct))
        {
            return; // already current and already recorded — the ordinary case
        }

        // Everything previously current stops being so; the row itself stays, because it still holds
        // a transcript somebody may later have to delete.
        var known = convo.Id == 0
            ? []
            : await _db.HermesSessionReferences.Where(r => r.ConversationId == convo.Id).ToListAsync(ct);
        foreach (var row in known.Where(r => r.IsCurrent)) row.IsCurrent = false;
        foreach (var row in convo.SessionReferences.Where(r => r.IsCurrent)) row.IsCurrent = false;

        var already = known.FirstOrDefault(r => r.SessionId == sessionId)
            ?? convo.SessionReferences.FirstOrDefault(r => r.SessionId == sessionId);

        if (already is not null)
        {
            already.IsCurrent = true;
        }
        else
        {
            convo.SessionReferences.Add(new HermesSessionReference
            {
                Conversation = convo,
                AgentKey = agentKey,
                SessionId = sessionId,
                DiscoveredAtUtc = now,
                IsCurrent = true,
            });
        }

        convo.HermesSessionId = sessionId;
    }

    /// <summary>
    /// The turn's content: text, plus an inline image when one was attached.
    /// </summary>
    /// <remarks>
    /// The image is submitted to the chosen agent as a data URL and nothing else is named — no
    /// vision-capable model, no route, no provider. Whether that agent can see it is Hermes's
    /// configuration to get right; a model choice smuggled in here would be the same boundary
    /// violation as any other.
    /// </remarks>
    private static IReadOnlyList<HermesContent> BuildContent(AssistChatRequest req, string prompt)
    {
        var parts = new List<HermesContent>();
        if (prompt.Length > 0) parts.Add(new HermesContent(prompt));

        var attachment = Attachment.Read(req);

        if (!string.IsNullOrEmpty(req.ImageBase64))
        {
            var mime = string.IsNullOrWhiteSpace(req.ImageMediaType) ? "image/jpeg" : req.ImageMediaType;
            parts.Add(new HermesContent(null, $"data:{mime};base64,{req.ImageBase64}"));
        }

        // A text file, as its own part with its name on it.
        //
        // Named and fenced rather than run together with the member's own words, because the agent has
        // to be able to tell "what I was asked" from "what I was handed" — a CSV pasted nameless into
        // the end of a question reads as part of the question. The fence is the ordinary convention
        // for that and costs nothing.
        if (attachment is { Kind: AttachmentKinds.Text, Text: { Length: > 0 } fileText })
            parts.Add(new HermesContent($"Attached file — {attachment.Name}:\n\n```\n{fileText}\n```"));

        // A turn with none of the above is rejected before this is reached; the empty part keeps the
        // request well-formed rather than relying on that.
        if (parts.Count == 0) parts.Add(new HermesContent(""));
        return parts;
    }

    /// <summary>
    /// Whether this turn carries anything at all — words, a picture, or a file.
    /// </summary>
    /// <remarks>
    /// The guard on both turn endpoints. It used to be "a prompt or an image", which quietly made a
    /// text file with no accompanying question a 400 — and handing over a shopping list without typing
    /// anything about it is exactly as reasonable as handing over a photo without typing anything.
    /// </remarks>
    private static bool IsEmptyTurn(AssistChatRequest req, string prompt) =>
        prompt.Length == 0
        && string.IsNullOrEmpty(req.ImageBase64)
        && Attachment.Read(req) is null;

    /// <summary>
    /// Whether the request's attachment is larger than this panel will carry.
    /// </summary>
    /// <remarks>
    /// Checked against the decoded length rather than the base64 string, so the number in
    /// <see cref="AssistFieldLimits.MaxImageBytes"/> means what it says on a file listing. Text is
    /// truncated rather than rejected (<see cref="Attachment.Read"/>) because losing the tail of a log
    /// file still answers most questions about it; an image cannot be usefully truncated, so the only
    /// honest answer for an oversized one is to say so.
    /// </remarks>
    private static bool IsOversized(AssistChatRequest req) =>
        req.ImageBase64 is { Length: > 0 } b64
        && (long)(b64.Length * 3L / 4L) > AssistFieldLimits.MaxImageBytes;

    /// <summary>
    /// Whether this conversation belongs to the caller.
    /// </summary>
    /// <remarks>
    /// A null <c>ProfileId</c> is the shared/guest panel's own conversations, and matches a caller
    /// with no profile — which after A1 means a service token, since anonymous callers no longer
    /// reach this controller at all. That keeps the pre-existing guest behaviour intact rather than
    /// orphaning rows written before anyone signed in.
    /// </remarks>
    private bool Owns(Conversation convo) => convo.ProfileId == this.CallerId();

    private IQueryable<Conversation> Scope(int? profileId, string agentKey) =>
        _db.Conversations.Where(c => c.ProfileId == profileId && c.AgentKey == agentKey);

    private async Task<HouseholdSettings> GetSettings(CancellationToken ct) =>
        await _db.Settings.AsNoTracking().FirstOrDefaultAsync(s => s.Id == 1, ct) ?? new HouseholdSettings();

    /// <summary>
    /// Apply the household's retention to <b>this member's</b> conversations.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Scoped to the caller, which it was not.</b> This deleted every expired conversation in the
    /// household, so one member opening Assist destroyed another member's chats — the boundary AUDIT
    /// A1.2 exists to hold, crossed by a side effect of a read. It also removed the rows and their
    /// lineage without recording anything about the Hermes transcripts behind them, so the agent kept
    /// what the panel had just promised to forget.
    /// </para>
    /// <para>
    /// Both are fixed in <see cref="AssistRetention"/>, which also runs household-wide in the
    /// background — a member who stops opening Assist still has their old chats forgotten on
    /// schedule, which scoping this read would otherwise have quietly prevented.
    /// </para>
    /// </remarks>
    private Task SweepAsync(int? profileId, HouseholdSettings settings, CancellationToken ct) =>
        _retention.SweepForAsync(settings, profileId, ct);

    /// <summary>
    /// The agents this member may switch between, with their unread counts.
    /// </summary>
    /// <remarks>
    /// Scoped to what they have been assigned, which is what makes the design's header rule fall out
    /// of the data rather than being a second decision in the client: one agent → the name alone, no
    /// chevron, no tap target; two or more → the switcher.
    /// <para>
    /// <c>IsDefault</c> is <b>this member's</b> default, resolved — see <see cref="AgentDto"/>. That is
    /// what makes the per-member choice work with no client change: the panel already lands on the
    /// agent this flag marks when it has nothing remembered.
    /// </para>
    /// </remarks>
    private async Task<IReadOnlyList<AgentDto>> RosterAsync(int? profileId, CancellationToken ct)
    {
        var mine = await _access.ForAsync(profileId, ct);
        var opensOn = await _access.DefaultForAsync(profileId, ct);

        // One grouped query rather than one per agent: the roster is small, but this runs on every
        // list read and the panel polls.
        var unread = await _db.Conversations
            .Where(c => c.ProfileId == profileId && c.ArchivedAtUtc == null
                && (c.ReadAtUtc == null || c.LastAtUtc > c.ReadAtUtc))
            .GroupBy(c => c.AgentKey)
            .Select(g => new { AgentKey = g.Key, Count = g.Count() })
            .ToListAsync(ct);

        var byKey = unread.ToDictionary(x => x.AgentKey, x => x.Count, StringComparer.OrdinalIgnoreCase);

        return [.. mine.Select(a => new AgentDto(
            a.Key, a.Name, a.Tagline,
            string.Equals(a.Key, opensOn.Key, StringComparison.OrdinalIgnoreCase), a.IsConfigured,
            byKey.TryGetValue(a.Key, out var n) ? n : 0))];
    }

    /// <summary>The member's display name, for the row's `You — …` / `Barnaby — …` prefix.</summary>
    private async Task<string> SpeakerNameAsync(int? profileId, CancellationToken ct)
    {
        if (profileId is not { } id) return "You";
        var name = await _db.Profiles.Where(p => p.Id == id).Select(p => p.Name).FirstOrDefaultAsync(ct);
        return string.IsNullOrWhiteSpace(name) ? "You" : name;
    }

    private static ConversationDto ToDto(Conversation c, string memberName, string agentName)
    {
        var last = c.Messages.Count == 0
            ? null
            : c.Messages.OrderByDescending(m => m.AtUtc).ThenByDescending(m => m.Id).First();

        var unreadCount = c.Messages.Count(m => c.ReadAtUtc == null || m.AtUtc > c.ReadAtUtc);

        return new ConversationDto(
            c.Id,
            c.AgentKey,
            c.Title,
            last is null ? "" : last.Role == "user" ? memberName : agentName,
            last?.Text.Replace('\n', ' ').Trim() ?? "",
            c.StartedAtUtc,
            c.LastAtUtc,
            c.Pinned,
            c.ArchivedAtUtc,
            c.ReadAtUtc is null || c.LastAtUtc > c.ReadAtUtc,
            unreadCount,
            c.Messages.Count);
    }

    private static MessageDto ToDto(ConversationMessage m) =>
        new(m.Id, m.Role, m.Text, m.AtUtc, m.Origin, m.Escalated, m.Action,
            m.AttachmentName, m.AttachmentKind, m.AttachmentBytes);
}
