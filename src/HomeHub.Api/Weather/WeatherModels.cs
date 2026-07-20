namespace HomeHub.Api.Weather;

using HomeHub.Api.Alerts;

/// <summary>Current conditions for the dashboard header and the Weather screen.</summary>
public record CurrentWeatherDto(
    double? TempF,
    string? Condition,
    double? HighF,
    double? LowF,
    double? Humidity,
    double? WindMph,
    double? FeelsLikeF);

/// <summary>One hourly-strip column.</summary>
public record HourlyDto(string Label, double? TempF, string? ShortForecast);

/// <summary>One "week ahead" daily row. Severe days carry the amber condition label.</summary>
public record DailyDto(string Day, string Condition, double? HighF, double? LowF, bool Severe);

/// <summary>The cached weather payload served to the client (alerts flow through the alert engine).</summary>
public record WeatherSnapshotDto(
    CurrentWeatherDto? Current,
    IReadOnlyList<HourlyDto> Hourly,
    IReadOnlyList<DailyDto> Daily,
    DateTime? FetchedAtUtc)
{
    public static WeatherSnapshotDto Empty => new(null, [], [], null);
}

/// <summary>A weather alert as surfaced by a provider, before it enters the alert engine.</summary>
public record ProviderWeatherAlert(
    string Id,
    string Event,
    AlertSeverity Severity,
    string Message,
    DateTime? ExpiresUtc);

/// <summary>Everything a weather provider returns for one refresh: forecast data + active alerts.</summary>
public record ProviderWeather(
    CurrentWeatherDto Current,
    IReadOnlyList<HourlyDto> Hourly,
    IReadOnlyList<DailyDto> Daily,
    IReadOnlyList<ProviderWeatherAlert> Alerts);
