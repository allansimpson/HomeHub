namespace HomeHub.Tests;

using System.Net.Http.Json;
using HomeHub.Api.Alerts;
using HomeHub.Api.Data;
using HomeHub.Api.Sensors;
using Microsoft.Extensions.DependencyInjection;

/// <summary>
/// Sensor + alert read models and threshold config, exercised over HTTP against a seeded
/// in-memory database. Readings are inserted directly (the background poller doesn't run in
/// tests) so the endpoints have data to shape.
/// </summary>
public class SensorsApiTests
{
    private static void Seed(HubAppFactory app, Action<HomeHubDbContext> seed)
    {
        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
        seed(db);
        db.SaveChanges();
    }

    [Fact]
    public async Task Zones_lists_seeded_zones_with_latest_reading()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var now = DateTime.UtcNow;
        Seed(app, db =>
        {
            db.SensorReadings.Add(new SensorReading { ZoneId = 3, TimestampUtc = now.AddMinutes(-2), TempF = 71, Humidity = 44 });
            db.SensorReadings.Add(new SensorReading { ZoneId = 3, TimestampUtc = now, TempF = 72, Humidity = 45 });
        });

        var zones = await client.GetFromJsonAsync<List<ZoneReadingDto>>("/api/sensors/zones");

        Assert.NotNull(zones);
        Assert.Equal(5, zones!.Count);
        Assert.Equal(new[] { "Freezer", "Fridge", "Living Room", "Kitchen", "Bedroom" }, zones.Select(z => z.Name));
        var living = zones.Single(z => z.Id == 3);
        Assert.Equal(72, living.TempF);      // most-recent reading wins
        Assert.Equal(45, living.Humidity);
        Assert.Equal("FoodSafety", zones.Single(z => z.Id == 1).Category);
    }

    [Fact]
    public async Task History_returns_twelve_bars_and_current_reading()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var now = DateTime.UtcNow;
        Seed(app, db =>
        {
            for (var m = 120; m >= 0; m -= 10)
                db.SensorReadings.Add(new SensorReading { ZoneId = 3, TimestampUtc = now.AddMinutes(-m), TempF = 70 + m % 5, Humidity = 40 });
        });

        var history = await client.GetFromJsonAsync<ZoneHistoryDto>("/api/sensors/zones/3/history?hours=24");

        Assert.NotNull(history);
        Assert.Equal("Living Room", history!.Name);
        Assert.Equal(12, history.TempBars.Count);
        Assert.Equal(3, history.HumidityPeriods.Count);
        Assert.NotNull(history.CurrentTempF);
    }

    [Fact]
    public async Task History_404s_for_unknown_zone()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.GetAsync("/api/sensors/zones/999/history");

        Assert.Equal(System.Net.HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task Thresholds_list_and_update()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var thresholds = await client.GetFromJsonAsync<List<ThresholdDto>>("/api/alerts/thresholds");
        Assert.Equal(5, thresholds!.Count);
        Assert.Contains(thresholds, t => t is { ZoneName: "Freezer", Severity: "Severe" });

        var updated = await (await client.PutAsJsonAsync(
            "/api/alerts/thresholds/1",
            new UpdateThresholdRequest(5, 2, true)))
            .Content.ReadFromJsonAsync<ThresholdDto>();
        Assert.Equal(5, updated!.Value);
        Assert.Equal(2, updated.DurationMinutes);
    }

    [Fact]
    public async Task Sustained_breach_surfaces_through_the_alerts_endpoint()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var now = DateTime.UtcNow;
        Seed(app, db =>
        {
            // 15 minutes of freezer readings above the 10°F ceiling.
            for (var m = 15; m >= 0; m--)
                db.SensorReadings.Add(new SensorReading { ZoneId = 1, TimestampUtc = now.AddMinutes(-m), TempF = 18, Humidity = 30 });
        });

        // Editing the threshold re-runs the engine, which should raise the alert.
        await client.PutAsJsonAsync("/api/alerts/thresholds/1", new UpdateThresholdRequest(10, 10, true));

        var alerts = await client.GetFromJsonAsync<List<ActiveAlertDto>>("/api/alerts");

        Assert.NotNull(alerts);
        Assert.Contains(alerts!, a => a is { Source: "sensor:1", Severity: "Severe" });
    }
}
