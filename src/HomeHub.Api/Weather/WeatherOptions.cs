namespace HomeHub.Api.Weather;

using HomeHub.Api.Net;

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

    /// <summary>Hosts permitted to receive the household's coordinates.</summary>
    /// <remarks>
    /// No credential travels here, which is why it was easy to overlook and is not a reason to leave
    /// it unguarded: the request says where this house is, and the reply is what the panel then
    /// announces out loud. Empty means the NWS's own host.
    /// </remarks>
    public List<string> AllowedHosts { get; set; } = [];

    /// <summary>The rule for the weather service, shared by startup and the request path.</summary>
    public EgressRule Rule => EgressRule.Internet(
        "Weather:BaseUrl", AllowedHosts.Count > 0 ? AllowedHosts : ["api.weather.gov"]);
}
