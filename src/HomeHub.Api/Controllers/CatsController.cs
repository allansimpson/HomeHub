namespace HomeHub.Api.Controllers;

using HomeHub.Api.Cats;
using HomeHub.Api.Data;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

/// <summary>
/// Litter box reads and the manual recovery control, for the Cat section. No Home Assistant or Whisker
/// specifics leak here — only <see cref="ILitterRobotProvider"/> and
/// <see cref="LitterRobotRecoveryRunner"/>, and the SPA never calls Home Assistant itself.
/// </summary>
[ApiController]
[Route("api/cats")]
public class CatsController : ControllerBase
{
    private const int MaxHistoryDays = 90;

    private readonly ILitterRobotProvider _provider;
    private readonly ILitterRobotCommands _commands;
    private readonly LitterRobotRecoveryRunner _runner;
    private readonly RecoveryTracker _tracker;
    private readonly CatOptions _options;
    private readonly IServiceProvider _services;
    private readonly ILogger<CatsController> _logger;

    public CatsController(
        ILitterRobotProvider provider,
        ILitterRobotCommands commands,
        LitterRobotRecoveryRunner runner,
        RecoveryTracker tracker,
        IOptions<CatOptions> options,
        IServiceProvider services,
        ILogger<CatsController> logger)
    {
        _provider = provider;
        _commands = commands;
        _runner = runner;
        _tracker = tracker;
        _options = options.Value;
        _services = services;
        _logger = logger;
    }

    /// <summary>Whether the litter-box integration is connected, and how it's failing when it isn't.</summary>
    [HttpGet("health")]
    public async Task<CatHealthDto> Health(CancellationToken ct)
    {
        var health = await _provider.GetHealthAsync(ct);
        return new CatHealthDto(
            health.Status.ToString(), health.Detail, health.LastGoodUtc, _provider.IsConfigured);
    }

    /// <summary>Every robot with its current status and live recovery state — the Cat tab's main read.</summary>
    /// <param name="fresh">
    /// Bypass the display cache. Costs a round trip to Home Assistant, so it is for the seconds after
    /// someone presses something: the panel is watching for the robot to react, and a ten-second-old
    /// cached status makes a working command look like it did nothing.
    /// </param>
    [HttpGet]
    public async Task<IReadOnlyList<LitterRobotDto>> List([FromQuery] bool fresh, CancellationToken ct)
    {
        if (fresh)
        {
            var live = await _provider.GetFreshSnapshotsAsync(ct);
            var fromLive = new List<LitterRobotDto>(live.Count);
            foreach (var snapshot in live) fromLive.Add(await ToDtoAsync(snapshot, ct));
            return fromLive;
        }

        var robots = await _provider.GetRobotsAsync(ct);
        var result = new List<LitterRobotDto>(robots.Count);
        foreach (var robot in robots)
        {
            var snapshot = await _provider.GetSnapshotAsync(robot.Slug, ct);
            if (snapshot is null) continue;
            result.Add(await ToDtoAsync(snapshot, ct));
        }
        return result;
    }

    /// <summary>One robot's snapshot.</summary>
    [HttpGet("{slug}")]
    public async Task<ActionResult<LitterRobotDto>> Get(string slug, CancellationToken ct)
    {
        var snapshot = await _provider.GetSnapshotAsync(slug, ct);
        return snapshot is null ? NotFound() : await ToDtoAsync(snapshot, ct);
    }

    /// <summary>
    /// Recovery attempt history — the record that distinguishes an occasionally-flaky robot from one
    /// that has started failing and needs a service call.
    /// </summary>
    [HttpGet("{slug}/recoveries")]
    public async Task<ActionResult<IReadOnlyList<RecoveryAttemptDto>>> Recoveries(
        string slug, [FromQuery] int days = 7, CancellationToken ct = default)
    {
        if (days is < 1 or > MaxHistoryDays) return BadRequest($"'days' must be between 1 and {MaxHistoryDays}.");

        var db = _services.GetService<HomeHubDbContext>();
        if (db is null) return Ok(Array.Empty<RecoveryAttemptDto>());

        var since = DateTime.UtcNow.AddDays(-days);
        var rows = await db.LitterRobotRecoveries
            .Where(r => r.Slug == slug && r.StartedAtUtc >= since)
            .OrderByDescending(r => r.StartedAtUtc)
            .ToListAsync(ct);

        return rows.Select(RecoveryAttemptDto.From).ToList();
    }

    /// <summary>
    /// Levels, weights and fault-class share over a window, from Home Assistant's recorder.
    /// </summary>
    /// <remarks>
    /// HomeHub keeps no litter time series of its own, so this is bounded by HA's retention (10 days
    /// by default). <c>complete</c> reports whether the recorder actually covered the window asked
    /// for; the panel says so rather than drawing a short series as a full one.
    /// </remarks>
    [HttpGet("{slug}/history")]
    public async Task<ActionResult<LitterRobotHistory>> History(
        string slug, [FromQuery] int days = 7, CancellationToken ct = default)
    {
        if (days is < 1 or > MaxHistoryDays) return BadRequest($"'days' must be between 1 and {MaxHistoryDays}.");

        try
        {
            var history = await _provider.GetHistoryAsync(slug, days, ct);
            return history is null ? NotFound() : Ok(history);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            // A recorder query is the heaviest thing the panel asks of Home Assistant, and the one
            // most likely to time out as retention fills. Say the read failed — 502, like the other
            // upstream failures — rather than letting it surface as a 500, which reads like a bug
            // here, or as an empty history, which reads like a robot that has never done anything.
            return StatusCode(StatusCodes.Status502BadGateway,
                $"Home Assistant did not return history: {ex.Message}");
        }
    }

    /// <summary>
    /// Force a reset + clean cycle now.
    /// </summary>
    /// <remarks>
    /// Returns 409 with a machine-readable reason when the robot declines — which is the whole point of
    /// this endpoint existing rather than the SPA calling Home Assistant directly. The robot accepts
    /// commands it silently drops (a cycle requested with a cat detected does nothing and reports
    /// success), so a 200 here means the status was observed to change, not merely that a call was made.
    /// The cat interlock is enforced in the runner and this endpoint cannot override it.
    /// </remarks>
    [HttpPost("{slug}/cycle")]
    public async Task<ActionResult<CycleResultDto>> Cycle(string slug, CancellationToken ct)
    {
        var snapshot = await _provider.GetSnapshotAsync(slug, ct);
        if (snapshot is null) return NotFound();

        var result = await _runner.AttemptAsync(slug, attemptNumber: 1, manual: true, ct);
        var dto = new CycleResultDto(
            result.Recovered,
            result.Outcome.ToString(),
            result.Step.ToString(),
            result.ResultingCode,
            result.Detail);

        return result.Recovered ? Ok(dto) : Conflict(dto);
    }

    /// <summary>
    /// Zero the waste-drawer reading after emptying it. Confirmed on the panel first — pressed without
    /// emptying, it leaves the panel reporting 0% on a full drawer until the robot refuses to cycle.
    /// </summary>
    [HttpPost("{slug}/drawer/reset")]
    public Task<ActionResult<LitterRobotDto>> ResetDrawer(string slug, CancellationToken ct) =>
        CommandAsync(slug, c => c.CanResetDrawer, _commands.ResetWasteDrawerAsync, ct);

    /// <summary>Reset the litter level to full after topping the globe up.</summary>
    [HttpPost("{slug}/litter/reset")]
    public Task<ActionResult<LitterRobotDto>> ResetLitter(string slug, CancellationToken ct) =>
        CommandAsync(slug, c => c.CanAddLitter, _commands.ResetLitterLevelAsync, ct);

    /// <summary>Set sleep mode, the night light, or the panel lockout.</summary>
    [HttpPut("{slug}/switch/{which}")]
    public async Task<ActionResult<LitterRobotDto>> SetSwitch(
        string slug, string which, [FromBody] SwitchInput input, CancellationToken ct)
    {
        if (input is null) return BadRequest("No switch state provided.");
        if (!Enum.TryParse<LitterRobotSwitch>(which, ignoreCase: true, out var parsed))
            return BadRequest($"Unknown switch '{which}'. Use sleepmode, nightlight or panellock.");

        return await CommandAsync(
            slug,
            c => parsed switch
            {
                LitterRobotSwitch.SleepMode => c.SleepMode is not null,
                LitterRobotSwitch.NightLight => c.NightLight is not null,
                _ => c.PanelLock is not null,
            },
            (s, token) => _commands.SetSwitchAsync(s, parsed, input.On, token),
            ct);
    }

    /// <summary>
    /// Move one of the robot's multi-position settings — night light, either brightness, or the wait
    /// after the cat leaves.
    /// </summary>
    /// <remarks>
    /// Separate from the switch endpoint because these are not booleans: the night light is
    /// Off/Low/Medium/High. The option is checked against the ones the entity itself declares, so a
    /// bad value fails here with a list of what would have worked rather than as an opaque HA error.
    /// </remarks>
    [HttpPut("{slug}/select/{which}")]
    public async Task<ActionResult<LitterRobotDto>> SetSelect(
        string slug, string which, [FromBody] SelectInput input, CancellationToken ct)
    {
        if (input is null || string.IsNullOrWhiteSpace(input.Option)) return BadRequest("No option provided.");
        if (!Enum.TryParse<LitterRobotSelect>(which, ignoreCase: true, out var parsed))
            return BadRequest($"Unknown setting '{which}'. Use nightlight, globebrightness, panelbrightness or cleancyclewait.");

        var snapshot = await _provider.GetSnapshotAsync(slug, ct);
        if (snapshot is null) return NotFound();
        if (!snapshot.Controls.Selects.TryGetValue(parsed, out var state))
            return StatusCode(StatusCodes.Status501NotImplemented,
                $"'{slug}' exposes no {parsed} setting through Home Assistant.");

        if (state.Options.Count > 0 && !state.Options.Contains(input.Option, StringComparer.Ordinal))
            return BadRequest($"'{input.Option}' is not one of: {string.Join(", ", state.Options)}.");

        return await CommandAsync(
            slug,
            c => c.Selects.ContainsKey(parsed),
            (s, token) => _commands.SetSelectAsync(s, parsed, input.Option, token),
            ct);
    }

    /// <summary>
    /// Stop or resume automatic recovery for one robot — the panel's "leave it alone".
    /// </summary>
    /// <remarks>
    /// Pausing suppresses intervention only. The box keeps reporting its fault and keeps raising the
    /// alert, because a paused recovery is still a box the cat can't use. The pause is in-memory and
    /// clears on restart; the configured master switch (<c>Cats:Recovery:Enabled</c>) is unaffected.
    /// </remarks>
    [HttpPut("{slug}/recovery")]
    public async Task<ActionResult<LitterRobotDto>> SetRecovery(
        string slug, [FromBody] RecoveryInput input, CancellationToken ct)
    {
        if (input is null) return BadRequest("No recovery state provided.");

        var snapshot = await _provider.GetSnapshotAsync(slug, ct);
        if (snapshot is null) return NotFound();

        _tracker.SetPaused(slug, !input.Enabled);
        return await ToDtoAsync(snapshot, ct);
    }

    /// <summary>
    /// Sends one command and answers with a freshly-read snapshot rather than with the fact that the
    /// call returned.
    /// </summary>
    /// <remarks>
    /// The robot accepts commands it silently drops, so the only honest answer to "did that work" is the
    /// next reading. The snapshot may still show the old value — HA and the robot settle at their own
    /// pace — which is why the panel treats these as pending until a later poll agrees, and why this
    /// never reports success on its own.
    /// </remarks>
    private async Task<ActionResult<LitterRobotDto>> CommandAsync(
        string slug,
        Func<LitterRobotControls, bool> supported,
        Func<string, CancellationToken, Task> command,
        CancellationToken ct)
    {
        var snapshot = await _provider.GetSnapshotAsync(slug, ct);
        if (snapshot is null) return NotFound();

        // Refuse rather than fire into the dark when the entity isn't there — the panel gates on the
        // same flags, so reaching here means they disagreed and the reading is the one to trust.
        if (!supported(snapshot.Controls))
            return StatusCode(StatusCodes.Status501NotImplemented,
                $"'{slug}' exposes no entity for that control through Home Assistant.");

        // A cat in the unit stops every command, exactly as it does in the recovery loop.
        if (snapshot.Fault.Class is LitterRobotFaultClass.CatPresent)
            return Conflict("A cat is in the unit — commands are held until it leaves.");

        try
        {
            await command(slug, ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            return StatusCode(StatusCodes.Status502BadGateway, ex.Message);
        }

        // The command has already happened. From here on, a failure is only a failure to *observe* it,
        // and must not be reported as one: a timeout on this read used to surface as a 5xx, which the
        // panel renders as "The command did not reach the robot" — an invitation to hold a destructive
        // drawer reset a second time. Fall back to the pre-command snapshot instead; it is one poll
        // out of date, which the next tick corrects.
        LitterRobotSnapshot fresh;
        try
        {
            fresh = (await _provider.GetFreshSnapshotsAsync(ct)).FirstOrDefault(s => s.Slug == slug) ?? snapshot;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Command for {Slug} was sent but the confirming read failed.", slug);
            fresh = snapshot;
        }

        return await ToDtoAsync(fresh, ct);
    }

    private async Task<LitterRobotDto> ToDtoAsync(LitterRobotSnapshot snapshot, CancellationToken ct)
    {
        var db = _services.GetService<HomeHubDbContext>();
        var attemptsToday = 0;
        if (db is not null)
        {
            var since = DateTime.UtcNow.AddDays(-1);
            attemptsToday = await db.LitterRobotRecoveries
                .CountAsync(r => r.Slug == snapshot.Slug && !r.Manual && r.StartedAtUtc >= since, ct);
        }

        var recovery = _tracker.Snapshot(snapshot.Slug, _options.Recovery.Enabled, attemptsToday);

        // The same ceiling the recovery loop applies, so "attempt 2 of 3" on the panel means the loop
        // really will stop after the third — including the tighter per-code limit on the mechanical
        // faults, where a second attempt is how a jam becomes a broken motor.
        var episodeCeiling = Math.Min(
            Math.Max(1, _options.Recovery.MaxAttemptsPerEpisode),
            snapshot.Fault.MaxAttempts ?? int.MaxValue);

        return LitterRobotDto.From(
            snapshot, recovery, episodeCeiling, Math.Max(1, _options.Recovery.MaxAttemptsPerDay));
    }
}

public sealed record CatHealthDto(string Status, string? Detail, DateTimeOffset? LastGoodUtc, bool Configured);

/// <summary>
/// A litter box for the panel. <c>FaultClass</c> is what the UI should branch on — it collapses 25
/// status codes into the six outcomes that change what a person should do, so the Cat tab doesn't have
/// to know the vocabulary.
/// </summary>
public sealed record LitterRobotDto(
    string Slug,
    string Name,
    string StatusCode,
    string StatusText,
    string FaultClass,
    /// <summary>`LR4` / `LR3`, inferred from capability — the panel names the box, not the entity.</summary>
    string? Model,
    bool Usable,
    double? WasteDrawerPercent,
    double? LitterPercent,
    double? PetWeightLbs,
    int? TotalCycles,
    DateTimeOffset? LastSeenUtc,
    DateTimeOffset? StatusSinceUtc,
    DateTimeOffset FetchedUtc,
    bool Stale,
    RecoveryStateDto Recovery,
    LitterRobotControlsDto Controls)
{
    public static LitterRobotDto From(
        LitterRobotSnapshot s, RecoveryState r, int episodeCeiling, int dailyCeiling) => new(
        s.Slug,
        s.Name,
        s.Fault.Code,
        s.Fault.Text,
        s.Fault.Class.ToString(),
        s.Model,
        s.IsUsable,
        s.WasteDrawerPercent,
        s.LitterPercent,
        s.PetWeightLbs,
        s.TotalCycles,
        s.LastSeenUtc,
        s.StatusSinceUtc,
        s.FetchedUtc,
        s.Stale,
        RecoveryStateDto.From(r, episodeCeiling, dailyCeiling),
        LitterRobotControlsDto.From(s.Controls));
}

/// <summary>
/// What the panel may offer for this robot. The three switch states are nullable — unknown is not off,
/// and a control drawn in the off position invites a press that goes nowhere.
/// </summary>
public sealed record LitterRobotControlsDto(
    bool? SleepMode,
    bool? NightLight,
    bool? PanelLock,
    bool CanResetDrawer,
    bool CanAddLitter,
    DateTimeOffset? SleepStartsUtc,
    DateTimeOffset? SleepEndsUtc,
    IReadOnlyDictionary<string, LitterSelectDto> Selects,
    string? HopperStatus,
    string? FirmwareVersion,
    bool? FirmwareUpdateAvailable)
{
    public static LitterRobotControlsDto From(LitterRobotControls c) =>
        new(c.SleepMode, c.NightLight, c.PanelLock, c.CanResetDrawer, c.CanAddLitter,
            c.SleepStartsUtc, c.SleepEndsUtc,
            c.Selects.ToDictionary(
                s => char.ToLowerInvariant(s.Key.ToString()[0]) + s.Key.ToString()[1..],
                s => new LitterSelectDto(s.Value.Current, s.Value.Options)),
            c.HopperStatus, c.FirmwareVersion, c.FirmwareUpdateAvailable);
}

/// <summary>
/// A multi-position setting. <c>Options</c> comes from the entity itself, so the panel offers exactly
/// what this robot accepts; an empty list means the setting is readable but not changeable from here.
/// </summary>
public sealed record LitterSelectDto(string? Current, IReadOnlyList<string> Options);

/// <summary>Target position for a robot switch.</summary>
public sealed record SwitchInput(bool On);

/// <summary>Target position for a multi-position setting, as one of the entity's declared options.</summary>
public sealed record SelectInput(string Option);

/// <summary>Whether automatic recovery should run for this robot.</summary>
public sealed record RecoveryInput(bool Enabled);

public sealed record RecoveryStateDto(
    bool Enabled,
    string? ActiveFaultCode,
    DateTimeOffset? FaultSinceUtc,
    int AttemptsThisEpisode,
    int AttemptsToday,
    DateTimeOffset? LastAttemptUtc,
    DateTimeOffset? NextAttemptDueUtc,
    string? HoldReason,
    int MaxAttemptsThisEpisode,
    int MaxAttemptsToday)
{
    /// <summary>
    /// <paramref name="episodeCeiling"/> is the per-episode limit *after* the per-code tightening —
    /// `otf`/`pd`/`spf` allow a single attempt, because one over-torque is a stray granule and a
    /// second means something is physically in the way. The panel reads "attempt 1 of 1" there, which
    /// is the honest count, not the configured 3.
    /// </summary>
    public static RecoveryStateDto From(RecoveryState r, int episodeCeiling, int dailyCeiling) => new(
        r.Enabled,
        r.ActiveFaultCode,
        r.FaultSinceUtc,
        r.AttemptsThisEpisode,
        r.AttemptsToday,
        r.LastAttemptUtc,
        r.NextAttemptDueUtc,
        r.HoldReason,
        episodeCeiling,
        dailyCeiling);
}

public sealed record RecoveryAttemptDto(
    int Id,
    string FaultCode,
    int AttemptNumber,
    string Step,
    string Outcome,
    string? ResultingCode,
    string? Detail,
    bool Manual,
    DateTime StartedAtUtc,
    DateTime? CompletedAtUtc)
{
    public static RecoveryAttemptDto From(LitterRobotRecovery r) => new(
        r.Id,
        r.FaultCode,
        r.AttemptNumber,
        r.Step.ToString(),
        r.Outcome.ToString(),
        r.ResultingCode,
        r.Detail,
        r.Manual,
        r.StartedAtUtc,
        r.CompletedAtUtc);
}

/// <summary>Outcome of a manual cycle request. <c>Reason</c> carries the robot's own refusal when it declines.</summary>
public sealed record CycleResultDto(
    bool Started, string Outcome, string Step, string? ResultingCode, string? Reason);
