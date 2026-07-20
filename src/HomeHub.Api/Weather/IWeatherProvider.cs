namespace HomeHub.Api.Weather;

/// <summary>
/// The weather seam: fetch current + forecast + active alerts for a location. UI/logic depend on
/// this, not on NWS. A fake implementation backs the tests; <see cref="NwsWeatherProvider"/> is
/// the real one.
/// </summary>
public interface IWeatherProvider
{
    Task<ProviderWeather> GetWeatherAsync(double latitude, double longitude, CancellationToken ct);
}
