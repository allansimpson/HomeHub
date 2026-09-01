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

/// <summary>
/// Where the forecast is for, in the household's own words.
/// </summary>
/// <remarks>
/// <b>Reported, never configured.</b> This comes back from NWS's own point lookup — its nearest named
/// place to the coordinates and the state it is in — and is not something anybody types. That is the
/// point of it: a household that has set a latitude and longitude has no way to check they got the
/// digits right, and "44.98, -93.27" on a wall panel confirms nothing. A city name does, and it is the
/// forecast provider's own answer to "where do you think this is", which is the only answer that
/// matters when the numbers are wrong.
/// <para>
/// Null when NWS did not supply one — its <c>relativeLocation</c> is optional, and a point far from
/// anywhere legitimately has none. The screens fall back to saying nothing rather than to the
/// coordinates.
/// </para>
/// </remarks>
/// <param name="City">The nearest named place, e.g. "Minneapolis".</param>
/// <param name="State">Its two-letter state abbreviation, e.g. "MN".</param>
public record PlaceDto(string City, string? State)
{
    /// <summary>`Minneapolis, MN` — or just the city where NWS gave no state.</summary>
    public string Label => string.IsNullOrWhiteSpace(State) ? City : $"{City}, {State}";
}

/// <summary>The cached weather payload served to the client (alerts flow through the alert engine).</summary>
public record WeatherSnapshotDto(
    CurrentWeatherDto? Current,
    IReadOnlyList<HourlyDto> Hourly,
    IReadOnlyList<DailyDto> Daily,
    DateTime? FetchedAtUtc,
    double? Latitude = null,
    double? Longitude = null,
    PlaceDto? Place = null)
{
    public static WeatherSnapshotDto Empty => new(null, [], [], null);
}

/// <summary>A weather alert as surfaced by a provider, before it enters the alert engine.</summary>
/// <remarks>
/// The trailing block is the CAP (Common Alerting Protocol) product as NWS publishes it, carried
/// whole so the statement sheet can show what the banner only names — see
/// <c>design_handoff_weather_alert/ALERT_SHEET.md</c> §4. Every one of them is optional because
/// CAP says so: a Special Weather Statement routinely has no <see cref="Instruction"/>, and a
/// non-NWS provider implementing this seam may supply none of them at all. The sheet omits whole
/// sections rather than printing placeholders, so null here means "no row" downstream.
/// </remarks>
/// <param name="Message">
/// The one-line banner detail — CAP <c>headline</c>, falling back to the description. Stays short
/// on purpose: it is a banner line, not the product. <see cref="Description"/> holds the full text.
/// </param>
public record ProviderWeatherAlert(
    string Id,
    string Event,
    AlertSeverity Severity,
    string Message,
    DateTime? ExpiresUtc,
    string? Description = null,
    string? Instruction = null,
    string? AreaDesc = null,
    string? SenderName = null,
    DateTime? SentUtc = null,
    DateTime? OnsetUtc = null,
    DateTime? EffectiveUtc = null,
    DateTime? EndsUtc = null,
    string? Urgency = null,
    string? Certainty = null,
    string? SeverityText = null);

/// <summary>Everything a weather provider returns for one refresh: forecast data + active alerts.</summary>
/// <param name="Place">
/// Where the provider thinks these coordinates are. Null when it does not say — see
/// <see cref="PlaceDto"/>. Trailing and optional so a provider that cannot name a location is still a
/// complete implementation of the seam.
/// </param>
public record ProviderWeather(
    CurrentWeatherDto Current,
    IReadOnlyList<HourlyDto> Hourly,
    IReadOnlyList<DailyDto> Daily,
    IReadOnlyList<ProviderWeatherAlert> Alerts,
    PlaceDto? Place = null);
