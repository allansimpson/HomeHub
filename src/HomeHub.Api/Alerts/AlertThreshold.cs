namespace HomeHub.Api.Alerts;

using HomeHub.Api.Sensors;

/// <summary>
/// A configurable rule the alert engine evaluates: "metric direction value, sustained for
/// durationMinutes". Bound to a zone. The Settings screen edits these; the engine is the only
/// consumer, so weather (Stage 3) and future sensors reuse the same engine without new rules.
/// </summary>
public class AlertThreshold
{
    public int Id { get; set; }

    public int ZoneId { get; set; }
    public SensorZone? Zone { get; set; }

    public AlertMetric Metric { get; set; }
    public AlertDirection Direction { get; set; }

    /// <summary>Threshold value (°F for temperature, % for humidity).</summary>
    public double Value { get; set; }

    /// <summary>The breach must persist this many minutes before an alert is raised.</summary>
    public int DurationMinutes { get; set; }

    public AlertSeverity Severity { get; set; }

    /// <summary>Lets a rule be turned off without deleting it.</summary>
    public bool Enabled { get; set; } = true;
}
