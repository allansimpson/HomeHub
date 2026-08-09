namespace HomeHub.Api.Climate;

using System.Globalization;
using HomeHub.Api.Data;
using HomeHub.Api.Sensors;
using HomeHub.Api.Settings;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// Builds the Climate panel's single payload: every row, its state, and the numbers behind the
/// sentence it will speak.
/// </summary>
/// <remarks>
/// The reader answers <em>which state a room is in</em>; the panel decides what that state says. It
/// reads the probe series, the live override and the ledger — never Home Assistant — so a screen
/// refresh costs a handful of indexed queries and no network at all.
/// </remarks>
public sealed class ClimateReader
{
    /// <summary>
    /// A reading older than this is not a reading. Rendered <c>—</c> on every row class rather than
    /// shown stale, and it is also what hands an automated room back to its unit's own sensor.
    /// </summary>
    public static readonly TimeSpan ProbeSilentAfter = TimeSpan.FromMinutes(15);

    /// <summary>How far back the rate-of-change and "outside for" windows look.</summary>
    private static readonly TimeSpan TrendWindow = TimeSpan.FromMinutes(30);

    /// <summary>Under this much data, the "reaches by" clause is omitted rather than guessed.</summary>
    private static readonly TimeSpan MinimumTrendData = TimeSpan.FromMinutes(20);

    /// <summary>Ten minutes out of range. A door standing open is not an alarm.</summary>
    public const int ColdStorageAlarmMinutes = 10;

    /// <summary>Under this, a cold-storage row states the temperature and not a trend.</summary>
    private const double RateFloorPerHour = 0.4;

    /// <summary>Outside tolerance for this long, with the set point pinned, is "can't hold".</summary>
    private const int CantHoldMinutes = 30;

    /// <summary>Thirty minutes of failed writes marks the zone degraded and wants a person.</summary>
    public static readonly TimeSpan DegradedAfter = TimeSpan.FromMinutes(30);

    private readonly HomeHubDbContext _db;
    private readonly TimeProvider _time;

    public ClimateReader(HomeHubDbContext db, TimeProvider time)
    {
        _db = db;
        _time = time;
    }

    public async Task<ClimatePanelDto> GetPanelAsync(CancellationToken ct = default)
    {
        var nowUtc = _time.GetUtcNow().UtcDateTime;
        var settings = await _db.Settings.FirstOrDefaultAsync(s => s.Id == 1, ct);
        var housePaused = settings?.ClimateLoopPaused ?? false;

        var zones = await _db.ClimateZones
            .Include(z => z.ClimateUnit)
            .Include(z => z.SensorZone)
            .OrderBy(z => z.SortOrder)
            .ToListAsync(ct);

        var rows = new List<ClimateZoneDto>(zones.Count);
        foreach (var zone in zones)
        {
            rows.Add(await BuildRowAsync(zone, housePaused, nowUtc, ct));
        }

        // An alarming freezer sorts above everything, including the rooms. It is the one row on this
        // screen that is about food going off rather than about comfort (CLIMATE_BEHAVIOURS §7).
        var ordered = rows
            .OrderByDescending(r => r.State == "outOfRange")
            .ThenBy(r => zones.First(z => z.Id == r.Id).SortOrder)
            .ToList();

        var offer = await new RepeatOfferDetector(_db, _time).FindAsync(zones, nowUtc, ct);
        return new ClimatePanelDto(housePaused, ordered, offer, nowUtc);
    }

    /// <summary>The drill-in's ledger page — newest first.</summary>
    public async Task<IReadOnlyList<LoopWriteDto>> GetWritesAsync(int zoneId, int take, CancellationToken ct = default) =>
        await _db.LoopWrites
            .Where(w => w.ZoneId == zoneId)
            .OrderByDescending(w => w.AtUtc)
            .Take(Math.Clamp(take, 1, 200))
            .Select(w => new LoopWriteDto(
                w.Id, w.AtUtc, w.ProbeF, w.TargetF, w.SetPointFrom, w.SetPointTo,
                w.Reason.ToString(), w.Outcome.ToString(), w.Error))
            .ToListAsync(ct);

    private async Task<ClimateZoneDto> BuildRowAsync(
        ClimateZone zone, bool housePaused, DateTime nowUtc, CancellationToken ct)
    {
        var series = zone.SensorZoneId is { } probeId
            ? await _db.SensorReadings
                .Where(r => r.ZoneId == probeId && r.TimestampUtc >= nowUtc - TrendWindow - ProbeSilentAfter)
                .OrderBy(r => r.TimestampUtc)
                .ToListAsync(ct)
            : [];

        var newest = series.Count > 0 ? series[^1] : null;
        var age = newest is null ? (TimeSpan?)null : nowUtc - newest.TimestampUtc;
        var silent = newest is null || age > ProbeSilentAfter;
        var readingF = silent ? null : (double?)newest!.TempF;
        var humidity = silent ? null : (double?)newest!.Humidity;
        var silentMinutes = zone.SensorZoneId is null || !silent
            ? (int?)null
            : newest is null ? null : (int)Math.Round(age!.Value.TotalMinutes);

        var live = await LiveOverrideAsync(zone.Id, nowUtc, ct);
        var effectiveTarget = live?.TargetF ?? zone.StandingTargetF;

        var lastWrite = await _db.LoopWrites
            .Where(w => w.ZoneId == zone.Id)
            .OrderByDescending(w => w.AtUtc)
            .FirstOrDefaultAsync(ct);

        var steadySince = await _db.LoopWrites
            .Where(w => w.ZoneId == zone.Id && w.Reason == LoopWriteReason.Correct && w.Outcome == LoopWriteOutcome.Written)
            .OrderByDescending(w => w.AtUtc)
            .Select(w => (DateTime?)w.AtUtc)
            .FirstOrDefaultAsync(ct);

        var endedAt = await _db.ZoneOverrides
            .Where(o => o.ZoneId == zone.Id && o.PromotedAtUtc == null && o.CancelledAtUtc == null && o.ExpiresAtUtc <= nowUtc)
            .OrderByDescending(o => o.ExpiresAtUtc)
            .Select(o => (DateTime?)o.ExpiresAtUtc)
            .FirstOrDefaultAsync(ct);

        var rate = RatePerHour(series, nowUtc);
        var paused = zone.IsPaused || housePaused;
        // The injected clock's zone, not the machine's — see the note in ClimateLoop.
        var localNow = _time.GetLocalNow().DateTime;
        var quiet = InQuietHours(zone, localNow);

        double? deviation = null;
        bool? above = null;
        int? outsideMinutes = null;
        if (readingF is { } reading && effectiveTarget is { } target)
        {
            var delta = reading - target;
            above = delta > 0;
            if (Math.Abs(delta) > zone.ToleranceF)
            {
                deviation = Math.Round(Math.Abs(delta), 1);
                outsideMinutes = OutsideMinutes(series, target, zone.ToleranceF, nowUtc);
            }
        }

        var degraded = zone.UnreachableSinceUtc is { } since && nowUtc - since >= DegradedAfter;
        var (outOfRangeMinutes, coldAlarm) = ColdStorageState(zone, series, nowUtc);

        var state = ResolveState(
            zone, paused, quiet, silent, live, endedAt, nowUtc,
            readingF, effectiveTarget, deviation, outsideMinutes, coldAlarm);

        return new ClimateZoneDto(
            Id: zone.Id,
            Name: zone.Name,
            Class: zone.Class.ToString(),
            ReadingF: readingF is { } r ? Math.Round(r, 1) : null,
            Humidity: humidity is { } h ? Math.Round(h) : null,
            ReadingAtUtc: silent ? null : newest!.TimestampUtc,
            ProbeSilentMinutes: silentMinutes,
            StandingTargetF: zone.StandingTargetF,
            StandingSetAtUtc: zone.StandingSetAtUtc,
            TargetF: effectiveTarget,
            ToleranceF: zone.ToleranceF,
            Correction: zone.Correction.ToString(),
            QuietFrom: Hhmm(zone.QuietFrom),
            QuietTo: Hhmm(zone.QuietTo),
            IsPaused: paused,
            PausedAtUtc: zone.PausedAtUtc,
            Override: live is null ? null : new ZoneOverrideDto(live.TargetF, live.StartedAtUtc, live.ExpiresAtUtc),
            PreviousStandingTargetF: zone.PreviousStandingTargetF,
            State: state,
            SteadySinceUtc: steadySince,
            EtaLocal: Eta(series, effectiveTarget, rate, localNow),
            Above: above,
            DeviationF: deviation,
            OutsideMinutes: outsideMinutes,
            UnreachableSinceUtc: zone.UnreachableSinceUtc,
            Degraded: degraded,
            OverrideEndedAtUtc: endedAt,
            // SensorPush reports a battery voltage the ingest does not yet carry. The clause is
            // designed and the field is here; nothing sets it true until a reading brings one.
            LowBattery: false,
            RangeLowF: zone.RangeLowF,
            RangeHighF: zone.RangeHighF,
            OutOfRangeMinutes: outOfRangeMinutes,
            RatePerHour: rate is { } v && Math.Abs(v) >= RateFloorPerHour ? Math.Round(v, 1) : null,
            UnitSetPointF: zone.ClimateUnit is { Mode: not ClimateMode.Off } u ? Math.Round(u.SetPointF) : null,
            UnitMode: zone.ClimateUnit?.Mode.ToString(),
            ProbeRef: zone.SensorZone?.ProviderRef,
            UnitRef: zone.ClimateUnit?.ProviderRef,
            SensorZoneId: zone.SensorZoneId,
            LastWrite: lastWrite is null ? null : LoopWriteDto.From(lastWrite));
    }

    /// <summary>
    /// Which sentence the row gets, in the order the states outrank one another.
    /// </summary>
    /// <remarks>
    /// The order is the design's, not convenience. A paused room says so before anything else,
    /// because nothing else on the row is being acted on. A live loan outranks quiet hours because
    /// quiet hours suppress the machine's chatter, never the household's intent — a slide during
    /// quiet hours writes immediately and the row must show it (CLIMATE_BEHAVIOURS §4).
    /// <para>
    /// <c>standing</c> is deliberately absent: "for the rest of the session" is a fact about the
    /// panel, not about the house, so the client raises that state from
    /// <see cref="ClimateZoneDto.PreviousStandingTargetF"/> and its own session memory.
    /// </para>
    /// </remarks>
    private static string ResolveState(
        ClimateZone zone, bool paused, bool quiet, bool silent, ZoneOverride? live, DateTime? endedAt,
        DateTime nowUtc, double? readingF, double? target, double? deviation, int? outsideMinutes, bool coldAlarm)
    {
        if (zone.Class == ZoneClass.ColdStorage) return coldAlarm ? "outOfRange" : silent ? "noProbe" : "inRange";
        if (zone.Class == ZoneClass.Watched) return silent ? "noProbe" : "watched";

        if (zone.SensorZoneId is null) return "noProbe";
        if (paused) return "paused";
        if (silent) return "probeLost";
        if (zone.ClimateUnit is null or { Mode: ClimateMode.Off }) return "unitOff";
        if (zone.UnreachableSinceUtc is not null) return "unreachable";
        if (live is not null) return "borrowed";
        if (endedAt is { } ended && nowUtc - ended < TimeSpan.FromHours(1)) return "backOn";
        if (quiet) return "quiet";
        if (readingF is null || target is null) return "holding";
        if (deviation is null) return "holding";
        if (outsideMinutes >= CantHoldMinutes && AtUnitLimit(zone)) return "cantHold";
        return "correcting";
    }

    /// <summary>
    /// The set point is already as far as the unit goes, so the loop has nothing left to try.
    /// </summary>
    /// <remarks>
    /// Deliberately the <em>unit's</em> limits and not a per-room floor and ceiling: the machine's
    /// own bounds already constrain it, and a second set of limits on the panel would be one more
    /// thing to get wrong (DECISIONS §7).
    /// </remarks>
    private static bool AtUnitLimit(ClimateZone zone) =>
        zone.ClimateUnit is { } unit
        && (unit.SetPointF <= ClimateLoop.UnitMinF || unit.SetPointF >= ClimateLoop.UnitMaxF);

    private async Task<ZoneOverride?> LiveOverrideAsync(int zoneId, DateTime nowUtc, CancellationToken ct) =>
        await _db.ZoneOverrides
            .Where(o => o.ZoneId == zoneId
                && o.PromotedAtUtc == null && o.CancelledAtUtc == null
                && o.StartedAtUtc <= nowUtc && o.ExpiresAtUtc > nowUtc)
            .OrderByDescending(o => o.StartedAtUtc)
            .FirstOrDefaultAsync(ct);

    /// <summary>°F per hour across the trend window, or null when there is not enough of it.</summary>
    private static double? RatePerHour(List<SensorReading> series, DateTime nowUtc)
    {
        var window = series.Where(r => r.TimestampUtc >= nowUtc - TrendWindow).ToList();
        if (window.Count < 2) return null;
        var span = window[^1].TimestampUtc - window[0].TimestampUtc;
        if (span < MinimumTrendData) return null;
        return (window[^1].TempF - window[0].TempF) / span.TotalHours;
    }

    /// <summary>
    /// "71° NEAR 5:24" — when the observed rate says the probe reaches the target.
    /// </summary>
    /// <remarks>
    /// Omitted, never guessed. A room being pulled down at a tenth of a degree an hour would produce
    /// an arrival time tomorrow afternoon, which is worse than saying nothing; so is an estimate from
    /// five minutes of data. Both cases return null and the clause simply is not drawn.
    /// </remarks>
    private static string? Eta(List<SensorReading> series, double? target, double? ratePerHour, DateTime localNow)
    {
        if (target is not { } t || ratePerHour is not { } rate || series.Count == 0) return null;
        var gap = t - series[^1].TempF;
        if (Math.Abs(gap) < 0.5) return null;
        // Moving the wrong way, or barely at all: there is no honest arrival time to state.
        if (Math.Sign(gap) != Math.Sign(rate) || Math.Abs(rate) < 0.5) return null;
        var hours = gap / rate;
        if (hours <= 0 || hours > 8) return null;
        return localNow.AddHours(hours).ToString("h:mm", CultureInfo.InvariantCulture);
    }

    /// <summary>How long the probe has been continuously outside tolerance, capped by the window.</summary>
    private static int? OutsideMinutes(List<SensorReading> series, double target, double tolerance, DateTime nowUtc)
    {
        if (series.Count == 0) return null;
        DateTime? since = null;
        for (var i = series.Count - 1; i >= 0; i--)
        {
            if (Math.Abs(series[i].TempF - target) <= tolerance) break;
            since = series[i].TimestampUtc;
        }
        return since is null ? null : (int)Math.Round((nowUtc - since.Value).TotalMinutes);
    }

    /// <summary>Minutes out of the cold-storage band, and whether that is long enough to alarm.</summary>
    private static (int?, bool) ColdStorageState(ClimateZone zone, List<SensorReading> series, DateTime nowUtc)
    {
        if (zone.Class != ZoneClass.ColdStorage || series.Count == 0) return (null, false);
        var low = zone.RangeLowF ?? double.MinValue;
        var high = zone.RangeHighF ?? double.MaxValue;
        DateTime? since = null;
        for (var i = series.Count - 1; i >= 0; i--)
        {
            var t = series[i].TempF;
            if (t >= low && t <= high) break;
            since = series[i].TimestampUtc;
        }
        if (since is null) return (null, false);
        var minutes = (int)Math.Round((nowUtc - since.Value).TotalMinutes);
        return (minutes, minutes >= ColdStorageAlarmMinutes);
    }

    /// <summary>Whether local wall-clock time falls inside the room's quiet window (which wraps midnight).</summary>
    public static bool InQuietHours(ClimateZone zone, DateTime local)
    {
        var now = local.TimeOfDay;
        return zone.QuietFrom <= zone.QuietTo
            ? now >= zone.QuietFrom && now < zone.QuietTo
            : now >= zone.QuietFrom || now < zone.QuietTo;
    }

    private static string Hhmm(TimeSpan t) => $"{t.Hours:D2}:{t.Minutes:D2}";
}
