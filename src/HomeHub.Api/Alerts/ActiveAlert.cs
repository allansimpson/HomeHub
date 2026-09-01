namespace HomeHub.Api.Alerts;

/// <summary>
/// A raised alert. Type-agnostic by design (type, severity, message, source, timing) so the
/// same table and frontend banner serve sensor thresholds now and weather / other sources
/// later. <see cref="DedupeKey"/> keeps one open row per underlying condition.
/// </summary>
public class ActiveAlert
{
    public int Id { get; set; }

    /// <summary>Category of alert, e.g. "sensor" (Stage 2) or "weather" (Stage 3).</summary>
    public required string Type { get; set; }

    /// <summary>Stable identity for the underlying condition (e.g. "threshold:12") so re-evaluation updates rather than duplicates.</summary>
    public required string DedupeKey { get; set; }

    public AlertSeverity Severity { get; set; }

    public required string Message { get; set; }

    /// <summary>Where it came from / where tapping the banner should route, e.g. "sensor:3".</summary>
    public required string Source { get; set; }

    public DateTime StartedAtUtc { get; set; }

    /// <summary>Set when the condition clears; null while active.</summary>
    public DateTime? ClearedAtUtc { get; set; }

    /// <summary>Optional hard expiry (e.g. an NWS alert's "expires"); treated as inactive once past.</summary>
    public DateTime? ExpiresAtUtc { get; set; }

    // ---- The product behind the banner (design_handoff_weather_alert/ALERT_SHEET.md §4) ----
    //
    // Stored rather than re-fetched: the sheet has to open instantly from a banner tap, and an
    // alert the household is reading about is exactly the moment the network is least trustworthy.
    // All nullable — a sensor-threshold alert fills none of them, and CAP itself makes most
    // optional (statements routinely carry no Instruction).

    /// <summary>CAP <c>event</c> — the product's name, e.g. "Severe Thunderstorm Warning".</summary>
    public string? Event { get; set; }

    /// <summary>CAP <c>description</c>, verbatim and uncapped. NWS's hard line wraps are preserved; the client reflows them.</summary>
    public string? Description { get; set; }

    /// <summary>CAP <c>instruction</c> — the call to action. Null for most statements and advisories.</summary>
    public string? Instruction { get; set; }

    /// <summary>CAP <c>areaDesc</c> — semicolon-separated county list.</summary>
    public string? AreaDesc { get; set; }

    /// <summary>CAP <c>senderName</c>, e.g. "NWS Minneapolis MN".</summary>
    public string? SenderName { get; set; }

    /// <summary>CAP <c>sent</c> — when the office issued it, which is not when we noticed it.</summary>
    public DateTime? SentUtc { get; set; }

    /// <summary>CAP <c>onset</c> ?? <c>effective</c> — the start of the IN EFFECT window.</summary>
    public DateTime? OnsetUtc { get; set; }

    /// <summary>CAP <c>ends</c> — the end of the IN EFFECT window, which can precede <see cref="ExpiresAtUtc"/>.</summary>
    public DateTime? EndsUtc { get; set; }

    /// <summary>CAP <c>urgency</c>, e.g. "Immediate".</summary>
    public string? Urgency { get; set; }

    /// <summary>CAP <c>certainty</c>, e.g. "Observed".</summary>
    public string? Certainty { get; set; }

    /// <summary>
    /// CAP <c>severity</c> as the word NWS used. <see cref="Severity"/> collapses Extreme and Severe
    /// into one banner treatment; the sheet still says which was issued.
    /// </summary>
    public string? SeverityText { get; set; }

    /// <summary>CAP <c>id</c> — shown in the provenance footer so the panel can be checked against weather.gov.</summary>
    public string? ProductId { get; set; }
}
