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

/// <summary>One hourly period. <see cref="DayKey"/> (local yyyy-MM-dd) groups hours into Day Detail;
/// <see cref="Pop"/> is precip probability %, <see cref="WindMph"/> the wind speed.</summary>
public record HourlyDto(string Label, double? TempF, string? ShortForecast, string? DayKey = null, int? Pop = null, double? WindMph = null);

/// <summary>One "week ahead" daily row. Severe days carry the amber condition label. <see cref="DayKey"/>
/// (local yyyy-MM-dd) links a row to its hourly periods for the tap-through Day Detail.</summary>
public record DailyDto(string Day, string Condition, double? HighF, double? LowF, bool Severe, string? DayKey = null);

/// <summary>The cached weather payload served to the client (alerts flow through the alert engine).</summary>
public record WeatherSnapshotDto(
    CurrentWeatherDto? Current,
    IReadOnlyList<HourlyDto> Hourly,
    IReadOnlyList<DailyDto> Daily,
    DateTime? FetchedAtUtc,
    double? Latitude = null,
    double? Longitude = null)
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
