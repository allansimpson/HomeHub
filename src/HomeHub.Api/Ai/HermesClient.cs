namespace HomeHub.Api.Ai;

using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text.Json;
using HomeHub.Api.Assist;
using Microsoft.Extensions.Options;

/// <summary>
/// HomeHub's whole conversation with a Hermes gateway.
/// </summary>
/// <remarks>
/// <para>
/// <b>What this never sends.</b> No model, no provider, no tier, no route alias, no escalation
/// policy. Hermes v0.20.0 defaults a missing Chat Completions <c>model</c> to the listener's own
/// advertised profile, so omitting the field is not a shortcut — it is the mechanism. <b>The endpoint
/// is the agent selector</b>: Barnaby's gateway answers as Barnaby because it is Barnaby's gateway.
/// </para>
/// <para>
/// <b>Two listeners, no multiplexing.</b> Each agent is an independent gateway on its own loopback
/// port with its own profile, session database, memory and key. There is no <c>/p/{profile}</c>
/// prefix. A session id is meaningless outside the listener that issued it, which is why every method
/// here takes an agent key and resolves its own client.
/// </para>
/// </remarks>
public sealed class HermesClient
{
    private readonly HermesClientFactory _clients;
    private readonly HermesOptions _options;
    private readonly ILogger<HermesClient> _logger;

    /// <summary>Surface identification is a property of the deployment; probe once per agent.</summary>
    private readonly ConcurrentDictionary<string, HermesSurface> _surfaces = new(StringComparer.OrdinalIgnoreCase);

    public HermesClient(HermesClientFactory clients, IOptions<HermesOptions> options, ILogger<HermesClient> logger)
    {
        _clients = clients;
        _options = options.Value;
        _logger = logger;
    }

    // ---- Identification ----

    /// <summary>
    /// Which Hermes HTTP surface is at this agent's address?
    /// </summary>
    /// <remarks>
    /// A Hermes host serves two surfaces that both mount paths under <c>/api/</c>, and confusing them
    /// finds plausibly-named routes with entirely different contracts:
    /// <list type="bullet">
    /// <item><b>API-server gateway</b> — ours. <c>/health</c> → <c>{status, platform, version}</c>,
    /// <c>API_SERVER_KEY</c> auth, <c>/v1/*</c>, session chat.</item>
    /// <item><b>Dashboard</b> — human administration. <c>/api/health</c> →
    /// <c>{ok, version, auth_required}</c>, browser auth, an <c>/api/sessions</c> that lists and
    /// deletes rather than converses.</item>
    /// </list>
    /// Discriminated on the response <b>shape</b>, never the path: a Hermes host serves its dashboard
    /// SPA from unknown paths with <b>200 and HTML</b>, so a status code proves nothing. Neither does
    /// an unauthenticated <c>401</c> — a gate that runs before route resolution says only that
    /// something intercepted the request.
    /// </remarks>
    public async Task<HermesSurface> IdentifyAsync(string agentKey, CancellationToken ct)
    {
        if (_surfaces.TryGetValue(agentKey, out var cached)) return cached;

        var surface = await ProbeSurfaceAsync(agentKey, ct);

        // Only a positive identification is cached. Caching "unreachable" would blacklist an agent
        // that happened to be restarting when the panel first asked, and nothing would ever re-ask.
        if (surface is HermesSurface.ApiServer or HermesSurface.Dashboard) _surfaces[agentKey] = surface;

        if (surface is HermesSurface.Dashboard)
            // Say which wrong thing is there. "Unreachable" and "you are pointed at the dashboard"
            // need completely different fixes, and the second is the one that costs an afternoon.
            _logger.LogWarning(
                "Agent '{Agent}' is the Hermes dashboard, not the API-server gateway. HomeHub needs the api_server platform — check the port.",
                agentKey);

        return surface;
    }

    private async Task<HermesSurface> ProbeSurfaceAsync(string agentKey, CancellationToken ct)
    {
        var apiServer = await ReadJsonAsync(agentKey, "health", ct);
        if (apiServer is { } a && a.TryGetProperty("platform", out _) && a.TryGetProperty("status", out _))
            return HermesSurface.ApiServer;

        var dashboard = await ReadJsonAsync(agentKey, "api/health", ct);
        if (dashboard is { } d && d.TryGetProperty("auth_required", out _) && d.TryGetProperty("ok", out _))
            return HermesSurface.Dashboard;

        return apiServer is null && dashboard is null ? HermesSurface.Unreachable : HermesSurface.Unknown;
    }

    /// <summary>Whether this agent has an address and a credential. No network call.</summary>
    /// <remarks>
    /// Configuration, not reachability. Turns do not probe before calling — see
    /// <c>AssistTurnService.AskAsync</c> — so this is the only pre-flight check on the hot path, and
    /// it is one that cannot go stale between asking and acting.
    /// </remarks>
    public bool IsConfigured(string agentKey) => _clients.IsConfigured(agentKey);

    /// <summary>
    /// The profile identity this listener advertises, from <c>/v1/models</c>.
    /// </summary>
    /// <remarks>
    /// The operator-facing check that a configured address really is the agent it claims to be —
    /// pointing Barnaby's config at Geist's port is a one-character mistake that would otherwise
    /// surface as a personality that quietly remembers the wrong things.
    /// </remarks>
    public async Task<string?> AdvertisedIdentityAsync(string agentKey, CancellationToken ct)
    {
        var doc = await ReadJsonAsync(agentKey, "v1/models", ct);
        if (doc is not { } root) return null;

        // Both an object and a `{data:[…]}` list are plausible; read whichever arrived.
        if (root.TryGetProperty("id", out var direct) && direct.ValueKind is JsonValueKind.String)
            return direct.GetString();
        if (root.TryGetProperty("data", out var data) && data.ValueKind is JsonValueKind.Array && data.GetArrayLength() > 0
            && data[0].TryGetProperty("id", out var first) && first.ValueKind is JsonValueKind.String)
            return first.GetString();

        return null;
    }

    // ---- Sessions ----

    /// <summary>Open a session for a new conversation. Null when the agent could not provide one.</summary>
    public async Task<string?> CreateSessionAsync(string agentKey, string title, CancellationToken ct)
    {
        var http = _clients.Create(agentKey);
        if (http is null) return null;

        try
        {
            // A caller-supplied id, and still no model/provider/model_options — those would pin a
            // model onto the session, putting a model choice into HomeHub by the back door. Naming
            // the session is a different kind of thing: it is HomeHub's own bookkeeping, and the only
            // way a session can still be proved ours years later (see HomeHubSessionId).
            //
            // `source` is sent for the record and is expected to come back as `api_server`: Hermes
            // normalises it through a closed allowlist. Nothing may depend on it.
            // The title as sent, which is not always the title as asked for — see the `invalid_title`
            // branch below.
            var sending = title;

            for (var attempt = 0; attempt < 2; attempt++)
            {
                var id = HomeHubSessionId.New(agentKey);
                using var res = await http.PostAsJsonAsync(
                    "api/sessions", new { id, title = sending, source = "homehub" }, Timeout(ct));

                // A 409 means that id already exists. With a fresh GUID that should never happen, so
                // one retry is generosity rather than a strategy — a second collision is a broken
                // assumption worth surfacing, not worth looping over.
                if (res.StatusCode == HttpStatusCode.Conflict)
                {
                    _logger.LogWarning("Hermes rejected session id as a duplicate for '{Agent}'; retrying once.", agentKey);
                    continue;
                }

                if (res.IsSuccessStatusCode) return await ReadCreatedAsync(res, id, agentKey, ct);

                // The body, because the status on its own is not a diagnosis. A refusal here stops
                // every *new* chat on this agent while existing ones carry on answering from the
                // session they already hold — which reads as the panel being broken for some people
                // and fine for others, and sent one of these hunts across two days and three devices.
                // Hermes says why in the response; this is the only place that can hear it.
                //
                // Read as text rather than parsed: this runs when the shape of the answer is already
                // not what was expected, so anything that assumed a shape would be the next thing to
                // break.
                var why = await res.Content.ReadAsStringAsync(ct);

                /*
                 * Hermes requires session titles to be unique, and HomeHub names a session after the
                 * words that opened it.
                 *
                 * So asking an agent something it has been asked before — "tell me a joke", "what's
                 * the weather" — refused the session, and with no session there is no chat: the panel
                 * says the assistant is unreachable while that same agent answers every conversation
                 * that already exists, because those carry a session id and never come through here.
                 * Household phrasing repeats. That is not an edge case, it is Tuesday.
                 *
                 * Renamed rather than surfaced. The household asked a question; which of its previous
                 * questions it happens to resemble is Hermes bookkeeping and not something anybody
                 * here should have to think about. HomeHub's own title — the one on the row in the
                 * inbox — is stored separately and keeps the words exactly as they were typed.
                 *
                 * Once, then the failure stands: a second collision on a title carrying six random
                 * characters is not a name clash, it is something else wearing its clothes, and
                 * looping on it would turn one bad answer into an argument.
                 */
                if (attempt == 0
                    && res.StatusCode == HttpStatusCode.BadRequest
                    && why.Contains("invalid_title", StringComparison.OrdinalIgnoreCase))
                {
                    sending = Disambiguate(title);
                    _logger.LogInformation(
                        "Hermes already has a session titled this for '{Agent}'; retrying under a distinct name.",
                        agentKey);
                    continue;
                }

                _logger.LogWarning(
                    "Hermes session create failed for '{Agent}': {Status}. {Body}",
                    agentKey, res.StatusCode, why.Length > 500 ? why[..500] : why);
                return null;
            }

            return null;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "Hermes session create failed for '{Agent}'.", agentKey);
            return null;
        }
    }

    /// <summary>The id Hermes says it created, from a successful create.</summary>
    private async Task<string?> ReadCreatedAsync(
        HttpResponseMessage res, string asked, string agentKey, CancellationToken ct)
    {
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
        var created = ReadCreatedId(doc.RootElement);

        // Trust what came back, not what was asked for. If a future Hermes stops honouring caller
        // ids, the sessions must still work — they simply stop being provably ours, and this line is
        // where that would first be visible.
        if (created is not null && !string.Equals(created, asked, StringComparison.Ordinal))
            _logger.LogWarning(
                "Hermes did not keep HomeHub's session id for '{Agent}' — ownership of this session "
              + "cannot be proved from its id.", agentKey);

        return created;
    }

    /// <summary>
    /// The same title, made distinct enough for a store that will not hold two of a name.
    /// </summary>
    /// <remarks>
    /// A short random tag rather than a counter or a clock. A counter needs to know what is already
    /// there, which is a listing of every session on the agent to settle a naming question nobody
    /// asked; a timestamp collides for two people asking the same thing in the same minute, which on
    /// a household panel is a normal morning rather than a coincidence.
    /// <para>
    /// The words come first and the tag is appended, so the title still reads as what was asked in
    /// any list that truncates. Trimmed to leave room for the tag rather than letting the result grow
    /// past what Hermes accepted for the original.
    /// </para>
    /// </remarks>
    private static string Disambiguate(string title)
    {
        var tag = Guid.NewGuid().ToString("N")[..6];
        var room = AssistFieldLimits.Title - (tag.Length + 3);
        var stem = title.Length <= room ? title : title[..Math.Max(room, 0)].TrimEnd();
        return $"{stem} ({tag})";
    }

    /// <summary>
    /// One non-streaming turn.
    /// </summary>
    /// <remarks>
    /// Only the new user turn is sent. With <c>X-Hermes-Session-Id</c> present, Hermes loads history
    /// from its own profile-local <c>state.db</c> — replaying HomeHub's transcript would duplicate
    /// every prior turn into the agent's context.
    /// </remarks>
    public async Task<HermesReply> ChatAsync(
        string agentKey, string? sessionId, IReadOnlyList<HermesContent> content, CancellationToken ct)
    {
        var http = _clients.Create(agentKey)
            ?? throw new InvalidOperationException($"Agent '{agentKey}' is not configured.");

        // A turn's ceiling, not the housekeeping one — see TurnDeadline.
        using var turn = TurnDeadline(ct);
        using var req = BuildChat(sessionId, content, stream: false);
        using var res = await http.SendAsync(req, HttpCompletionOption.ResponseContentRead, turn.Token);
        await ThrowIfFailed(res, agentKey, turn.Token);

        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(turn.Token));
        var root = doc.RootElement;

        // Header only. A standard Chat Completions body carries **no** top-level `session_id`; the
        // earlier body fallback was dead code that read as a safety net. Falling back to what we sent
        // is correct — under in-place compression the effective id is the requested one.
        return new HermesReply(ReadCompletionText(root), ReadModel(root), HeaderSessionId(res) ?? sessionId);
    }

    /// <summary>
    /// One streamed turn, yielding text deltas as they arrive.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>No session id comes back from a stream.</b> The response header is written before the run
    /// starts, and the terminal chunk carries no id. Under the deployed default — in-place compression
    /// — the id does not change, so this costs nothing; a deployment running legacy rotating
    /// compression needs the post-stream <see cref="ResolveSessionAsync"/> read, under the
    /// conversation lock.
    /// </para>
    /// <para>
    /// Yields typed items rather than strings: text deltas, tool progress, and a terminal completion
    /// carrying <c>finish_reason</c> and token usage. Tool progress arrives as a <b>named</b> SSE
    /// event and would be invisible to a reader that only looked at content deltas.
    /// </para>
    /// <para>
    /// Cancelling does propagate: Hermes hard-interrupts the run when it notices the client has gone.
    /// It notices on its next write, and the keepalive is 30s, so a silent model call can keep running
    /// for a while. Tools stop cooperatively, and a house write may already have committed. So an
    /// abandoned turn is *cancellation requested*, not *cancelled* — the ledger reconciles against the
    /// MCP audit before deciding which.
    /// </para>
    /// </remarks>
    public async IAsyncEnumerable<HermesStreamItem> StreamChatAsync(
        string agentKey,
        string? sessionId,
        IReadOnlyList<HermesContent> content,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var http = _clients.Create(agentKey)
            ?? throw new InvalidOperationException($"Agent '{agentKey}' is not configured.");

        using var req = BuildChat(sessionId, content, stream: true);
        using var res = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
        await ThrowIfFailed(res, agentKey, ct);

        using var stream = await res.Content.ReadAsStreamAsync(ct);
        await foreach (var item in HermesStream.ReadAsync(stream, _logger, ct))
            yield return item;
    }

    /// <summary>
    /// Resolve a possibly-stale session id to whatever Hermes considers current for it.
    /// </summary>
    /// <remarks>
    /// <b>Usually a no-op on this deployment.</b> Both profiles compress *in place* — the active
    /// message set is rewritten under the same id and pre-compaction rows are soft-archived, so no
    /// descendant is created and nothing rotates. This exists for the legacy rotating mode and for
    /// repairing a conversation whose stored id was left behind by an interrupted turn.
    /// <para>
    /// The messages endpoint reports the resolved id in its <b>body</b> — it sets no
    /// <c>X-Hermes-Session-Id</c>, and requiring one would make repair fail closed every time. Cheap:
    /// a local SQLite read on the agent's own host.
    /// </para>
    /// </remarks>
    public async Task<string?> ResolveSessionAsync(string agentKey, string sessionId, CancellationToken ct)
    {
        var doc = await ReadJsonAsync(agentKey, $"api/sessions/{Uri.EscapeDataString(sessionId)}/messages", ct);
        if (doc is not { } root) return null;
        return root.TryGetProperty("session_id", out var v) && v.ValueKind is JsonValueKind.String
            ? v.GetString() : null;
    }

    /// <summary>
    /// Delete one session row.
    /// </summary>
    /// <remarks>
    /// <b>One row, not a lineage.</b> Hermes deletes exactly the id given and orphans surviving
    /// compression children rather than cascading. Deleting a logical conversation means calling this
    /// for every id in its lineage — see the deletion worker.
    /// <para>
    /// <c>404</c> is success <i>for that id</i>: the outcome asked for already holds. It says nothing
    /// about the rest of the lineage.
    /// </para>
    /// </remarks>
    public async Task<bool> DeleteSessionAsync(string agentKey, string sessionId, CancellationToken ct)
    {
        var http = _clients.Create(agentKey);
        if (http is null) return false;

        try
        {
            using var res = await http.DeleteAsync($"api/sessions/{Uri.EscapeDataString(sessionId)}", Timeout(ct));
            if (res.StatusCode == HttpStatusCode.NotFound) return true;
            if (!res.IsSuccessStatusCode)
                _logger.LogWarning("Hermes session delete failed for '{Agent}': {Status}.", agentKey, res.StatusCode);
            return res.IsSuccessStatusCode;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "Hermes session delete failed for '{Agent}'.", agentKey);
            return false;
        }
    }

    /// <summary>
    /// One page of the session index — **read-only**, for the §3.1 lineage report.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>No <c>source</c> filter, deliberately, and §3.1 specifies one.</b> Filtering server-side to
    /// <c>source=homehub</c> makes two of the report's own required classes unobservable: a
    /// non-HomeHub session can never be counted, and a parent that was filtered out is
    /// indistinguishable from a parent that does not exist — so a perfectly intact lineage whose root
    /// was created at the Hermes CLI would be reported as a broken chain. The filter is applied here
    /// instead, where both cases can be told apart and named.
    /// </para>
    /// <para>
    /// Only the structural fields are read: id, source, parent, lineage root, end reason, counts.
    /// <b>Never <c>title</c> or <c>preview</c>.</b> This is a repair tool reading every session on a
    /// household's agent, including ones HomeHub does not own, and it has no business copying their
    /// content into a report — the graph is all it needs.
    /// </para>
    /// <para>
    /// Failure is returned rather than swallowed. A report built on a silently empty read would
    /// declare a healthy-looking "nothing wrong here" for an agent that never answered, which is the
    /// one wrong answer this whole exercise exists to prevent.
    /// </para>
    /// </remarks>
    public async Task<HermesSessionPage> ListSessionsAsync(
        string agentKey, int limit, int offset, CancellationToken ct)
    {
        var http = _clients.Create(agentKey);
        if (http is null) return new HermesSessionPage([], "not configured");

        var path = $"api/sessions?include_children=true&limit={limit}&offset={offset}";

        try
        {
            using var res = await http.GetAsync(path, Timeout(ct));
            if (!res.IsSuccessStatusCode)
                return new HermesSessionPage([], $"HTTP {(int)res.StatusCode}");

            // Same guard as every other read here: a Hermes host answers unknown paths with its
            // dashboard SPA at 200/text-html, and a report that parsed a web page as a session index
            // would be worse than one that failed.
            if (res.Content.Headers.ContentType?.MediaType is not "application/json")
                return new HermesSessionPage([], "response was not JSON");

            using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
            if (!doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind is not JsonValueKind.Array)
                return new HermesSessionPage([], "response had no `data` array");

            var rows = new List<HermesSessionSummary>(data.GetArrayLength());
            foreach (var row in data.EnumerateArray())
            {
                if (Str(row, "id") is not { Length: > 0 } id) continue;
                rows.Add(new HermesSessionSummary(
                    id,
                    Str(row, "source"),
                    Str(row, "parent_session_id"),
                    Str(row, "_lineage_root_id"),
                    Str(row, "end_reason"),
                    Num(row, "message_count")));
            }
            return new HermesSessionPage(rows, null);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "Hermes session enumeration failed for '{Agent}'.", agentKey);
            // Never the exception text: it can carry the request URI, and the bearer key is on that
            // client. The caller only needs to know this page did not arrive.
            return new HermesSessionPage([], ex.GetType().Name);
        }
    }

    // ---- Internals ----

    private static string? Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind is JsonValueKind.String ? v.GetString() : null;

    private static int? Num(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind is JsonValueKind.Number && v.TryGetInt32(out var i)
            ? i : null;

    private static HttpRequestMessage BuildChat(string? sessionId, IReadOnlyList<HermesContent> content, bool stream)
    {
        // No `model`, no `provider`, no `model_options`. Hermes defaults the model to this listener's
        // own profile, which is exactly what "the endpoint is the agent selector" means.
        object messageContent = content.Count == 1 && content[0].ImageDataUrl is null
            ? content[0].Text ?? ""
            : content.Select(c => c.ImageDataUrl is { } url
                ? (object)new { type = "image_url", image_url = new { url } }
                : new { type = "text", text = c.Text ?? "" }).ToArray();

        var req = new HttpRequestMessage(HttpMethod.Post, "v1/chat/completions")
        {
            Content = JsonContent.Create(new
            {
                messages = new[] { new { role = "user", content = messageContent } },
                stream,
            }),
        };

        if (!string.IsNullOrWhiteSpace(sessionId)) req.Headers.Add("X-Hermes-Session-Id", sessionId);
        return req;
    }

    private static async Task ThrowIfFailed(HttpResponseMessage res, string agentKey, CancellationToken ct)
    {
        if (res.IsSuccessStatusCode) return;

        // Busy is not broken. Hermes caps concurrent runs and says when to come back; failing the turn
        // would make a shared panel flaky exactly when the household is using it most.
        if (res.StatusCode is HttpStatusCode.TooManyRequests or HttpStatusCode.ServiceUnavailable)
            throw new HermesBusyException(RetryAfter(res));

        if (res.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            // Never echo the response body here: an auth failure is the one place a misconfigured
            // deployment is most likely to have put a credential somewhere it gets reflected back.
            throw new HermesAuthException(agentKey, res.StatusCode);

        var body = await res.Content.ReadAsStringAsync(ct);
        var detail = string.IsNullOrWhiteSpace(body) ? res.ReasonPhrase : body.Trim();
        if (detail?.Length > 500) detail = detail[..500];
        throw new HttpRequestException(
            $"Hermes '{agentKey}' failed: {(int)res.StatusCode} {res.StatusCode} — {detail}", null, res.StatusCode);
    }

    private async Task<JsonElement?> ReadJsonAsync(string agentKey, string path, CancellationToken ct)
    {
        var http = _clients.Create(agentKey);
        if (http is null) return null;

        try
        {
            using var res = await http.GetAsync(path, Timeout(ct));
            if (!res.IsSuccessStatusCode) return null;
            // The content-type check is the whole point: a Hermes host answers unknown paths with its
            // dashboard SPA at 200/text-html, and parsing that as a contract is how a probe ends up
            // confidently reading a web page.
            if (res.Content.Headers.ContentType?.MediaType is not "application/json") return null;

            using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
            return doc.RootElement.Clone();
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogDebug(ex, "Hermes probe of {Path} failed for '{Agent}'.", path, agentKey);
            return null;
        }
    }

    /// <summary>
    /// The housekeeping ceiling: creating a session, deleting one, probing health, reading the index.
    /// </summary>
    private CancellationToken Timeout(CancellationToken ct)
    {
        var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(_options.TimeoutSeconds));
        return cts.Token;
    }

    /// <summary>
    /// How long one <b>turn</b> may take.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <see cref="HermesOptions.StreamTimeoutSeconds"/> — the same ceiling the streamed path runs
    /// under, because it is the same question. How long an agent may think about a household's
    /// question should not depend on which transport carried it.
    /// </para>
    /// <para>
    /// It used to be <see cref="HermesOptions.TimeoutSeconds"/>, which is the housekeeping figure and
    /// four times smaller. A spoken question that took a capable agent three minutes was cut off at
    /// two, and what the household heard was the canned failure line — the one case where nobody is
    /// even looking at a screen that could have said otherwise.
    /// </para>
    /// </remarks>
    private CancellationTokenSource TurnDeadline(CancellationToken ct)
    {
        var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(Math.Max(30, _options.StreamTimeoutSeconds)));
        return cts;
    }

    private static string? HeaderSessionId(HttpResponseMessage res) =>
        res.Headers.TryGetValues("X-Hermes-Session-Id", out var v)
            ? v.FirstOrDefault(x => !string.IsNullOrWhiteSpace(x))
            : null;

    private static TimeSpan RetryAfter(HttpResponseMessage res)
    {
        var after = res.Headers.RetryAfter;
        if (after?.Delta is { } delta) return delta;
        if (after?.Date is { } date && date - DateTimeOffset.UtcNow is { Ticks: > 0 } wait) return wait;
        return TimeSpan.FromSeconds(2);
    }

    private static string? ReadCreatedId(JsonElement root)
    {
        if (root.TryGetProperty("session", out var s) && s.TryGetProperty("id", out var nested)
            && nested.ValueKind is JsonValueKind.String)
            return nested.GetString();
        return root.TryGetProperty("id", out var direct) && direct.ValueKind is JsonValueKind.String
            ? direct.GetString() : null;
    }

    private static string? ReadModel(JsonElement root) =>
        root.TryGetProperty("model", out var v) && v.ValueKind is JsonValueKind.String ? v.GetString() : null;

    /// <summary>OpenAI-shaped completion text: `choices[0].message.content`.</summary>
    private static string ReadCompletionText(JsonElement root)
    {
        if (root.TryGetProperty("choices", out var choices) && choices.ValueKind is JsonValueKind.Array
            && choices.GetArrayLength() > 0)
        {
            var first = choices[0];
            if (first.TryGetProperty("message", out var msg) && msg.TryGetProperty("content", out var c)
                && c.ValueKind is JsonValueKind.String)
                return c.GetString()?.Trim() ?? "";
        }
        // Native session-chat shape, in case a deployment routes us there.
        if (root.TryGetProperty("message", out var m) && m.TryGetProperty("content", out var mc)
            && mc.ValueKind is JsonValueKind.String)
            return mc.GetString()?.Trim() ?? "";
        return "";
    }

    /// <summary>Streaming delta: `choices[0].delta.content`.</summary>
    private static string? ReadDelta(JsonElement root)
    {
        if (!root.TryGetProperty("choices", out var choices) || choices.ValueKind is not JsonValueKind.Array
            || choices.GetArrayLength() == 0)
            return null;

        var first = choices[0];
        if (first.TryGetProperty("delta", out var delta) && delta.TryGetProperty("content", out var c)
            && c.ValueKind is JsonValueKind.String)
            return c.GetString();
        return null;
    }
}

/// <summary>One part of a turn: text, or an inline image as a data URL.</summary>
/// <remarks>
/// HomeHub submits the image to the chosen agent and names nothing else. Whether that agent's model
/// can see it is Hermes's configuration to get right — routing an image to a vision-capable model is
/// exactly the decision that lives on the far side of this seam.
/// </remarks>
/// <summary>
/// One session row, as the index projects it — structure only, never content.
/// </summary>
/// <param name="Id">The session id.</param>
/// <param name="Source">Who created it. <c>homehub</c> is ours; anything else is somebody at the CLI.</param>
/// <param name="ParentSessionId">Set on compression children, forks and delegate children alike.</param>
/// <param name="LineageRootId">Hermes's own view of the lineage root, when it reports one.</param>
/// <param name="EndReason">Why this session ended. <c>compression</c> is what marks a legacy rotation.</param>
/// <param name="MessageCount">How much would be left behind if this row were missed.</param>
public sealed record HermesSessionSummary(
    string Id,
    string? Source,
    string? ParentSessionId,
    string? LineageRootId,
    string? EndReason,
    int? MessageCount);

/// <summary>One page of the session index, or the reason there isn't one.</summary>
/// <remarks>
/// <see cref="Error"/> and an empty <see cref="Sessions"/> are not the same state, and the lineage
/// report depends on the difference: "this agent holds no sessions" is a clean result, "this agent
/// did not answer" is not a result at all.
/// </remarks>
public sealed record HermesSessionPage(IReadOnlyList<HermesSessionSummary> Sessions, string? Error);

public sealed record HermesContent(string? Text, string? ImageDataUrl = null);

/// <summary>A reply, with the session Hermes reported it ran in.</summary>
public sealed record HermesReply(string Text, string? Model, string? EffectiveSessionId);

/// <summary>Which Hermes HTTP surface answered — they are not interchangeable.</summary>
public enum HermesSurface
{
    /// <summary>Nothing answered, or nothing answered with JSON.</summary>
    Unreachable,

    /// <summary>Something is there, but it identified as neither surface.</summary>
    Unknown,

    /// <summary>The administration dashboard. Different auth, different contracts. Not ours.</summary>
    Dashboard,

    /// <summary>The API-server gateway — the one HomeHub integrates with.</summary>
    ApiServer,
}

/// <summary>Hermes is at its concurrent-run cap. Wait rather than degrade — the agent is healthy.</summary>
public sealed class HermesBusyException(TimeSpan retryAfter)
    : Exception($"Hermes is busy; retry after {retryAfter.TotalSeconds:0.#}s.")
{
    public TimeSpan RetryAfter { get; } = retryAfter;
}

/// <summary>
/// Hermes rejected our credential. A configuration fault, not an outage.
/// </summary>
/// <remarks>
/// Carries the agent key and the status and nothing else — deliberately no response body, because an
/// auth failure is where a misconfigured deployment is most likely to reflect a credential back.
/// </remarks>
public sealed class HermesAuthException(string agentKey, HttpStatusCode status)
    : Exception($"Hermes rejected HomeHub's credential for agent '{agentKey}' ({(int)status}).")
{
    public string AgentKey { get; } = agentKey;
    public HttpStatusCode Status { get; } = status;
}
