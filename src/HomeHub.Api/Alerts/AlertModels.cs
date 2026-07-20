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
