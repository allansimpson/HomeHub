namespace HomeHub.Api.HomeAssistant;

using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;

/// <summary>
/// The one Home Assistant client. Owns base URL, bearer auth, timeouts and the REST shapes; every
/// HA-backed provider (climate, Huckleberry, and later the scale) goes through it so there is a
/// single place where "how we talk to HA" lives. Extracted in Stage H2 from the Stage 6 climate
/// provider, which had this plumbing inline.
/// </summary>
/// <remarks>
/// Deliberately thin and domain-free: it returns raw <see cref="HaState"/> values, and mapping to
/// domain types stays in the provider that owns that domain. It does not swallow exceptions —
/// callers decide what a failure means (climate serves its cached table, Huckleberry serves its
/// last-known snapshot with a stale flag).
/// </remarks>
public sealed class HomeAssistantClient
{
    private readonly HttpClient _http;
    private readonly HomeAssistantOptions _options;

    public HomeAssistantClient(HttpClient http, IOptions<HomeAssistantOptions> options)
    {
        _http = http;
        _options = options.Value;

        if (_options.IsConfigured)
        {
            _http.BaseAddress = new Uri(_options.BaseUrl!.TrimEnd('/') + "/");
            _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _options.Token);
            _http.Timeout = TimeSpan.FromSeconds(Math.Max(1, _options.TimeoutSeconds));
        }
    }

    public bool IsConfigured => _options.IsConfigured;

    /// <summary>
    /// Runs one HA call, turning the client's own timeout into something that says so.
    /// </summary>
    /// <remarks>
    /// <see cref="HttpClient"/> reports a timeout as <see cref="TaskCanceledException"/> — the same
    /// type it throws when the caller genuinely cancels. Those mean opposite things: "Home Assistant
    /// is not answering" versus "nobody is waiting for this any more". Told apart only by whether the
    /// caller's token is signalled, and reported identically as "A task was canceled", the pair sent
    /// us hunting through HA, then SQL Server, then Microsoft Graph for a problem that was none of
    /// them.
    ///
    /// <para>A real cancellation still surfaces as <see cref="OperationCanceledException"/>, so the
    /// <c>when (ct.IsCancellationRequested)</c> guards in the providers keep working unchanged.</para>
    /// </remarks>
    private async Task<T> CallAsync<T>(string what, Func<Task<T>> call, CancellationToken ct)
    {
        try
        {
            return await call();
        }
        catch (TaskCanceledException ex) when (!ct.IsCancellationRequested)
        {
            throw new TimeoutException(
                $"Home Assistant did not answer {what} within {_http.Timeout.TotalSeconds:0}s.", ex);
        }
    }

    /// <summary>All entity states.</summary>
    public Task<IReadOnlyList<HaState>> GetStatesAsync(CancellationToken ct)
    {
        EnsureConfigured();
        return CallAsync<IReadOnlyList<HaState>>(
            "api/states",
            async () => await _http.GetFromJsonAsync<List<HaState>>("api/states", ct) ?? [],
            ct);
    }

    /// <summary>States whose entity id starts with <paramref name="entityIdPrefix"/> (e.g. <c>climate.</c>).</summary>
    public async Task<IReadOnlyList<HaState>> GetStatesAsync(string entityIdPrefix, CancellationToken ct)
    {
        var all = await GetStatesAsync(ct);
        return all.Where(s => s.EntityId?.StartsWith(entityIdPrefix, StringComparison.Ordinal) == true).ToList();
    }

    /// <summary>A single entity's state, or null when HA doesn't know it (404).</summary>
    public async Task<HaState?> GetStateAsync(string entityId, CancellationToken ct)
    {
        EnsureConfigured();
        using var res = await _http.GetAsync($"api/states/{entityId}", ct);
        if (res.StatusCode == System.Net.HttpStatusCode.NotFound) return null;
        res.EnsureSuccessStatusCode();
        return await res.Content.ReadFromJsonAsync<HaState>(ct);
    }

    /// <summary>
    /// Recorded state changes for one or more entities over a window, newest series per entity.
    /// </summary>
    /// <remarks>
    /// Home Assistant's recorder is the only history HomeHub has for entities it doesn't persist
    /// itself, and it is finite: the default purge keeps <b>10 days</b>. A caller asking for 30 or 90
    /// gets whatever survives, so check the oldest sample you got back before presenting the window as
    /// complete — a short series drawn as a full one is a lie about how the box has been doing.
    ///
    /// <para><c>minimal_response</c> keeps attributes off every sample but the first, which is what
    /// makes a multi-day pull over several sensors affordable on a wall panel.</para>
    /// </remarks>
    public async Task<IReadOnlyList<IReadOnlyList<HaState>>> GetHistoryAsync(
        IEnumerable<string> entityIds, DateTimeOffset from, DateTimeOffset to, CancellationToken ct)
    {
        EnsureConfigured();
        var filter = string.Join(",", entityIds);
        if (filter.Length == 0) return [];

        var url = $"api/history/period/{Uri.EscapeDataString(from.UtcDateTime.ToString("o"))}"
            + $"?filter_entity_id={Uri.EscapeDataString(filter)}"
            + $"&end_time={Uri.EscapeDataString(to.UtcDateTime.ToString("o"))}"
            + "&minimal_response&no_attributes";

        return await CallAsync<IReadOnlyList<IReadOnlyList<HaState>>>(
            "the recorder history",
            async () => await _http.GetFromJsonAsync<List<List<HaState>>>(url, ct) ?? [],
            ct);
    }

    /// <summary>Call an HA service, e.g. <c>CallServiceAsync("climate", "set_temperature", payload, ct)</c>.</summary>
    public async Task CallServiceAsync(string domain, string service, object payload, CancellationToken ct)
    {
        EnsureConfigured();
        using var res = await _http.PostAsJsonAsync($"api/services/{domain}/{service}", payload, ct);
        res.EnsureSuccessStatusCode();
    }

    /// <summary>
    /// Calendar entity events over a window. Huckleberry exposes a child's whole history through
    /// <c>calendar.{child}_events</c>; whether those payloads are structured enough for a history
    /// drill-in is Gate H0.3 and is judged by the caller, not here.
    /// </summary>
    public Task<IReadOnlyList<HaCalendarEvent>> GetCalendarEventsAsync(
        string entityId, DateTimeOffset start, DateTimeOffset end, CancellationToken ct)
    {
        EnsureConfigured();
        var from = Uri.EscapeDataString(start.UtcDateTime.ToString("s") + "Z");
        var to = Uri.EscapeDataString(end.UtcDateTime.ToString("s") + "Z");
        var url = $"api/calendars/{entityId}?start={from}&end={to}";
        return CallAsync<IReadOnlyList<HaCalendarEvent>>(
            url,
            async () => await _http.GetFromJsonAsync<List<HaCalendarEvent>>(url, ct) ?? [],
            ct);
    }

    /// <summary>
    /// Renders a Jinja template server-side and returns the result as plain text.
    /// </summary>
    /// <remarks>
    /// The reason this exists: HA's REST API exposes no device registry, but Huckleberry's services
    /// all target <c>device_id</c>. <c>{{ device_id('sensor.x') }}</c> resolves it over plain REST,
    /// avoiding a WebSocket client purely to look up an id. Returns null when the template renders
    /// empty or <c>None</c> (HA's answer for "no match").
    /// </remarks>
    public async Task<string?> RenderTemplateAsync(string template, CancellationToken ct)
    {
        EnsureConfigured();
        using var res = await _http.PostAsJsonAsync("api/template", new { template }, ct);
        res.EnsureSuccessStatusCode();
        var rendered = (await res.Content.ReadAsStringAsync(ct)).Trim();
        return rendered.Length == 0 || rendered is "None" or "none" ? null : rendered;
    }

    /// <summary>Cheap reachability probe against HA's API root. False on any failure.</summary>
    public async Task<bool> PingAsync(CancellationToken ct)
    {
        if (!IsConfigured) return false;
        try
        {
            using var res = await _http.GetAsync("api/", ct);
            return res.IsSuccessStatusCode;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch { return false; }
    }

    private void EnsureConfigured()
    {
        if (!IsConfigured)
            throw new InvalidOperationException("Home Assistant is not configured (HomeAssistant:BaseUrl / :Token).");
    }
}

/// <summary>
/// An HA entity state. Attributes stay as raw JSON because they are entity-specific and, for
/// Huckleberry, unverified until Gate H0.2 — typed accessors below read them defensively so an
/// attribute that is missing or renamed upstream degrades to null instead of throwing.
/// </summary>
public sealed record HaState(
    [property: JsonPropertyName("entity_id")] string? EntityId,
    [property: JsonPropertyName("state")] string? State,
    [property: JsonPropertyName("attributes")] JsonElement Attributes,
    [property: JsonPropertyName("last_changed")] DateTimeOffset? LastChanged,
    // `last_changed` only moves when the *value* changes; `last_updated` also moves on an
    // attribute-only refresh, so it is the better "we heard from this device" signal. Optional
    // because history under `minimal_response` omits both.
    [property: JsonPropertyName("last_updated")] DateTimeOffset? LastUpdated = null)
{
    /// <summary>HA's convention for "this entity has no meaningful value right now".</summary>
    public bool IsUnavailable =>
        State is null or "unknown" or "unavailable" or "None" or "none";

    public string? GetString(string name) =>
        TryGet(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    public double? GetDouble(string name) =>
        TryGet(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var d) ? d : null;

    public int? GetInt(string name) =>
        TryGet(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i) ? i : null;

    public bool? GetBool(string name) => TryGet(name, out var v)
        ? v.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            // HA sometimes stringifies booleans in templated attributes.
            JsonValueKind.String => bool.TryParse(v.GetString(), out var b) ? b : null,
            _ => (bool?)null,
        }
        : null;

    /// <summary>Timestamp attribute; HA emits ISO-8601 strings, occasionally with a local offset.</summary>
    public DateTimeOffset? GetDateTime(string name) =>
        TryGet(name, out var v) && v.ValueKind == JsonValueKind.String
        && DateTimeOffset.TryParse(v.GetString(), out var parsed) ? parsed : null;

    /// <summary>
    /// ISO-8601 duration attribute (e.g. <c>PT16M12S</c>), as published by Huckleberry's timer
    /// sensors. Returns null on anything unparseable rather than throwing.
    /// </summary>
    public TimeSpan? GetIso8601Duration(string name)
    {
        if (!TryGet(name, out var v) || v.ValueKind != JsonValueKind.String) return null;
        var raw = v.GetString();
        if (string.IsNullOrWhiteSpace(raw)) return null;
        try { return System.Xml.XmlConvert.ToTimeSpan(raw); }
        catch (FormatException) { return null; }
    }

    /// <summary>The raw JSON of an array attribute, for callers that need to walk its objects.</summary>
    public JsonElement? GetArray(string name) =>
        TryGet(name, out var v) && v.ValueKind == JsonValueKind.Array ? v : null;

    public string? FriendlyName => GetString("friendly_name");

    private bool TryGet(string name, out JsonElement value)
    {
        value = default;
        return Attributes.ValueKind == JsonValueKind.Object
            && Attributes.TryGetProperty(name, out value);
    }
}

/// <summary>Home Assistant entity-id conventions.</summary>
public static class HaEntityId
{
    /// <summary>
    /// Mirrors Home Assistant's slugification, which is how a friendly name becomes part of an
    /// entity id ("Conrad" → <c>sensor.conrad_sleep</c>, "Mary Jane" → <c>mary_jane</c>).
    /// Non-alphanumeric runs collapse to a single underscore; leading/trailing underscores are dropped.
    /// </summary>
    public static string Slugify(string name)
    {
        var result = new System.Text.StringBuilder(name.Length);
        foreach (var raw in name.ToLowerInvariant())
        {
            var c = char.IsAsciiLetterOrDigit(raw) ? raw : '_';
            if (c == '_' && (result.Length == 0 || result[^1] == '_')) continue;
            result.Append(c);
        }
        return result.ToString().Trim('_');
    }
}

/// <summary>An event from HA's calendar REST API.</summary>
public sealed record HaCalendarEvent(
    [property: JsonPropertyName("summary")] string? Summary,
    [property: JsonPropertyName("description")] string? Description,
    [property: JsonPropertyName("start")] HaCalendarTime? Start,
    [property: JsonPropertyName("end")] HaCalendarTime? End);

/// <summary>HA calendar times are either a timed <c>dateTime</c> or an all-day <c>date</c>.</summary>
public sealed record HaCalendarTime(
    [property: JsonPropertyName("dateTime")] DateTimeOffset? DateTime,
    [property: JsonPropertyName("date")] DateOnly? Date)
{
    public DateTimeOffset? Value => DateTime ?? (Date.HasValue
        ? new DateTimeOffset(Date.Value.ToDateTime(TimeOnly.MinValue), TimeSpan.Zero)
        : null);
}
