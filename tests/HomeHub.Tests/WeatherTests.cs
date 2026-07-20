namespace HomeHub.Tests;

using System.Net.Http.Json;
using System.Text.Json;
using HomeHub.Api.Alerts;
using HomeHub.Api.Data;
using HomeHub.Api.Weather;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

/// <summary>
/// Stage 3 weather: the refresher caches snapshots + folds NWS alerts into the shared engine,
/// and the controller serves the cached snapshot. Uses a fake provider so no network is touched.
/// </summary>
public class WeatherTests
{
    private sealed class FakeWeatherProvider : IWeatherProvider
    {
        private readonly ProviderWeather _weather;
        public FakeWeatherProvider(ProviderWeather weather) => _weather = weather;
        public Task<ProviderWeather> GetWeatherAsync(double lat, double lon, CancellationToken ct) =>
            Task.FromResult(_weather);
    }

    private static HomeHubDbContext NewDb()
    {
        var options = new DbContextOptionsBuilder<HomeHubDbContext>()
            .UseInMemoryDatabase("weather-" + Guid.NewGuid())
            .Options;
        var db = new HomeHubDbContext(options);
        db.Database.EnsureCreated();
        return db;
    }

    private static ProviderWeather SampleWeather(IReadOnlyList<ProviderWeatherAlert> alerts) => new(
        Current: new CurrentWeatherDto(72, "Sunny", 78, 60, 45, 8, null),
        Hourly: [new HourlyDto("8 PM", 70, "Clear"), new HourlyDto("9 PM", 68, "Clear")],
        Daily: [new DailyDto("TODAY", "Sunny", 78, 60, false), new DailyDto("MONDAY", "Severe Thunderstorms", 74, 66, true)],
        Alerts: alerts);

    [Fact]
    public async Task Refresher_caches_snapshot_and_raises_weather_alert()
    {
        using var db = NewDb();
        var now = DateTime.UtcNow;
        var alert = new ProviderWeatherAlert("urn:oid:1", "Severe Thunderstorm Warning", AlertSeverity.Severe, "Gusts to 60 mph", now.AddHours(2));
        var refresher = new WeatherRefresher(new FakeWeatherProvider(SampleWeather([alert])), new AlertEngine(), Options.Create(new WeatherOptions()));

        await refresher.RefreshAsync(db, now);

        var cache = await db.WeatherCache.SingleAsync();
        var snapshot = JsonSerializer.Deserialize<WeatherSnapshotDto>(cache.PayloadJson)!;
        Assert.Equal(72, snapshot.Current!.TempF);
        Assert.Equal(2, snapshot.Daily.Count);

        var raised = await db.ActiveAlerts.SingleAsync(a => a.Type == "weather" && a.ClearedAtUtc == null);
        Assert.Equal(AlertSeverity.Severe, raised.Severity);
        Assert.Equal("weather", raised.Source);
        Assert.NotNull(raised.ExpiresAtUtc);
    }

    [Fact]
    public async Task Refresher_clears_a_weather_alert_that_is_no_longer_active()
    {
        using var db = NewDb();
        var now = DateTime.UtcNow;
        var engine = new AlertEngine();
        var alert = new ProviderWeatherAlert("urn:oid:9", "Flood Watch", AlertSeverity.Warning, "Rivers rising", now.AddHours(3));

        await new WeatherRefresher(new FakeWeatherProvider(SampleWeather([alert])), engine, Options.Create(new WeatherOptions())).RefreshAsync(db, now);
        Assert.Equal(1, await db.ActiveAlerts.CountAsync(a => a.Type == "weather" && a.ClearedAtUtc == null));

        // Next refresh: no alerts active anymore → the open one clears.
        await new WeatherRefresher(new FakeWeatherProvider(SampleWeather([])), engine, Options.Create(new WeatherOptions())).RefreshAsync(db, now.AddMinutes(10));

        Assert.Equal(0, await db.ActiveAlerts.CountAsync(a => a.Type == "weather" && a.ClearedAtUtc == null));
    }

    [Fact]
    public async Task Weather_endpoint_serves_the_cached_snapshot()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var snapshot = new WeatherSnapshotDto(
            new CurrentWeatherDto(70, "Cloudy", 75, 58, 50, 6, null), [], [], DateTime.UtcNow);
        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
            db.WeatherCache.Add(new WeatherCache { Id = 1, PayloadJson = JsonSerializer.Serialize(snapshot), FetchedAtUtc = DateTime.UtcNow });
            db.SaveChanges();
        }

        var result = await client.GetFromJsonAsync<WeatherSnapshotDto>("/api/weather");

        Assert.NotNull(result);
        Assert.Equal(70, result!.Current!.TempF);
        Assert.Equal("Cloudy", result.Current.Condition);
    }

    [Fact]
    public async Task Weather_endpoint_is_empty_before_the_first_poll()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var result = await client.GetFromJsonAsync<WeatherSnapshotDto>("/api/weather");

        Assert.NotNull(result);
        Assert.Null(result!.Current);
    }

    [Fact]
    public async Task Expired_alerts_are_excluded_from_the_active_feed()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var now = DateTime.UtcNow;
        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
            db.ActiveAlerts.Add(new ActiveAlert { Type = "weather", DedupeKey = "nws:live", Severity = AlertSeverity.Severe, Message = "Live warning", Source = "weather", StartedAtUtc = now.AddHours(-1), ExpiresAtUtc = now.AddHours(1) });
            db.ActiveAlerts.Add(new ActiveAlert { Type = "weather", DedupeKey = "nws:stale", Severity = AlertSeverity.Warning, Message = "Old watch", Source = "weather", StartedAtUtc = now.AddHours(-3), ExpiresAtUtc = now.AddHours(-1) });
            db.SaveChanges();
        }

        var alerts = await client.GetFromJsonAsync<List<ActiveAlertDto>>("/api/alerts");

        Assert.Single(alerts!);
        Assert.Equal("Live warning", alerts![0].Message);
    }
}
