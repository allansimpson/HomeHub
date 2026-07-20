namespace HomeHub.Api.Weather;

using System.Text.Json;
using HomeHub.Api.Alerts;
using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

/// <summary>
/// One weather refresh: fetch via the provider, cache the snapshot in SQL, and map NWS alerts
/// into the shared alert engine (type=weather). Factored out of the background service so it can
/// be unit-tested with a fake provider. Failures propagate to the caller, which logs and retries.
/// </summary>
public sealed class WeatherRefresher
{
    private const string WeatherAlertType = "weather";

    private readonly IWeatherProvider _provider;
    private readonly AlertEngine _engine;
    private readonly WeatherOptions _options;

    public WeatherRefresher(IWeatherProvider provider, AlertEngine engine, IOptions<WeatherOptions> options)
    {
        _provider = provider;
        _engine = engine;
        _options = options.Value;
    }

    public async Task RefreshAsync(HomeHubDbContext db, DateTime nowUtc, CancellationToken ct = default)
    {
        var weather = await _provider.GetWeatherAsync(_options.Latitude, _options.Longitude, ct);

        // Cache the forecast payload (alerts are stored separately via the engine).
        var snapshot = new WeatherSnapshotDto(weather.Current, weather.Hourly, weather.Daily, nowUtc);
        var payload = JsonSerializer.Serialize(snapshot);

        var cache = await db.WeatherCache.FirstOrDefaultAsync(c => c.Id == 1, ct);
        if (cache is null)
        {
            db.WeatherCache.Add(new WeatherCache { Id = 1, PayloadJson = payload, FetchedAtUtc = nowUtc });
        }
        else
        {
            cache.PayloadJson = payload;
            cache.FetchedAtUtc = nowUtc;
        }
        await db.SaveChangesAsync(ct);

        // Fold NWS alerts into the shared engine → same banner as sensor alerts.
        var external = weather.Alerts
            .Select(a => new ExternalAlert(
                DedupeKey: $"nws:{a.Id}",
                Severity: a.Severity,
                Message: $"{a.Event}: {a.Message}",
                Source: "weather",
                ExpiresAtUtc: a.ExpiresUtc))
            .ToList();
        await _engine.ReconcileAsync(db, WeatherAlertType, external, nowUtc, ct);
    }
}
