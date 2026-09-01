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

    /// <summary>
    /// Where to fetch the forecast for: the household's own answer, or the deployment's.
    /// </summary>
    /// <remarks>
    /// The household wins when it has said, because it said so more recently and from the room in
    /// question — see <see cref="Settings.HouseholdSettings.WeatherLatitude"/>. Both halves are
    /// required together: half a coordinate is not a location, and pairing a configured longitude
    /// with a household latitude would produce a forecast for somewhere neither of them named.
    /// </remarks>
    public static (double Latitude, double Longitude) LocationFor(
        Settings.HouseholdSettings? settings, WeatherOptions options) =>
        settings is { WeatherLatitude: { } lat, WeatherLongitude: { } lon }
            ? (lat, lon)
            : (options.Latitude, options.Longitude);

    public async Task RefreshAsync(HomeHubDbContext db, DateTime nowUtc, CancellationToken ct = default)
    {
        var settings = await db.Settings.AsNoTracking().FirstOrDefaultAsync(s => s.Id == 1, ct);
        var (latitude, longitude) = LocationFor(settings, _options);

        var weather = await _provider.GetWeatherAsync(latitude, longitude, ct);

        // Cache the forecast payload (alerts are stored separately via the engine).
        var snapshot = new WeatherSnapshotDto(
            weather.Current, weather.Hourly, weather.Daily, nowUtc, latitude, longitude, weather.Place);
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
                // The "Event: message" shape stays, because `alertHeadline` on the client still
                // reads a title out of it for any alert with no Event of its own.
                Message: $"{a.Event}: {a.Message}",
                Source: "weather",
                ExpiresAtUtc: a.ExpiresUtc,
                Event: a.Event,
                Detail: new AlertDetail(
                    Description: a.Description,
                    Instruction: a.Instruction,
                    AreaDesc: a.AreaDesc,
                    SenderName: a.SenderName,
                    SentUtc: a.SentUtc,
                    // ALERT_SHEET.md: IN EFFECT starts at `onset ?? effective`. NWS omits onset on
                    // products that are already in force when issued.
                    OnsetUtc: a.OnsetUtc ?? a.EffectiveUtc,
                    EndsUtc: a.EndsUtc,
                    Urgency: a.Urgency,
                    Certainty: a.Certainty,
                    SeverityText: a.SeverityText,
                    ProductId: a.Id)))
            .ToList();
        await _engine.ReconcileAsync(db, WeatherAlertType, external, nowUtc, ct);
    }
}
