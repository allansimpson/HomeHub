namespace HomeHub.Api.Climate;

using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// Everything a person can ask the Climate section to do: set a standing target, borrow a room for
/// two hours, keep what they borrowed, take it back, tune how a room holds, and pause.
/// </summary>
/// <remarks>
/// Each of these mutates state and then hands the zone to <see cref="ClimateLoop.ApplyAsync"/>, so a
/// person's change reaches the unit through exactly the same guarded path the timer uses. There is
/// no second write path, which is what keeps the ledger a complete account of what the units were
/// told and by whom.
/// </remarks>
public sealed class ClimateCommands
{
    /// <summary>The loan's length. Not configurable — it is the rule that makes one tap safe.</summary>
    public static readonly TimeSpan LoanLength = TimeSpan.FromHours(2);

    /// <summary>The range the gesture and the stepper both work in.</summary>
    public const double MinTargetF = 64;
    public const double MaxTargetF = 80;

    private readonly HomeHubDbContext _db;
    private readonly ClimateLoop _loop;
    private readonly IClimateProvider _units;
    private readonly TimeProvider _time;

    public ClimateCommands(HomeHubDbContext db, ClimateLoop loop, IClimateProvider units, TimeProvider time)
    {
        _db = db;
        _loop = loop;
        _units = units;
        _time = time;
    }

    /// <summary>
    /// Write the standing target — the drill-in's stepper, and the deliberate path 3a and 3b shortcut.
    /// </summary>
    public async Task<bool> SetStandingTargetAsync(int zoneId, double targetF, CancellationToken ct = default)
    {
        var zone = await AutomatedAsync(zoneId, ct);
        if (zone is null) return false;

        var nowUtc = _time.GetUtcNow().UtcDateTime;
        zone.PreviousStandingTargetF = zone.StandingTargetF;
        zone.StandingTargetF = Math.Clamp(Math.Round(targetF), MinTargetF, MaxTargetF);
        zone.StandingSetAtUtc = nowUtc;
        await _db.SaveChangesAsync(ct);
        await _loop.ApplyAsync(zoneId, ct);
        return true;
    }

    /// <summary>Borrow the room for two hours. A new loan supersedes any live one and restarts the clock.</summary>
    public async Task<bool> StartOverrideAsync(int zoneId, double targetF, int? profileId, CancellationToken ct = default)
    {
        var zone = await AutomatedAsync(zoneId, ct);
        if (zone is null) return false;

        var nowUtc = _time.GetUtcNow().UtcDateTime;
        await CancelLiveOverridesAsync(zoneId, nowUtc, ct);
        _db.ZoneOverrides.Add(new ZoneOverride
        {
            ZoneId = zoneId,
            TargetF = Math.Clamp(Math.Round(targetF), MinTargetF, MaxTargetF),
            StartedAtUtc = nowUtc,
            ExpiresAtUtc = nowUtc + LoanLength,
            ByProfileId = profileId,
        });
        await _db.SaveChangesAsync(ct);
        await _loop.ApplyAsync(zoneId, ct);
        return true;
    }

    /// <summary>
    /// Keep it — 3a's <c>KEEP 69°</c> and 3b's lift-on-keep, in one call either way.
    /// </summary>
    /// <remarks>
    /// <b>One request, deliberately.</b> A client that instead set the target and then deleted the
    /// override could leave a zone holding a new standing target with a live loan against it — a state
    /// no screen renders and no person asked for. There is no observable moment between the two here
    /// (CLIMATE_DATA_CONTRACT §3).
    /// <para>
    /// <paramref name="targetF"/> is what makes that true for <b>3b</b> as well, and is the one
    /// addition to the contract's route. 3a promotes a loan that is already running, so it needs no
    /// value; 3b lifts on <c>KEEP</c> without ever having released a loan, so there is nothing live to
    /// promote — and starting one and then promoting it would be exactly the two calls the route
    /// exists to avoid. Given a value, the loan is written and kept in the same transaction. It is
    /// stored rather than skipped because <c>promotedAt</c> is the only column the repeat-offer reads:
    /// a keep that left no loan behind would leave the panel offering to make standing what is already
    /// standing.
    /// </para>
    /// </remarks>
    public async Task<bool> PromoteAsync(int zoneId, double? targetF = null, CancellationToken ct = default)
    {
        var zone = await AutomatedAsync(zoneId, ct);
        if (zone is null) return false;

        var nowUtc = _time.GetUtcNow().UtcDateTime;
        ZoneOverride? live;
        if (targetF is { } chosen)
        {
            await CancelLiveOverridesAsync(zoneId, nowUtc, ct);
            live = new ZoneOverride
            {
                ZoneId = zoneId,
                TargetF = Math.Clamp(Math.Round(chosen), MinTargetF, MaxTargetF),
                StartedAtUtc = nowUtc,
                ExpiresAtUtc = nowUtc + LoanLength,
                PromotedAtUtc = nowUtc,
            };
            _db.ZoneOverrides.Add(live);
        }
        else
        {
            live = await LiveOverrideAsync(zoneId, nowUtc, ct);
            if (live is null) return false;
            live.PromotedAtUtc = nowUtc;
        }

        zone.PreviousStandingTargetF = zone.StandingTargetF;
        zone.StandingTargetF = live.TargetF;
        zone.StandingSetAtUtc = nowUtc;
        await _db.SaveChangesAsync(ct);
        await _loop.ApplyAsync(zoneId, ct);
        return true;
    }

    /// <summary>Cancel the live loan. The standing target comes straight back.</summary>
    public async Task<bool> CancelOverrideAsync(int zoneId, CancellationToken ct = default)
    {
        var zone = await AutomatedAsync(zoneId, ct);
        if (zone is null) return false;

        var nowUtc = _time.GetUtcNow().UtcDateTime;
        var cancelled = await CancelLiveOverridesAsync(zoneId, nowUtc, ct);
        if (cancelled == 0) return false;
        await _db.SaveChangesAsync(ct);
        await _loop.ApplyAsync(zoneId, ct);
        return true;
    }

    /// <summary>
    /// <c>UNDO</c> — put back the exact standing target the last promotion replaced.
    /// </summary>
    /// <remarks>
    /// Its own route rather than a flavour of cancelling a loan, because by the time <c>UNDO</c> is on
    /// the row there is no loan left to cancel: promotion ended it. This is the way out of a permanent
    /// change that 3b hid inside a gesture, and it stays available for the rest of the session rather
    /// than for five seconds — a toast that has already gone is not a way out
    /// (CLIMATE_BEHAVIOURS §6).
    /// </remarks>
    public async Task<bool> UndoAsync(int zoneId, CancellationToken ct = default)
    {
        var zone = await AutomatedAsync(zoneId, ct);
        if (zone?.PreviousStandingTargetF is not { } previous) return false;

        var nowUtc = _time.GetUtcNow().UtcDateTime;
        zone.StandingTargetF = previous;
        zone.PreviousStandingTargetF = null;
        zone.StandingSetAtUtc = nowUtc;
        await CancelLiveOverridesAsync(zoneId, nowUtc, ct);
        await _db.SaveChangesAsync(ct);
        await _loop.ApplyAsync(zoneId, ct);
        return true;
    }

    /// <summary>The four per-room knobs. Only the fields that were sent are changed.</summary>
    public async Task<bool> PatchAsync(int zoneId, PatchZoneInput input, CancellationToken ct = default)
    {
        var zone = await _db.ClimateZones.FirstOrDefaultAsync(z => z.Id == zoneId, ct);
        if (zone is null) return false;

        var nowUtc = _time.GetUtcNow().UtcDateTime;
        if (input.ToleranceF is { } tol && tol is 0.5 or 1 or 2) zone.ToleranceF = tol;
        if (input.Correction is { } correction) zone.Correction = correction;
        if (TryTime(input.QuietFrom, out var from)) zone.QuietFrom = from;
        if (TryTime(input.QuietTo, out var to)) zone.QuietTo = to;
        if (input.IsPaused is { } paused && paused != zone.IsPaused)
        {
            zone.IsPaused = paused;
            zone.PausedAtUtc = paused ? nowUtc : null;
            RecordPauseTransition(zone, paused, nowUtc);
        }

        await _db.SaveChangesAsync(ct);
        if (input.IsPaused == false) await _loop.ApplyAsync(zoneId, ct);
        return true;
    }

    /// <summary>
    /// Pause or resume every automated room at once. Pausing turns nothing off.
    /// </summary>
    /// <remarks>
    /// It survives a restart and does not expire on its own: a paused house is a decision, and
    /// un-pausing it silently would be the loop overriding a person (CLIMATE_BEHAVIOURS §5).
    /// </remarks>
    public async Task PauseHouseAsync(bool paused, CancellationToken ct = default)
    {
        var settings = await _db.Settings.FirstAsync(s => s.Id == 1, ct);
        if (settings.ClimateLoopPaused == paused) return;

        var nowUtc = _time.GetUtcNow().UtcDateTime;
        settings.ClimateLoopPaused = paused;
        var zones = await _db.ClimateZones
            .Include(z => z.ClimateUnit)
            .Where(z => z.Class == ZoneClass.Automated)
            .ToListAsync(ct);
        foreach (var zone in zones) RecordPauseTransition(zone, paused, nowUtc);
        await _db.SaveChangesAsync(ct);

        if (!paused)
        {
            foreach (var zone in zones) await _loop.ApplyAsync(zone.Id, ct);
        }
    }

    /// <summary>Every unit off. Separate from pause, and hold-to-confirm on the panel.</summary>
    public Task AllUnitsOffAsync(CancellationToken ct = default) => _units.ApplySceneAsync("all-off", ct);

    /// <summary>
    /// Answer the repeat-offer. Accepting writes the standing target through the ordinary path;
    /// declining buys thirty days of quiet for that room at that time of day.
    /// </summary>
    public async Task<bool> ReplyToOfferAsync(
        int zoneId, bool accept, double targetF, int windowHour, CancellationToken ct = default)
    {
        var zone = await AutomatedAsync(zoneId, ct);
        if (zone is null) return false;

        var nowUtc = _time.GetUtcNow().UtcDateTime;
        zone.OfferShownAtUtc = nowUtc;
        if (accept)
        {
            await _db.SaveChangesAsync(ct);
            return await SetStandingTargetAsync(zoneId, targetF, ct);
        }

        zone.OfferSuppressedUntilUtc = nowUtc + RepeatOfferDetector.SuppressFor;
        zone.OfferSuppressedWindowHour = windowHour;
        await _db.SaveChangesAsync(ct);
        return true;
    }

    private void RecordPauseTransition(ClimateZone zone, bool paused, DateTime nowUtc) =>
        _db.LoopWrites.Add(new LoopWrite
        {
            ZoneId = zone.Id,
            AtUtc = nowUtc,
            TargetF = zone.StandingTargetF ?? 0,
            SetPointFrom = zone.ClimateUnit?.SetPointF,
            // Nothing is sent: the unit keeps exactly the number it already has, which is the whole
            // point of pause and the reason the row can say "UNIT LEFT AT 68°".
            SetPointTo = zone.ClimateUnit?.SetPointF ?? 0,
            Reason = paused ? LoopWriteReason.Pause : LoopWriteReason.Resume,
            Outcome = LoopWriteOutcome.Skipped,
        });

    private async Task<int> CancelLiveOverridesAsync(int zoneId, DateTime nowUtc, CancellationToken ct)
    {
        var live = await _db.ZoneOverrides
            .Where(o => o.ZoneId == zoneId && o.PromotedAtUtc == null && o.CancelledAtUtc == null
                && o.ExpiresAtUtc > nowUtc)
            .ToListAsync(ct);
        foreach (var o in live) o.CancelledAtUtc = nowUtc;
        return live.Count;
    }

    private Task<ZoneOverride?> LiveOverrideAsync(int zoneId, DateTime nowUtc, CancellationToken ct) =>
        _db.ZoneOverrides
            .Where(o => o.ZoneId == zoneId && o.PromotedAtUtc == null && o.CancelledAtUtc == null
                && o.StartedAtUtc <= nowUtc && o.ExpiresAtUtc > nowUtc)
            .OrderByDescending(o => o.StartedAtUtc)
            .FirstOrDefaultAsync(ct);

    private Task<ClimateZone?> AutomatedAsync(int zoneId, CancellationToken ct) =>
        _db.ClimateZones.FirstOrDefaultAsync(z => z.Id == zoneId && z.Class == ZoneClass.Automated, ct);

    private static bool TryTime(string? value, out TimeSpan time)
    {
        time = default;
        return !string.IsNullOrWhiteSpace(value) && TimeSpan.TryParse(value, out time);
    }
}
