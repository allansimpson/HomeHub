namespace HomeHub.Api.Assist;

using HomeHub.Api.Ai;
using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// The §3.1 lineage repair report — **read-only, always**.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why this exists.</b> The lineage table works prospectively: each turn observes
/// <c>old id → resolved id</c> and accumulates both. That cannot rebuild a lineage that already
/// existed. A conversation that became <c>A → B → C</c> while HomeHub stored only <c>A</c> resolves
/// to <c>C</c> — revealing A and C, and **never B**. Delete those two and B stays on the server with
/// its messages while the tombstone reports success. That is the delete modal telling the household
/// something untrue, which is the failure this report is a precondition for fixing.
/// </para>
/// <para>
/// <b>It writes nothing.</b> Not the lineage table, not Hermes, not retention records. The backfill
/// this report is named after is a *later* step, gated on this coming back clean — because a repair
/// that runs before anyone has read the damage is just a second, faster way to lose rows. Every read
/// here is <see cref="EntityFrameworkQueryableExtensions.AsNoTracking{T}"/> and there is no
/// <c>SaveChanges</c> in the file; <c>LineageAuditTests.The_report_writes_nothing</c> holds it to
/// that by comparing full row values — not counts — either side of two runs, against the damaged
/// shapes a premature repair would be most tempted to tidy.
/// </para>
/// <para>
/// <b>It swallows nothing.</b> Every session on every configured agent gets a class, including the
/// ones HomeHub does not own and the ones that make no sense. A report that quietly dropped the rows
/// it could not explain would be clean by construction.
/// </para>
/// </remarks>
public sealed class LineageAudit
{
    private readonly HomeHubDbContext _db;
    private readonly HermesClient _hermes;
    private readonly AgentRoster _roster;
    private readonly ILogger<LineageAudit> _logger;

    /// <summary>Rows per request. Matches the §3.1 enumeration.</summary>
    private const int PageSize = 200;

    /// <summary>
    /// A stop, not a limit. Paging until a short page is the documented approach, and this is the
    /// backstop for a gateway that answers every offset with a full page — an infinite loop inside a
    /// repair tool would be a poor way to discover a pagination bug.
    /// </summary>
    private const int MaxPages = 100;

    public LineageAudit(HomeHubDbContext db, HermesClient hermes, AgentRoster roster, ILogger<LineageAudit> logger)
    {
        _db = db;
        _hermes = hermes;
        _roster = roster;
        _logger = logger;
    }

    public async Task<LineageReport> RunAsync(CancellationToken ct)
    {
        var agents = new List<AgentLineageReport>();

        foreach (var agent in _roster.All)
        {
            if (!_hermes.IsConfigured(agent.Key))
            {
                // Not a failure and not a pass. An agent with no gateway has no sessions to leave
                // behind, but it also cannot vouch for any — so it is reported and excluded.
                agents.Add(AgentLineageReport.NotConfigured(agent.Key));
                continue;
            }
            agents.Add(await AuditAgentAsync(agent.Key, ct));
        }

        var blocking = agents.SelectMany(a => a.BlockingReasons).ToList();
        var clean = blocking.Count == 0 && agents.Any(a => a.Reachable);

        _logger.LogInformation(
            "Lineage report: {Agents} agent(s), {Sessions} session(s), clean={Clean}, {Blocking} blocking reason(s).",
            agents.Count, agents.Sum(a => a.SessionsSeen), clean, blocking.Count);

        return new LineageReport(DateTime.UtcNow, clean, blocking, agents, PermittedDeleteCopy(clean));
    }

    // ---- One agent ----

    private async Task<AgentLineageReport> AuditAgentAsync(string agentKey, CancellationToken ct)
    {
        var (sessions, error, pages, truncated) = await EnumerateAsync(agentKey, ct);
        if (error is not null) return AgentLineageReport.Unreachable(agentKey, error);

        var byId = sessions.ToDictionary(s => s.Id, StringComparer.Ordinal);

        var conversations = await _db.Conversations
            .AsNoTracking()
            .Where(c => c.AgentKey == agentKey)
            .Select(c => new { c.Id, c.HermesSessionId })
            .ToListAsync(ct);

        var references = await _db.HermesSessionReferences
            .AsNoTracking()
            .Where(r => r.AgentKey == agentKey)
            .Select(r => new { r.ConversationId, r.SessionId, r.IsCurrent })
            .ToListAsync(ct);

        var findings = new List<LineageFinding>();
        var primary = new Dictionary<string, LineageClass>(StringComparer.Ordinal);

        // --- 1. Ownership. A session we did not create is not ours to reason about or delete. ---
        var ours = new List<HermesSessionSummary>();
        foreach (var s in sessions)
        {
            if (IsApiCreated(s.Source)) ours.Add(s);
            else primary[s.Id] = LineageClass.NonHomeHubSource;
        }

        // --- 2. Walk each owned session to its root, noticing what goes wrong on the way. ---
        var rootOf = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var s in ours)
        {
            var walk = WalkToRoot(s, byId);
            switch (walk.Outcome)
            {
                case WalkOutcome.Cycle:
                    Note(findings, primary, LineageClass.Cycle, s.Id, null,
                        $"parent chain loops back on itself at '{walk.StoppedAt}'; no root exists to anchor this lineage");
                    break;

                case WalkOutcome.MissingParent:
                    Note(findings, primary, LineageClass.BrokenParentChain, s.Id, null,
                        $"parent '{walk.StoppedAt}' is not on this agent — orphaned by an earlier delete, or it was never here. "
                      + "The rest of the chain above it cannot be reconstructed.");
                    break;

                case WalkOutcome.ForeignAncestor:
                    Note(findings, primary, LineageClass.ForeignAncestor, s.Id, null,
                        $"ancestor '{walk.StoppedAt}' has source '{walk.StoppedSource ?? "(none)"}', not homehub — "
                      + "this lineage leaves what HomeHub owns, so deleting all of it would reach somebody else's session");
                    break;

                case WalkOutcome.Ok:
                    rootOf[s.Id] = walk.Root!;
                    break;
            }
        }

        // --- 3. Branching. A compression chain is linear; anything else is a fork or a delegate. ---
        var childrenOf = ours
            .Where(s => s.ParentSessionId is not null && byId.ContainsKey(s.ParentSessionId))
            .GroupBy(s => s.ParentSessionId!, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.ToList(), StringComparer.Ordinal);

        foreach (var (parentId, kids) in childrenOf)
        {
            var parent = byId[parentId];
            var compressed = string.Equals(parent.EndReason, "compression", StringComparison.OrdinalIgnoreCase);

            if (kids.Count > 1)
                // Two children of one parent cannot both be a compression rotation, whatever the end
                // reason says. This is a branch, and §3's "safe today" assumption — that HomeHub does
                // not fork — has stopped holding.
                foreach (var kid in kids)
                    Note(findings, primary, LineageClass.UnexpectedBranchOrFork, kid.Id, null,
                        $"parent '{parentId}' has {kids.Count} children, so this is a branch rather than a rotation");
            else if (!compressed)
                // A single child of a parent that did not end in compression: a fork, or a delegate
                // subagent. **The documented projection cannot tell those apart** — there is no kind
                // field — and they need opposite handling (a delegate is cascade-deleted with its
                // parent; a fork is a deliberate branch that must not be). So it is reported with the
                // end reason attached, for a person to judge, rather than guessed at.
                Note(findings, primary, LineageClass.UnexpectedBranchOrFork, kids[0].Id, null,
                    $"parent '{parentId}' ended as '{parent.EndReason ?? "(still open)"}', not compression — "
                  + "fork or delegate child; the session index cannot distinguish them");
        }

        var legacyCompressionChildren = ours.Count(s =>
            s.ParentSessionId is { } p && byId.TryGetValue(p, out var par)
            && string.Equals(par.EndReason, "compression", StringComparison.OrdinalIgnoreCase)
            && childrenOf.TryGetValue(p, out var sibs) && sibs.Count == 1);

        // --- 4. Map lineages to conversations. ---
        var lineages = rootOf.GroupBy(kv => kv.Value, kv => kv.Key, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.ToList(), StringComparer.Ordinal);

        // Both anchors count: the conversation's current id, and every reference it already holds.
        var claimants = new Dictionary<string, HashSet<int>>(StringComparer.Ordinal);
        foreach (var c in conversations.Where(c => c.HermesSessionId is not null))
            Claim(claimants, c.HermesSessionId!, c.Id);
        foreach (var r in references)
            Claim(claimants, r.SessionId, r.ConversationId);

        var rootsOfConversation = new Dictionary<int, HashSet<string>>();

        foreach (var (root, members) in lineages)
        {
            var owners = members
                .SelectMany(id => claimants.TryGetValue(id, out var set) ? set : [])
                .ToHashSet();

            foreach (var owner in owners)
            {
                if (!rootsOfConversation.TryGetValue(owner, out var set))
                    rootsOfConversation[owner] = set = [];
                set.Add(root);
            }

            if (owners.Count == 0)
            {
                // Unclaimed splits two ways, and conflating them is what made this report useless.
                // A namespaced id proves HomeHub created it — that is an orphan of ours, and a real
                // retention gap. A generic `api-…` id proves nothing: it predates namespacing and is
                // indistinguishable from any other API client's session. Both block; only one is
                // ours to fix, and saying so is the difference between a work item and a mystery.
                foreach (var id in members)
                    if (HomeHubSessionId.IsOurs(id))
                        Note(findings, primary, LineageClass.UnmatchedHomeHubSession, id, null,
                            $"lineage rooted at '{root}' carries HomeHub's namespace but no conversation "
                          + "claims it — nothing would ever delete it, and nothing records that it exists");
                    else
                        Note(findings, primary, LineageClass.LegacyAmbiguous, id, null,
                            $"lineage rooted at '{root}' predates namespaced ids. Created through the API "
                          + "server, but by whom cannot be established from the row — it needs a one-time "
                          + "human review, not an automated decision");
            }
            else if (owners.Count > 1)
            {
                foreach (var id in members)
                    Note(findings, primary, LineageClass.MultipleConversationConflict, id,
                        owners.Min(),
                        $"lineage rooted at '{root}' is claimed by conversations {string.Join(", ", owners.Order())} — "
                      + "deleting either would take the other's transcript with it");
            }
            else
            {
                foreach (var id in members)
                    Note(findings, primary, LineageClass.VerifiedAndMapped, id, owners.Single(), "");
            }
        }

        // A conversation straddling two roots: whichever is deleted, the other survives unrecorded.
        foreach (var (conversationId, roots) in rootsOfConversation.Where(kv => kv.Value.Count > 1))
            foreach (var root in roots)
                foreach (var id in lineages[root])
                    Note(findings, primary, LineageClass.MultipleRootConflict, id, conversationId,
                        $"conversation {conversationId} spans {roots.Count} separate lineages ({string.Join(", ", roots.Order())})");

        // --- 5. HomeHub's own bookkeeping, which can be wrong on its own terms. ---
        findings.AddRange(LocalFindings(conversations.Select(c => (c.Id, c.HermesSessionId)).ToList(),
            references.Select(r => (r.ConversationId, r.SessionId, r.IsCurrent)).ToList(), byId));

        var counts = new LineageCounts(
            VerifiedAndMapped: primary.Count(kv => kv.Value is LineageClass.VerifiedAndMapped),
            UnmatchedHomeHubSession: primary.Count(kv => kv.Value is LineageClass.UnmatchedHomeHubSession),
            MultipleConversationConflict: primary.Count(kv => kv.Value is LineageClass.MultipleConversationConflict),
            MultipleRootConflict: primary.Count(kv => kv.Value is LineageClass.MultipleRootConflict),
            BrokenParentChain: primary.Count(kv => kv.Value is LineageClass.BrokenParentChain),
            LegacyAmbiguous: primary.Count(kv => kv.Value is LineageClass.LegacyAmbiguous),
            UnexpectedBranchOrFork: primary.Count(kv => kv.Value is LineageClass.UnexpectedBranchOrFork),
            ForeignAncestor: primary.Count(kv => kv.Value is LineageClass.ForeignAncestor),
            Cycle: primary.Count(kv => kv.Value is LineageClass.Cycle),
            NonHomeHubSource: primary.Count(kv => kv.Value is LineageClass.NonHomeHubSource),
            LegacyCompressionChildren: legacyCompressionChildren,
            DuplicateReferences: findings.Count(f => f.Kind == nameof(LineageClass.DuplicateReference)),
            ReferencesNotOnAgent: findings.Count(f => f.Kind == nameof(LineageClass.ReferenceNotOnAgent)),
            CurrentReferenceDisagreements: findings.Count(f => f.Kind == nameof(LineageClass.CurrentReferenceDisagreement)));

        var blocking = BlockingReasons(agentKey, counts, truncated);

        return new AgentLineageReport(
            agentKey, Reachable: true, Error: null,
            SessionGraphDigest: GraphDigest(sessions, primary),
            SessionsSeen: sessions.Count, PagesRead: pages, Truncated: truncated,
            Conversations: conversations.Count, References: references.Count,
            // Reported rather than only used. The `source` mistake above was invisible until the
            // actual values were laid out beside the counts, and the next surprise in this field
            // deserves to be as cheap to see.
            SourceBreakdown: sessions.GroupBy(s => s.Source ?? "(none)", StringComparer.OrdinalIgnoreCase)
                .OrderByDescending(g => g.Count())
                .ToDictionary(g => g.Key, g => g.Count(), StringComparer.OrdinalIgnoreCase),
            Counts: counts,
            BlockingReasons: blocking,
            // Ordered worst-first so the top of the list is what to fix, and capped so one systemic
            // fault cannot bury the other findings under ten thousand identical lines.
            Findings: [.. findings.Where(f => f.Kind != nameof(LineageClass.VerifiedAndMapped))
                .OrderBy(f => f.Kind, StringComparer.Ordinal).ThenBy(f => f.SessionId, StringComparer.Ordinal)
                .Take(500)]);
    }

    /// <summary>
    /// Was this session created through the API surface HomeHub uses?
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Not <c>source == "homehub"</c>, and §3.1 says it should be.</b> HomeHub sends
    /// <c>{"source":"homehub"}</c> on create and v0.20.0 does not keep it: the deployed gateways
    /// report <c>api_server</c> for every session HomeHub has ever opened. Found on the first live
    /// run of this report — under the rule as written, all 18 sessions across the two gateways
    /// classified as "not ours" and the report declared itself **clean** while understanding none of
    /// them. That is exactly the reassuring-direction failure this tool exists to prevent, so the
    /// rule follows the wire rather than the spec.
    /// </para>
    /// <para>
    /// <b>What that costs.</b> <c>api_server</c> means "created through the API server", not
    /// "created by HomeHub" — any API client would look identical. On this deployment HomeHub is the
    /// only one, but that is an assumption about a household's setup rather than something the wire
    /// proves. So an API-created session no conversation claims is reported as
    /// <see cref="LineageClass.UnmatchedHomeHubSession"/> and blocks. Deciding it belonged to
    /// somebody else is a judgement for a person, not a default.
    /// </para>
    /// <para>
    /// <c>homehub</c> is still accepted, so a Hermes release that starts honouring the field does not
    /// silently turn every session foreign again.
    /// </para>
    /// </remarks>
    private static bool IsApiCreated(string? source) =>
        string.Equals(source, "api_server", StringComparison.OrdinalIgnoreCase)
        || string.Equals(source, "homehub", StringComparison.OrdinalIgnoreCase);

    // ---- Enumeration ----

    private async Task<(List<HermesSessionSummary> Sessions, string? Error, int Pages, bool Truncated)>
        EnumerateAsync(string agentKey, CancellationToken ct)
    {
        var all = new List<HermesSessionSummary>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var pages = 0;

        while (pages < MaxPages)
        {
            var page = await _hermes.ListSessionsAsync(agentKey, PageSize, all.Count, ct);
            if (page.Error is not null) return ([], page.Error, pages, false);

            pages++;
            foreach (var s in page.Sessions)
                if (seen.Add(s.Id)) all.Add(s);

            // A short page is the end. `has_more` is not a field on this index — an earlier draft
            // claimed it was — so paging stops on length, which is true of both shapes.
            if (page.Sessions.Count < PageSize) return (all, null, pages, false);
        }

        return (all, null, pages, true);
    }

    // ---- Walking ----

    /// <summary>
    /// A digest of every session this agent holds and how they are related.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>The whole graph, not only the adverse findings, and that is the correction.</b> An
    /// acceptance is bound to a fingerprint of the report; the fingerprint hashed findings, and a
    /// <see cref="LineageClass.VerifiedAndMapped"/> session produces no adverse finding at all. So
    /// this sequence changed nothing an acceptance was watching: a conversation anchored to session A
    /// is authorised for deletion; Hermes compresses A into a child B; the next audit maps both A and
    /// B cleanly through A; the fingerprint is identical; the old authorisation still holds; and
    /// deleting tombstones A alone and drops the anchor, orphaning B for ever. No race was needed.
    /// </para>
    /// <para>
    /// So what is hashed is the observed graph: every session id, its parent, its lineage root, how it
    /// ended, and the class it was given. A compression adds a node and an edge and changes a parent's
    /// end reason, all three of which move this digest. Message counts are deliberately absent — an
    /// ordinary reply would otherwise lapse every outstanding authorisation, which is churn rather
    /// than safety.
    /// </para>
    /// </remarks>
    private static string GraphDigest(
        IReadOnlyList<HermesSessionSummary> sessions, IReadOnlyDictionary<string, LineageClass> primary)
    {
        const char separator = '\u001f';
        var canonical = new System.Text.StringBuilder();

        foreach (var session in sessions.OrderBy(x => x.Id, StringComparer.Ordinal))
        {
            canonical
                .Append(session.Id).Append(separator)
                .Append(session.ParentSessionId ?? "").Append(separator)
                .Append(session.LineageRootId ?? "").Append(separator)
                .Append(session.Source ?? "").Append(separator)
                .Append(session.EndReason ?? "").Append(separator)
                .Append(primary.TryGetValue(session.Id, out var cls) ? cls.ToString() : "unclassified")
                .Append('\n');
        }

        return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(canonical.ToString())));
    }

    private enum WalkOutcome { Ok, Cycle, MissingParent, ForeignAncestor }

    private readonly record struct Walk(WalkOutcome Outcome, string? Root, string? StoppedAt, string? StoppedSource);

    /// <summary>Follow <c>parent_session_id</c> upward until something ends the walk.</summary>
    /// <remarks>
    /// <c>_lineage_root_id</c> is deliberately not trusted as the answer. It is Hermes's own summary
    /// of the same links, and where the two disagree the disagreement is the finding — so the walk is
    /// the authority and the reported root is one HomeHub can defend from the edges it read.
    /// </remarks>
    private static Walk WalkToRoot(HermesSessionSummary start, Dictionary<string, HermesSessionSummary> byId)
    {
        var visited = new HashSet<string>(StringComparer.Ordinal) { start.Id };
        var current = start;

        while (current.ParentSessionId is { Length: > 0 } parentId)
        {
            if (!visited.Add(parentId))
                return new Walk(WalkOutcome.Cycle, null, parentId, null);

            if (!byId.TryGetValue(parentId, out var parent))
                return new Walk(WalkOutcome.MissingParent, null, parentId, null);

            // The same ownership rule as step 1, and it must stay the same rule — when these two
            // drifted apart, every child in a lineage was reported as having a foreign ancestor while
            // its own root was reported as unclaimed: two confident findings, both wrong, describing
            // one intact chain.
            if (!IsApiCreated(parent.Source))
                return new Walk(WalkOutcome.ForeignAncestor, null, parentId, parent.Source);

            current = parent;
        }

        return new Walk(WalkOutcome.Ok, current.Id, null, null);
    }

    // ---- HomeHub-side bookkeeping ----

    private static List<LineageFinding> LocalFindings(
        List<(int Id, string? HermesSessionId)> conversations,
        List<(int ConversationId, string SessionId, bool IsCurrent)> references,
        Dictionary<string, HermesSessionSummary> byId)
    {
        var findings = new List<LineageFinding>();

        foreach (var group in references.GroupBy(r => r.SessionId, StringComparer.Ordinal))
        {
            var owners = group.Select(r => r.ConversationId).Distinct().ToList();

            if (owners.Count > 1)
                findings.Add(new LineageFinding(nameof(LineageClass.DuplicateReference), group.Key, owners.Min(),
                    $"session is referenced by conversations {string.Join(", ", owners.Order())}; "
                  + "deleting one would delete the other's transcript"));
            else if (group.Count() > 1)
                findings.Add(new LineageFinding(nameof(LineageClass.DuplicateReference), group.Key, owners[0],
                    $"{group.Count()} reference rows for the same session on conversation {owners[0]}"));

            if (!byId.ContainsKey(group.Key))
                // Benign if it was deleted on purpose; a real gap if it was not. HomeHub cannot tell
                // from here, so it is reported rather than assumed either way.
                findings.Add(new LineageFinding(nameof(LineageClass.ReferenceNotOnAgent), group.Key, owners[0],
                    "HomeHub holds a reference to a session the agent does not have"));
        }

        foreach (var c in conversations)
        {
            var mine = references.Where(r => r.ConversationId == c.Id).ToList();
            if (mine.Count == 0) continue;

            var current = mine.Where(r => r.IsCurrent).ToList();
            if (current.Count != 1)
                findings.Add(new LineageFinding(nameof(LineageClass.CurrentReferenceDisagreement),
                    c.HermesSessionId ?? "(none)", c.Id,
                    $"conversation has {current.Count} references marked current; exactly one is required"));
            else if (!string.Equals(current[0].SessionId, c.HermesSessionId, StringComparison.Ordinal))
                findings.Add(new LineageFinding(nameof(LineageClass.CurrentReferenceDisagreement),
                    c.HermesSessionId ?? "(none)", c.Id,
                    $"conversation points at '{c.HermesSessionId}' but its current reference is '{current[0].SessionId}'"));
        }

        return findings;
    }

    // ---- Verdict ----

    private static List<string> BlockingReasons(string agentKey, LineageCounts c, bool truncated)
    {
        var reasons = new List<string>();

        if (truncated)
            reasons.Add($"{agentKey}: the session index did not end within {MaxPages} pages, so this report is incomplete");

        void Add(int n, string what) { if (n > 0) reasons.Add($"{agentKey}: {n} {what}"); }

        Add(c.Cycle, "session(s) whose parent chain loops");
        Add(c.MultipleConversationConflict, "session(s) claimed by more than one conversation");
        Add(c.MultipleRootConflict, "session(s) in a conversation that spans several lineages");
        Add(c.BrokenParentChain, "session(s) with a parent this agent does not have");
        Add(c.ForeignAncestor, "session(s) whose lineage leaves what HomeHub owns");
        Add(c.UnmatchedHomeHubSession, "session(s) in HomeHub's namespace belonging to no conversation");
        Add(c.LegacyAmbiguous, "pre-namespacing session(s) whose owner cannot be established — need one human review");
        Add(c.UnexpectedBranchOrFork, "branch/fork/delegate child session(s) that are not a compression rotation");
        Add(c.DuplicateReferences, "duplicate or shared lineage reference(s)");
        Add(c.CurrentReferenceDisagreements, "conversation(s) disagreeing with their own current reference");

        // ReferencesNotOnAgent is deliberately *not* blocking: the ordinary cause is a session that was
        // already deleted, which is the outcome the deletion path wants. It is reported so a spike in
        // it is visible, not treated as damage.

        return reasons;
    }

    /// <summary>
    /// The strongest thing the delete modal is allowed to say right now.
    /// </summary>
    /// <remarks>
    /// D4's wording promises the transcripts are gone. That promise is only true once every lineage
    /// id is known, which is exactly what a clean report establishes — so until then the copy has to
    /// be the weaker, true one. Returned with the report so the gate travels with the evidence rather
    /// than living in someone's memory of a conversation.
    /// </remarks>
    private static string PermittedDeleteCopy(bool clean) => clean
        ? "Delete this conversation? This removes it from HomeHub and deletes its Hermes transcripts. "
        + "Facts the assistant previously saved to long-term memory may remain."
        : "Delete this conversation? This removes it from HomeHub and deletes the Hermes transcripts "
        + "HomeHub knows about. Some of this conversation may remain on the agent. Facts the assistant "
        + "previously saved to long-term memory may remain.";

    // ---- Small helpers ----

    private static void Claim(Dictionary<string, HashSet<int>> claimants, string sessionId, int conversationId)
    {
        if (!claimants.TryGetValue(sessionId, out var set)) claimants[sessionId] = set = [];
        set.Add(conversationId);
    }

    /// <summary>
    /// Record a finding, and keep the session's class at the worst thing said about it.
    /// </summary>
    /// <remarks>
    /// Two collections on purpose. <c>primary</c> counts each session exactly once so the totals add
    /// up to the number of sessions; <c>findings</c> keeps every separate problem, because a session
    /// that is both orphaned and double-claimed has two things wrong with it and a repair needs both.
    /// </remarks>
    private static void Note(
        List<LineageFinding> findings, Dictionary<string, LineageClass> primary,
        LineageClass kind, string sessionId, int? conversationId, string detail)
    {
        if (kind != LineageClass.VerifiedAndMapped)
            findings.Add(new LineageFinding(kind.ToString(), sessionId, conversationId, detail));

        if (!primary.TryGetValue(sessionId, out var existing) || Severity(kind) > Severity(existing))
            primary[sessionId] = kind;
    }

    /// <summary>Worst-first ordering, so a session's class is the most serious thing found about it.</summary>
    private static int Severity(LineageClass c) => c switch
    {
        LineageClass.Cycle => 8,
        LineageClass.MultipleConversationConflict => 7,
        LineageClass.MultipleRootConflict => 6,
        LineageClass.BrokenParentChain => 5,
        LineageClass.ForeignAncestor => 4,
        LineageClass.UnmatchedHomeHubSession => 3,
        LineageClass.LegacyAmbiguous => 3,
        LineageClass.UnexpectedBranchOrFork => 2,
        LineageClass.VerifiedAndMapped => 1,
        _ => 0,
    };
}

/// <summary>How one session was classified. §3.1's list, plus the cases reality adds.</summary>
public enum LineageClass
{
    /// <summary>Mapped to exactly one conversation, with an intact chain. The only class retention may touch.</summary>
    VerifiedAndMapped,

    /// <summary>
    /// Created through the API surface HomeHub uses, and claimed by no conversation. Nothing would
    /// ever delete it, and nothing records that it exists.
    /// </summary>
    UnmatchedHomeHubSession,

    /// <summary>One lineage, two conversations. Deleting either would take the other's transcript.</summary>
    MultipleConversationConflict,

    /// <summary>One conversation, two lineages. Whichever is deleted, the other survives unrecorded.</summary>
    MultipleRootConflict,

    /// <summary>The parent is not on this agent — already orphaned, and unreconstructable.</summary>
    BrokenParentChain,

    /// <summary>A child that is not a compression rotation: a fork, or a delegate. The index cannot say which.</summary>
    UnexpectedBranchOrFork,

    /// <summary>The chain climbs out of HomeHub-owned territory into somebody else's session.</summary>
    ForeignAncestor,

    /// <summary>The parent chain loops. No root exists to anchor the lineage.</summary>
    Cycle,

    /// <summary>
    /// Created through the API server before HomeHub namespaced its session ids, and claimed by no
    /// conversation. Might be ours; might not. The row cannot say, and neither can this report.
    /// </summary>
    LegacyAmbiguous,

    /// <summary>Created elsewhere — the Hermes CLI, typically. Counted so the totals reconcile, never touched.</summary>
    NonHomeHubSource,

    /// <summary>HomeHub-side: one session referenced twice, or by two conversations.</summary>
    DuplicateReference,

    /// <summary>HomeHub-side: a reference to a session the agent does not have.</summary>
    ReferenceNotOnAgent,

    /// <summary>HomeHub-side: the conversation and its own lineage table disagree about "current".</summary>
    CurrentReferenceDisagreement,
}

/// <param name="Kind">A <see cref="LineageClass"/> name.</param>
/// <param name="SessionId">The session the finding is about.</param>
/// <param name="ConversationId">The conversation involved, where there is one.</param>
/// <param name="Detail">What is wrong, in a sentence somebody can act on.</param>
public sealed record LineageFinding(string Kind, string SessionId, int? ConversationId, string Detail);

/// <summary>Every session counted once, by its worst finding — plus the tallies that cut across.</summary>
public sealed record LineageCounts(
    int VerifiedAndMapped,
    int UnmatchedHomeHubSession,
    int MultipleConversationConflict,
    int MultipleRootConflict,
    int BrokenParentChain,
    /// <summary>Pre-namespacing rows: created through the API server, by whom is unprovable.</summary>
    int LegacyAmbiguous,
    int UnexpectedBranchOrFork,
    int ForeignAncestor,
    int Cycle,
    int NonHomeHubSource,
    /// <summary>Not a fault — the rotations a backfill would attach. Zero on an in-place deployment.</summary>
    int LegacyCompressionChildren,
    int DuplicateReferences,
    int ReferencesNotOnAgent,
    int CurrentReferenceDisagreements);

public sealed record AgentLineageReport(
    string AgentKey,
    bool Reachable,
    string? Error,
    /// <summary>
    /// A digest of every session on this agent and how they relate — see the note on the method that
    /// builds it. Opaque, and in the report so that an acceptance can be bound to the graph rather
    /// than to the subset of it that happened to be a problem.
    /// </summary>
    string SessionGraphDigest,
    int SessionsSeen,
    int PagesRead,
    bool Truncated,
    int Conversations,
    int References,
    /// <summary>Observed `source` values and their counts — the field ownership is decided on.</summary>
    IReadOnlyDictionary<string, int> SourceBreakdown,
    LineageCounts Counts,
    IReadOnlyList<string> BlockingReasons,
    IReadOnlyList<LineageFinding> Findings)
{
    private static readonly LineageCounts None = new(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

    public static AgentLineageReport NotConfigured(string key) =>
        new(key, false, "not configured", "", 0, 0, false, 0, 0,
            new Dictionary<string, int>(), None, [], []);

    /// <summary>
    /// An agent that did not answer blocks the verdict.
    /// </summary>
    /// <remarks>
    /// The tempting alternative is to skip it and report on the rest. That produces a clean report
    /// for a household whose second agent is holding every transcript it ever had — the report would
    /// be accurate about what it read and wrong about what it means.
    /// </remarks>
    public static AgentLineageReport Unreachable(string key, string error) =>
        new(key, false, error, "", 0, 0, false, 0, 0, new Dictionary<string, int>(), None,
            [$"{key}: could not be read ({error}), so nothing about it can be vouched for"], []);
}

/// <param name="Clean">Every agent read, nothing unexplained. The precondition for the backfill.</param>
/// <param name="PermittedDeleteCopy">The strongest wording the delete modal may use right now.</param>
public sealed record LineageReport(
    DateTime GeneratedAtUtc,
    bool Clean,
    IReadOnlyList<string> BlockingReasons,
    IReadOnlyList<AgentLineageReport> Agents,
    string PermittedDeleteCopy);

/// <summary>What a reconciliation decided, and what it will take to act on it.</summary>
/// <param name="State">The household's lineage state after this call.</param>
/// <param name="Clean">The audit's own verdict, which is what decided the state.</param>
/// <param name="BlockingReasons">Why it was not clean, in the report's own words.</param>
/// <param name="UnresolvedSessionIds">The sessions nothing could vouch for. Informational.</param>
/// <param name="Challenge">
/// Present only when unclean: the opaque, expiring token an administrator must return to authorise a
/// specific deletion.
/// <para>
/// <b>It replaced the unresolved-session list as the confirmation, which was fail-open.</b> An agent
/// that cannot be read enumerates nothing, so that list is empty exactly when there is most to accept
/// — and an empty acknowledgement matched it. This is bound to reachability and blocking reasons too,
/// so the inability to enumerate is part of what is signed.
/// </para>
/// </param>
public sealed record LineageReconciliation(
    Settings.LineageState State,
    bool Clean,
    IReadOnlyList<string> BlockingReasons,
    IReadOnlyList<string> UnresolvedSessionIds,
    string? Challenge);

/// <summary>An administrator's authorisation to delete specific conversations.</summary>
/// <param name="Challenge">The token the reconciliation issued. Proof that a report was read.</param>
/// <param name="ConversationIds">
/// Exactly the conversations this authorises. A blanket acceptance is refused: the point is that the
/// person accepting knows what is being deleted, not merely that something is.
/// </param>
public sealed record AcceptLineageRiskRequest(string? Challenge, IReadOnlyList<int>? ConversationIds);

/// <summary>What was authorised, echoed back so the panel can say so.</summary>
public sealed record LineageAcceptanceResult(
    IReadOnlyList<int> AuthorisedConversationIds,
    IReadOnlyList<string> AcceptedBlockingReasons);
