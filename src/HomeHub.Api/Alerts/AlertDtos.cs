namespace HomeHub.Api.Alerts;

/// <summary>An active (uncleared) alert for the banner.</summary>
public record ActiveAlertDto(
    int Id,
    string Type,
    string Severity,
    string Message,
    string Source,
    DateTime StartedAtUtc)
{
    public static ActiveAlertDto From(ActiveAlert a) =>
        new(a.Id, a.Type, a.Severity.ToString(), a.Message, a.Source, a.StartedAtUtc);
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
