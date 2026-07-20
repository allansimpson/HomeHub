namespace HomeHub.Api.Controllers;

using System.Globalization;
using HomeHub.Api.Data;
using HomeHub.Api.Sensors;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// Read models for the dashboard house widget and the Sensor History screen. All reads come
/// from owned SQL history (written by the poller) — never straight from a provider — so the
/// same shapes serve whichever provider supplied the data.
/// </summary>
[ApiController]
[Route("api/[controller]")]
public class SensorsController : ControllerBase
{
    private const int TempBarCount = 12;

    private readonly HomeHubDbContext _db;

    public SensorsController(HomeHubDbContext db) => _db = db;

    /// <summary>Every zone with its latest reading, ordered for display.</summary>
    [HttpGet("zones")]
    public async Task<IReadOnlyList<ZoneReadingDto>> Zones()
    {
        var zones = await _db.SensorZones.OrderBy(z => z.DisplayOrder).ToListAsync();
        var result = new List<ZoneReadingDto>(zones.Count);
        foreach (var zone in zones)
        {
            var latest = await _db.SensorReadings
                .Where(r => r.ZoneId == zone.Id)
                .OrderByDescending(r => r.TimestampUtc)
                .FirstOrDefaultAsync();
            result.Add(new ZoneReadingDto(
                zone.Id, zone.Name, zone.Category.ToString(), zone.Source, zone.DisplayOrder,
                latest?.TempF, latest?.Humidity, latest?.TimestampUtc));
        }
        return result;
    }

    /// <summary>History for one zone over the last <paramref name="hours"/> hours (default 24).</summary>
    [HttpGet("zones/{id:int}/history")]
    public async Task<ActionResult<ZoneHistoryDto>> History(int id, [FromQuery] int hours = 24)
    {
        var zone = await _db.SensorZones.FindAsync(id);
        if (zone is null) return NotFound();

        hours = Math.Clamp(hours, 1, 168);
        var now = DateTime.UtcNow;
        var windowStart = now.AddHours(-hours);

        var readings = await _db.SensorReadings
            .Where(r => r.ZoneId == id && r.TimestampUtc >= windowStart)
            .OrderBy(r => r.TimestampUtc)
            .ToListAsync();

        var latest = readings.Count > 0 ? readings[^1] : null;

        // Temperature bars: split the window into equal buckets, average each.
        var bucket = TimeSpan.FromHours((double)hours / TempBarCount);
        var bars = new List<TempBarDto>(TempBarCount);
        for (var i = 0; i < TempBarCount; i++)
        {
            var start = windowStart + bucket * i;
            var end = start + bucket;
            var inBucket = readings.Where(r => r.TimestampUtc >= start && r.TimestampUtc < end).ToList();
            double? avg = inBucket.Count > 0 ? Math.Round(inBucket.Average(r => r.TempF), 1) : null;
            bars.Add(new TempBarDto(FormatHourLabel(start.ToLocalTime()), avg));
        }

        // Today's high/low (local calendar day) with the local time each occurred.
        var todayLocal = DateTime.Now.Date;
        var todays = readings.Where(r => r.TimestampUtc.ToLocalTime().Date == todayLocal).ToList();
        double? highF = null, lowF = null;
        string? highAt = null, lowAt = null;
        if (todays.Count > 0)
        {
            var hi = todays.MaxBy(r => r.TempF)!;
            var lo = todays.MinBy(r => r.TempF)!;
            highF = Math.Round(hi.TempF); highAt = FormatClock(hi.TimestampUtc.ToLocalTime());
            lowF = Math.Round(lo.TempF); lowAt = FormatClock(lo.TimestampUtc.ToLocalTime());
        }

        var humidity = BuildHumidityPeriods(todays, DateTime.Now.Hour);

        return new ZoneHistoryDto(
            zone.Id, zone.Name, zone.Category.ToString(),
            latest?.TempF is { } t ? Math.Round(t) : null,
            latest?.Humidity is { } h ? Math.Round(h) : null,
            latest?.TimestampUtc,
            highF, highAt, lowF, lowAt,
            bars, humidity);
    }

    private static IReadOnlyList<HumidityPeriodDto> BuildHumidityPeriods(
        IReadOnlyList<SensorReading> todays, int currentHour)
    {
        // Morning 6–12, Midday 12–17, Evening 17–22.
        (string Label, int From, int To)[] periods =
        [
            ("Morning", 6, 12),
            ("Midday", 12, 17),
            ("Evening", 17, 22),
        ];
        return periods.Select(p =>
        {
            var inPeriod = todays
                .Where(r =>
                {
                    var h = r.TimestampUtc.ToLocalTime().Hour;
                    return h >= p.From && h < p.To;
                })
                .ToList();
            double? avg = inPeriod.Count > 0 ? Math.Round(inPeriod.Average(r => r.Humidity)) : null;
            var current = currentHour >= p.From && currentHour < p.To;
            return new HumidityPeriodDto(p.Label, avg, current);
        }).ToList();
    }

    /// <summary>Compact hour label like "2A" / "2P" for chart axes.</summary>
    private static string FormatHourLabel(DateTime local)
    {
        var h = local.Hour;
        var hour12 = h % 12 == 0 ? 12 : h % 12;
        return $"{hour12}{(h < 12 ? "A" : "P")}";
    }

    private static string FormatClock(DateTime local) =>
        local.ToString("h tt", CultureInfo.InvariantCulture);
}
