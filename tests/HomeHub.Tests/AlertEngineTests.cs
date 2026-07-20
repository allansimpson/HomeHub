namespace HomeHub.Tests;

using HomeHub.Api.Alerts;
using HomeHub.Api.Data;
using HomeHub.Api.Sensors;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// Alert engine behaviour: the sustained-breach rule and raise/clear lifecycle. Uses an
/// in-memory database seeded with the default thresholds; the clock is passed in so tests are
/// deterministic and never wait on real durations. Zone 1 (Freezer) fires temp &gt; 10°F, severe,
/// sustained 10 minutes.
/// </summary>
public class AlertEngineTests
{
    private static HomeHubDbContext NewDb()
    {
        var options = new DbContextOptionsBuilder<HomeHubDbContext>()
            .UseInMemoryDatabase("alert-engine-" + Guid.NewGuid())
            .Options;
        var db = new HomeHubDbContext(options);
        db.Database.EnsureCreated(); // applies seeded zones + thresholds
        return db;
    }

    private static void AddReading(HomeHubDbContext db, int zoneId, DateTime tsUtc, double tempF, double humidity = 30)
        => db.SensorReadings.Add(new SensorReading { ZoneId = zoneId, TimestampUtc = tsUtc, TempF = tempF, Humidity = humidity });

    [Fact]
    public async Task Raises_alert_when_breach_is_sustained_past_the_duration()
    {
        using var db = NewDb();
        var now = new DateTime(2026, 7, 20, 12, 0, 0, DateTimeKind.Utc);
        // 15 minutes of freezer readings all above the 10°F ceiling (> the 10-minute duration).
        for (var m = 15; m >= 0; m--)
            AddReading(db, zoneId: 1, now.AddMinutes(-m), tempF: 15);
        await db.SaveChangesAsync();

        var open = await new AlertEngine().EvaluateAsync(db, now);

        Assert.Equal(1, open);
        var alert = await db.ActiveAlerts.SingleAsync(a => a.ClearedAtUtc == null);
        Assert.Equal(AlertSeverity.Severe, alert.Severity);
        Assert.Equal("sensor:1", alert.Source);
    }

    [Fact]
    public async Task Does_not_raise_before_the_duration_elapses()
    {
        using var db = NewDb();
        var now = new DateTime(2026, 7, 20, 12, 0, 0, DateTimeKind.Utc);
        // Only 5 minutes of breach — shorter than the 10-minute duration.
        for (var m = 5; m >= 0; m--)
            AddReading(db, zoneId: 1, now.AddMinutes(-m), tempF: 15);
        await db.SaveChangesAsync();

        var open = await new AlertEngine().EvaluateAsync(db, now);

        Assert.Equal(0, open);
    }

    [Fact]
    public async Task Clears_alert_once_the_condition_recovers()
    {
        using var db = NewDb();
        var engine = new AlertEngine();
        var start = new DateTime(2026, 7, 20, 12, 0, 0, DateTimeKind.Utc);
        for (var m = 15; m >= 0; m--)
            AddReading(db, zoneId: 1, start.AddMinutes(-m), tempF: 15);
        await db.SaveChangesAsync();
        Assert.Equal(1, await engine.EvaluateAsync(db, start));

        // A good reading arrives; the breach is over.
        var later = start.AddMinutes(1);
        AddReading(db, zoneId: 1, later, tempF: 4);
        await db.SaveChangesAsync();

        var open = await engine.EvaluateAsync(db, later);

        Assert.Equal(0, open);
        var alert = await db.ActiveAlerts.SingleAsync();
        Assert.NotNull(alert.ClearedAtUtc);
    }

    [Fact]
    public async Task Does_not_duplicate_an_already_open_alert()
    {
        using var db = NewDb();
        var engine = new AlertEngine();
        var now = new DateTime(2026, 7, 20, 12, 0, 0, DateTimeKind.Utc);
        for (var m = 15; m >= 0; m--)
            AddReading(db, zoneId: 1, now.AddMinutes(-m), tempF: 15);
        await db.SaveChangesAsync();

        await engine.EvaluateAsync(db, now);
        await engine.EvaluateAsync(db, now.AddMinutes(1));

        Assert.Equal(1, await db.ActiveAlerts.CountAsync());
    }
}
