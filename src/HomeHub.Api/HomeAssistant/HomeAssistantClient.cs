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

    /// <summary>All entity states.</summary>
    public async Task<IReadOnlyList<HaState>> GetStatesAsync(CancellationToken ct)
    {
        EnsureConfigured();
        return await _http.GetFromJsonAsync<List<HaState>>("api/states", ct) ?? [];
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
    public async Task<IReadOnlyList<HaCalendarEvent>> GetCalendarEventsAsync(
        string entityId, DateTimeOffset start, DateTimeOffset end, CancellationToken ct)
    {
        EnsureConfigured();
        var from = Uri.EscapeDataString(start.UtcDateTime.ToString("s") + "Z");
        var to = Uri.EscapeDataString(end.UtcDateTime.ToString("s") + "Z");
        var url = $"api/calendars/{entityId}?start={from}&end={to}";
        return await _http.GetFromJsonAsync<List<HaCalendarEvent>>(url, ct) ?? [];
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
    [property: JsonPropertyName("last_changed")] DateTimeOffset? LastChanged)
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
