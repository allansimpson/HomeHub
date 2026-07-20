namespace HomeHub.Api.Sensors;

using HomeHub.Api.Alerts;
using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// Polls the active <see cref="ISensorProvider"/> on an interval and writes every reading to
/// SQL, giving the app unlimited owned history. After each poll it runs the alert engine.
/// Resilient: a failing poll is logged and retried next tick, never crashing the host. Only
/// registered when a database is configured (see Program.cs).
/// </summary>
public sealed class SensorPollingService : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IConfiguration _config;
    private readonly ILogger<SensorPollingService> _logger;

    public SensorPollingService(
        IServiceScopeFactory scopeFactory,
        IConfiguration config,
        ILogger<SensorPollingService> logger)
    {
        _scopeFactory = scopeFactory;
        _config = config;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var pollSeconds = Math.Max(10, _config.GetValue("Sensors:PollSeconds", 60));
        var interval = TimeSpan.FromSeconds(pollSeconds);
        _logger.LogInformation("Sensor poller started; interval {Seconds}s.", pollSeconds);

        using var timer = new PeriodicTimer(interval);
        do
        {
            try
            {
                await PollOnceAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                // Transient provider/DB failure — log and keep the panel alive; retry next tick.
                _logger.LogError(ex, "Sensor poll failed; will retry.");
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    private async Task PollOnceAsync(CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
        var provider = scope.ServiceProvider.GetRequiredService<ISensorProvider>();
        var engine = scope.ServiceProvider.GetRequiredService<AlertEngine>();
        var now = DateTime.UtcNow;

        // 1. Discover zones and upsert any new ones from this provider.
        var providerZones = await provider.GetZonesAsync(ct);
        await UpsertZonesAsync(db, provider.Source, providerZones, ct);

        var zones = await db.SensorZones.Where(z => z.Source == provider.Source).ToListAsync(ct);
        if (zones.Count == 0) return;

        // 2. One-time history backfill so charts are meaningful immediately.
        if (provider is ISensorHistoryBackfill backfill)
            await BackfillEmptyZonesAsync(db, backfill, zones, now, ct);

        // 3. Fetch + store the latest reading for each zone.
        var refs = zones.Select(z => z.ProviderRef).ToList();
        var readings = await provider.GetLatestReadingsAsync(refs, ct);
        var zonesByRef = zones.ToDictionary(z => z.ProviderRef);
        foreach (var reading in readings)
        {
            if (!zonesByRef.TryGetValue(reading.ProviderRef, out var zone)) continue;
            var exists = await db.SensorReadings
                .AnyAsync(r => r.ZoneId == zone.Id && r.TimestampUtc == reading.TimestampUtc, ct);
            if (exists) continue;
            db.SensorReadings.Add(new SensorReading
            {
                ZoneId = zone.Id,
                TimestampUtc = reading.TimestampUtc,
                TempF = reading.TempF,
                Humidity = reading.Humidity,
            });
        }
        await db.SaveChangesAsync(ct);

        // 4. Reconcile alerts against the fresh readings.
        await engine.EvaluateAsync(db, now, ct);
    }

    private static async Task UpsertZonesAsync(
        HomeHubDbContext db, string source, IReadOnlyList<ProviderZone> providerZones, CancellationToken ct)
    {
        var existing = await db.SensorZones
            .Where(z => z.Source == source)
            .Select(z => z.ProviderRef)
            .ToListAsync(ct);
        var known = existing.ToHashSet();

        var order = existing.Count;
        foreach (var pz in providerZones)
        {
            if (known.Contains(pz.ProviderRef)) continue;
            db.SensorZones.Add(new SensorZone
            {
                Name = pz.Name,
                Source = source,
                ProviderRef = pz.ProviderRef,
                Category = SensorCategory.Ambient,
                DisplayOrder = order++,
            });
        }
        if (db.ChangeTracker.HasChanges()) await db.SaveChangesAsync(ct);
    }

    private static async Task BackfillEmptyZonesAsync(
        HomeHubDbContext db, ISensorHistoryBackfill backfill, List<SensorZone> zones, DateTime now, CancellationToken ct)
    {
        var dayAgo = now.AddHours(-24);
        foreach (var zone in zones)
        {
            var hasRecent = await db.SensorReadings.AnyAsync(r => r.ZoneId == zone.Id && r.TimestampUtc >= dayAgo, ct);
            if (hasRecent) continue;

            var history = backfill.BackfillHistory(zone.ProviderRef, dayAgo, now, TimeSpan.FromMinutes(30));
            foreach (var reading in history)
            {
                db.SensorReadings.Add(new SensorReading
                {
                    ZoneId = zone.Id,
                    TimestampUtc = reading.TimestampUtc,
                    TempF = reading.TempF,
                    Humidity = reading.Humidity,
                });
            }
        }
        if (db.ChangeTracker.HasChanges()) await db.SaveChangesAsync(ct);
    }
}
