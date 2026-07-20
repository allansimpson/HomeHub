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
}
