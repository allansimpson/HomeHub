namespace HomeHub.Api.Alerts;

/// <summary>Which metric a threshold watches.</summary>
public enum AlertMetric
{
    Temperature = 0,
    Humidity = 1,
}

/// <summary>Whether the threshold fires when the value goes above or below <c>Value</c>.</summary>
public enum AlertDirection
{
    Above = 0,
    Below = 1,
}

/// <summary>
/// Alert severity. Severe adds the hazard-stripe banner treatment on the frontend. Ordered so
/// higher = worse, which the dashboard uses to pick the most important banner to show.
/// </summary>
public enum AlertSeverity
{
    Info = 0,
    Warning = 1,
    Severe = 2,
}

/// <summary>
/// One pass of the sensor alert engine: what is open, and what this pass newly raised.
/// </summary>
/// <remarks>
/// Two answers because two callers want different things. The panel wants the open set — the
/// conditions that are true right now. The notification queue wants only the transitions, because a
/// notification says "this happened at 7:41 PM" and stays until someone reads it; told the open set
/// every thirty seconds it would tell the household the same thing all evening.
/// </remarks>
public record SensorAlertPass(int OpenCount, IReadOnlyList<ActiveAlert> Raised);
