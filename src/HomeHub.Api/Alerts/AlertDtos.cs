namespace HomeHub.Api.Alerts;

/// <summary>An active (uncleared) alert for the banner, and the product the sheet reads from.</summary>
/// <remarks>
/// The trailing block is null for anything that is only ever a banner line (sensor thresholds). The
/// client tests <c>event</c> to decide whether a statement sheet exists to open at all — see
/// <c>design_handoff_weather_alert/ALERT_SHEET.md</c> §4.
/// </remarks>
public record ActiveAlertDto(
    int Id,
    string Type,
    string Severity,
    string Message,
    string Source,
    DateTime StartedAtUtc,
    DateTime? ExpiresAtUtc = null,
    string? Event = null,
    string? Description = null,
    string? Instruction = null,
    string? AreaDesc = null,
    string? SenderName = null,
    DateTime? SentUtc = null,
    DateTime? OnsetUtc = null,
    DateTime? EndsUtc = null,
    string? Urgency = null,
    string? Certainty = null,
    string? SeverityText = null,
    string? ProductId = null)
{
    public static ActiveAlertDto From(ActiveAlert a) =>
        new(a.Id, a.Type, a.Severity.ToString(), a.Message, a.Source, a.StartedAtUtc,
            a.ExpiresAtUtc, a.Event, a.Description, a.Instruction, a.AreaDesc, a.SenderName,
            a.SentUtc, a.OnsetUtc, a.EndsUtc, a.Urgency, a.Certainty, a.SeverityText, a.ProductId);
}

/// <summary>A configurable threshold row for the Settings alert-threshold editors.</summary>
public record ThresholdDto(
    int Id,
    int ZoneId,
    string ZoneName,
    string Metric,
    string Direction,
    double Value,
    int DurationMinutes,
    string Severity,
    bool Enabled)
{
    public static ThresholdDto From(AlertThreshold t) => new(
        t.Id, t.ZoneId, t.Zone?.Name ?? $"Zone {t.ZoneId}",
        t.Metric.ToString(), t.Direction.ToString(), t.Value, t.DurationMinutes,
        t.Severity.ToString(), t.Enabled);
}

/// <summary>Editable fields of a threshold (metric/direction/zone are fixed once seeded).</summary>
public record UpdateThresholdRequest(double Value, int DurationMinutes, bool Enabled);
