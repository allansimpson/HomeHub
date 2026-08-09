namespace HomeHub.Api.Climate;

using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// The control loop: read the room's probe, move the unit's set point, write down what happened.
/// </summary>
/// <remarks>
/// HomeHub owns a room's comfort in a way it did not before, which raises the cost of the loop being
/// wrong — so <b>every failure here degrades to the unit's own thermostat rather than to nothing</b>
/// (DECISIONS §1). A dead probe hands the room back with the target written as the set point; an
/// unreachable unit keeps retrying and says so; a paused room is left exactly as it stands.
/// <para>
/// One tick per zone per minute. The clock is <see cref="TimeProvider"/> so a simulated week can be
/// asserted against the ledger without waiting for one.
/// </para>
/// </remarks>
public sealed class ClimateLoop
{
    /// <summary>The set-point range every unit is clamped to. The machine's bounds, not a preference.</summary>
    public const double UnitMinF = 60;
    public const double UnitMaxF = 85;

    /// <summary>Three or more hand-backs inside this window means the probe is flapping.</summary>
    private static readonly TimeSpan FlapWindow = TimeSpan.FromHours(1);
    private const int FlapThreshold = 3;

    /// <summary>A flapping probe must read steadily for this long before the loop takes the room back.</summary>
    private static readonly TimeSpan FlapRecovery = TimeSpan.FromMinutes(30);

    private readonly HomeHubDbContext _db;
    private readonly IClimateProvider _units;
    private readonly ClimateBinder? _binder;
    private readonly TimeProvider _time;
    private readonly ILogger<ClimateLoop> _logger;

    public ClimateLoop(
        HomeHubDbContext db, IClimateProvider units, TimeProvider time, ILogger<ClimateLoop> logger,
        ClimateBinder? binder = null)
    {
        _db = db;
        _units = units;
        _time = time;
        _logger = logger;
        _binder = binder;
    }

    /// <summary>Step size and minimum gap between writes, together — they cannot be chosen apart.</summary>
    public static (double Step, TimeSpan MinInterval) Strength(CorrectionStrength c) => c switch
    {
        CorrectionStrength.Gentle => (1, TimeSpan.FromMinutes(20)),
        CorrectionStrength.Hard => (3, TimeSpan.FromMinutes(6)),
        _ => (2, TimeSpan.FromMinutes(10)),
    };

    /// <summary>One pass over every automated zone. Never throws for one zone's sake.</summary>
    public async Task TickAsync(CancellationToken ct = default)
    {
        var nowUtc = _time.GetUtcNow().UtcDateTime;
        var settings = await _db.Settings.FirstOrDefaultAsync(s => s.Id == 1, ct);
        var housePaused = settings?.ClimateLoopPaused ?? false;

        // Refresh unit state first: with Home Assistant configured this is the read that tells us
        // what the units currently report, which is how a set point changed on a remote is noticed.
        try
        {
            await _units.GetUnitsAsync(ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            // Not fatal: the zones below still have their cached unit rows, and a write attempt is
            // what will record the unreachability against the room it actually affects.
            _logger.LogWarning(ex, "Climate loop could not refresh unit state; using the cache.");
        }

        // After the refresh, because that is when Home Assistant's units first exist as rows to bind
        // to. A no-op once every room has its probe and its unit.
        if (_binder is not null) await _binder.BindAsync(_units.Source, ct);

        var zones = await _db.ClimateZones
            .Include(z => z.ClimateUnit)
            .Where(z => z.Class == ZoneClass.Automated)
            .OrderBy(z => z.SortOrder)
            .ToListAsync(ct);

        foreach (var zone in zones)
        {
            try
            {
                await TickZoneAsync(zone, housePaused, nowUtc, personActed: false, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Climate loop failed for {Zone}; other rooms are unaffected.", zone.Name);
            }
        }

        await _db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// Act on one zone right now, because a person just asked for something.
    /// </summary>
    /// <remarks>
    /// The same pass the timer runs, with one difference: quiet hours do not apply. Quiet hours
    /// suppress the machine's chatter, never the household's intent — a slide, a <c>KEEP</c> or a
    /// stepper tap at eleven at night writes (CLIMATE_BEHAVIOURS §4).
    /// <para>
    /// The minimum interval between writes still applies, and deliberately so: it is compressor
    /// protection rather than a preference, and no zone may be written more often than its interval
    /// under <em>any</em> combination of override, promotion and quiet-hours transition
    /// (BUILD_ORDER, Stage 2). When a person's change lands inside the window, the intent is stored
    /// at once — the row changes immediately — and the loop carries it to the unit at the first legal
    /// moment.
    /// </para>
    /// </remarks>
    public async Task ApplyAsync(int zoneId, CancellationToken ct = default)
    {
        var nowUtc = _time.GetUtcNow().UtcDateTime;
        var settings = await _db.Settings.FirstOrDefaultAsync(s => s.Id == 1, ct);
        var zone = await _db.ClimateZones
            .Include(z => z.ClimateUnit)
            .FirstOrDefaultAsync(z => z.Id == zoneId && z.Class == ZoneClass.Automated, ct);
        if (zone is null) return;

        await TickZoneAsync(zone, settings?.ClimateLoopPaused ?? false, nowUtc, personActed: true, ct);
        await _db.SaveChangesAsync(ct);
    }

    private async Task TickZoneAsync(
        ClimateZone zone, bool housePaused, DateTime nowUtc, bool personActed, CancellationToken ct)
    {
        // A paused room is left exactly as it is — the unit keeps whatever it was last told. Pause
        // does not turn anything off, and nothing about it expires (CLIMATE_BEHAVIOURS §5).
        if (zone.IsPaused || housePaused) return;

        var reading = zone.SensorZoneId is { } probeId
            ? await _db.SensorReadings
                .Where(r => r.ZoneId == probeId)
                .OrderByDescending(r => r.TimestampUtc)
                .FirstOrDefaultAsync(ct)
            : null;

        var silent = reading is null || nowUtc - reading.TimestampUtc > ClimateReader.ProbeSilentAfter;
        var target = await EffectiveTargetAsync(zone, nowUtc, ct);
        if (target is null) return;

        if (silent)
        {
            await HandBackAsync(zone, target.Value, nowUtc, ct);
            return;
        }

        if (zone.HandedBackAtUtc is not null && !await CanTakeBackAsync(zone, nowUtc, ct)) return;
        if (zone.HandedBackAtUtc is not null)
        {
            zone.HandedBackAtUtc = null;
            Record(zone, LoopWriteReason.Resume, LoopWriteOutcome.Skipped, reading!.TempF, target.Value, null, target.Value, nowUtc);
        }

        // A loan that has run out. One write puts the standing target back, and the row spends the
        // next hour saying so rather than silently reverting.
        if (await CloseExpiredOverrideAsync(zone, nowUtc, ct) is { } standing)
        {
            await WriteSetPointAsync(zone, LoopWriteReason.OverrideEnd, reading!.TempF, standing, standing, nowUtc, ct);
            return;
        }

        if (zone.ClimateUnit is not { } unit || unit.Mode == ClimateMode.Off)
        {
            // Nothing to command. Recorded once rather than every minute so the ledger stays a record
            // of decisions instead of a heartbeat.
            await RecordOnceAsync(zone, LoopWriteReason.Correct, LoopWriteOutcome.Skipped, reading!.TempF, target.Value, null, target.Value, nowUtc, ct);
            return;
        }

        var error = reading!.TempF - target.Value;
        // The injected clock's zone, not the machine's: quiet hours are a wall-clock rule, and
        // `DateTime.ToLocalTime()` would let the host decide what "eleven at night" means.
        var quiet = ClimateReader.InQuietHours(zone, _time.GetLocalNow().DateTime);

        if (Math.Abs(error) <= zone.ToleranceF)
        {
            await RecordOnceAsync(zone, LoopWriteReason.Settle, LoopWriteOutcome.Skipped, reading.TempF, target.Value, unit.SetPointF, unit.SetPointF, nowUtc, ct);
            return;
        }

        if (quiet && !personActed)
        {
            // Read but do not write. The band still shows the drift, because seeing that the bedroom
            // ran warm overnight is the point of collecting it (CLIMATE_BEHAVIOURS §4).
            await RecordOnceAsync(zone, LoopWriteReason.QuietStart, LoopWriteOutcome.Skipped, reading.TempF, target.Value, unit.SetPointF, unit.SetPointF, nowUtc, ct);
            return;
        }

        var lastRow = await LastRowAsync(zone.Id, ct);
        if (!quiet && lastRow?.Reason == LoopWriteReason.QuietStart)
        {
            // Quiet hours just ended: one write to re-establish the target before ordinary correction
            // resumes, so the morning does not start from wherever the night left the unit.
            await WriteSetPointAsync(zone, LoopWriteReason.QuietEnd, reading.TempF, target.Value, target.Value, nowUtc, ct);
            return;
        }

        // Someone used the physical remote: HA took our call but the unit reports something else.
        // Recorded, then corrected on the ordinary schedule — it fixes itself within one interval,
        // and saying so is what the drill-in sentence is for (CLIMATE_BEHAVIOURS §2).
        if (lastRow is { Outcome: LoopWriteOutcome.Written } written
            && Math.Abs(unit.SetPointF - written.SetPointTo) >= 1
            && lastRow.Reason != LoopWriteReason.Pause)
        {
            Record(zone, written.Reason, LoopWriteOutcome.Rejected, reading.TempF, target.Value, unit.SetPointF, written.SetPointTo, nowUtc);
        }

        var (step, minInterval) = Strength(zone.Correction);
        var lastWritten = await _db.LoopWrites
            .Where(w => w.ZoneId == zone.Id && w.Outcome == LoopWriteOutcome.Written)
            .OrderByDescending(w => w.AtUtc)
            .FirstOrDefaultAsync(ct);
        if (lastWritten is not null && nowUtc - lastWritten.AtUtc < minInterval) return;

        var next = Math.Clamp(unit.SetPointF - Math.Sign(error) * step, UnitMinF, UnitMaxF);
        // Already as far as the machine goes. The reader turns this into "CAN'T HOLD"; writing the
        // same number again would only add rows to the ledger.
        if (Math.Abs(next - unit.SetPointF) < 0.01) return;

        await WriteSetPointAsync(zone, LoopWriteReason.Correct, reading.TempF, target.Value, next, nowUtc, ct);
    }

    /// <summary>
    /// The probe has gone quiet: give the room back to the unit's own sensor and say so.
    /// </summary>
    /// <remarks>
    /// The target is written <em>as</em> the set point first, so the unit holds something sane by its
    /// own measurement. Continuing to steer from a last-known reading was the worst option on the
    /// table — it looks exactly like a loop that is working (DECISIONS §6).
    /// </remarks>
    private async Task HandBackAsync(ClimateZone zone, double target, DateTime nowUtc, CancellationToken ct)
    {
        if (zone.HandedBackAtUtc is not null) return;
        zone.HandedBackAtUtc = nowUtc;
        if (zone.ClimateUnit is null or { Mode: ClimateMode.Off }) return;
        await WriteSetPointAsync(zone, LoopWriteReason.ProbeLost, null, target, target, nowUtc, ct);
    }

    /// <summary>
    /// Whether a recovered probe may have its room back yet.
    /// </summary>
    /// <remarks>
    /// Ordinarily yes, immediately — a probe that reports is a probe that works. But one that returns
    /// and disappears three times in an hour stays handed back until it has read steadily for half an
    /// hour: flapping between two control regimes is worse than either of them
    /// (CLIMATE_BEHAVIOURS §3).
    /// </remarks>
    private async Task<bool> CanTakeBackAsync(ClimateZone zone, DateTime nowUtc, CancellationToken ct)
    {
        var handBacks = await _db.LoopWrites
            .CountAsync(w => w.ZoneId == zone.Id && w.Reason == LoopWriteReason.ProbeLost
                && w.AtUtc >= nowUtc - FlapWindow, ct);
        if (handBacks < FlapThreshold) return true;
        return zone.HandedBackAtUtc is { } since && nowUtc - since >= FlapRecovery;
    }

    /// <summary>Closes an expired loan and returns the standing target to write back, or null.</summary>
    private async Task<double?> CloseExpiredOverrideAsync(ClimateZone zone, DateTime nowUtc, CancellationToken ct)
    {
        var expired = await _db.ZoneOverrides
            .Where(o => o.ZoneId == zone.Id && o.PromotedAtUtc == null && o.CancelledAtUtc == null
                && o.ClosedAtUtc == null && o.ExpiresAtUtc <= nowUtc)
            .OrderByDescending(o => o.ExpiresAtUtc)
            .FirstOrDefaultAsync(ct);
        if (expired is null) return null;
        expired.ClosedAtUtc = nowUtc;
        return zone.StandingTargetF;
    }

    private async Task<double?> EffectiveTargetAsync(ClimateZone zone, DateTime nowUtc, CancellationToken ct)
    {
        var live = await _db.ZoneOverrides
            .Where(o => o.ZoneId == zone.Id && o.PromotedAtUtc == null && o.CancelledAtUtc == null
                && o.StartedAtUtc <= nowUtc && o.ExpiresAtUtc > nowUtc)
            .OrderByDescending(o => o.StartedAtUtc)
            .Select(o => (double?)o.TargetF)
            .FirstOrDefaultAsync(ct);
        return live ?? zone.StandingTargetF;
    }

    /// <summary>Send a set point through the seam and record the attempt, whichever way it goes.</summary>
    private async Task WriteSetPointAsync(
        ClimateZone zone, LoopWriteReason reason, double? probeF, double target, double setPoint,
        DateTime nowUtc, CancellationToken ct)
    {
        if (zone.ClimateUnitId is not { } unitId) return;
        var from = zone.ClimateUnit?.SetPointF;
        var clamped = Math.Clamp(setPoint, UnitMinF, UnitMaxF);
        try
        {
            await _units.SetSetPointAsync(unitId, clamped, ct);
            zone.UnreachableSinceUtc = null;
            if (zone.ClimateUnit is { } unit) unit.SetPointF = clamped;
            Record(zone, reason, LoopWriteOutcome.Written, probeF, target, from, clamped, nowUtc);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            // The probe is fine — it is the unit that is missing, so the reading stays live and only
            // the write is marked. Thirty minutes of this marks the room degraded.
            zone.UnreachableSinceUtc ??= nowUtc;
            Record(zone, reason, LoopWriteOutcome.Unreachable, probeF, target, from, clamped, nowUtc, ex.Message);
        }
    }

    /// <summary>
    /// Record a ledger row only when it says something the previous one did not.
    /// </summary>
    /// <remarks>
    /// Holding, quiet and unit-off are conditions rather than events: a room that is fine at 3:01 is
    /// still fine at 3:02, and a row a minute saying so would bury the decisions the ledger exists to
    /// record. One row on entering the state is enough — the duration is read from its timestamp.
    /// </remarks>
    private async Task RecordOnceAsync(
        ClimateZone zone, LoopWriteReason reason, LoopWriteOutcome outcome, double? probeF,
        double target, double? from, double to, DateTime nowUtc, CancellationToken ct)
    {
        var last = await LastRowAsync(zone.Id, ct);
        if (last is not null && last.Reason == reason && last.Outcome == outcome) return;
        Record(zone, reason, outcome, probeF, target, from, to, nowUtc);
    }

    private void Record(
        ClimateZone zone, LoopWriteReason reason, LoopWriteOutcome outcome, double? probeF,
        double target, double? from, double to, DateTime nowUtc, string? error = null) =>
        _db.LoopWrites.Add(new LoopWrite
        {
            ZoneId = zone.Id,
            AtUtc = nowUtc,
            ProbeF = probeF,
            TargetF = target,
            SetPointFrom = from,
            SetPointTo = to,
            Reason = reason,
            Outcome = outcome,
            Error = error,
        });

    private Task<LoopWrite?> LastRowAsync(int zoneId, CancellationToken ct) =>
        _db.LoopWrites.Where(w => w.ZoneId == zoneId).OrderByDescending(w => w.AtUtc).FirstOrDefaultAsync(ct);
}
