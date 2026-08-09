namespace HomeHub.Api.Weather;

/// <summary>
/// Weather + NWS configuration, bound from the <c>Weather</c> section. Defaults to a real,
/// NWS-covered placeholder location (Minneapolis, MN); set <see cref="Latitude"/>/<see
/// cref="Longitude"/> to the household's real location. NWS needs no API key but requires an
/// identifying <see cref="UserAgent"/>.
/// </summary>
public sealed class WeatherOptions
{
    public const string Section = "Weather";

    public double Latitude { get; set; } = 44.98;
    public double Longitude { get; set; } = -93.27;

    /// <summary>Identifies this app to NWS (they require a real contact). Change if desired.</summary>
    public string UserAgent { get; set; } = "HomeHub/1.0 (allansimpson@outlook.com)";

    /// <summary>Base URL of the NWS API (overridable for testing).</summary>
    public string BaseUrl { get; set; } = "https://api.weather.gov";

    /// <summary>How often to refresh weather + alerts.</summary>
    public int PollMinutes { get; set; } = 10;
}
