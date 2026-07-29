namespace HomeHub.Api.Cats;

using HomeHub.Api.HomeAssistant;

/// <summary>
/// The write half of the litter-box seam, over Home Assistant. Reaches two rungs of the escalation
/// ladder: <see cref="RecoveryStep.Reset"/> via the robot's reset button, and
/// <see cref="RecoveryStep.CleanCycle"/> via the vacuum entity.
/// </summary>
/// <remarks>
/// The two rungs HA can't reach:
/// <list type="bullet">
/// <item><b>Short reset</b> — the Whisker API's <c>SHORT_RESET_PRESS</c> clears a fault and re-homes
/// without a full reboot, but HA exposes no entity for it. Only the blunt full reset is available here.</item>
/// <item><b>Power cycle</b> — HA folds power-off into <c>vacuum.stop</c> and has no discrete power-on,
/// so a controlled off/wait/on can't be expressed safely.</item>
/// </list>
/// Both are why <see cref="ILitterRobotCommands"/> exists as a seam rather than being folded into the
/// provider: a direct-Whisker implementation adds those rungs without the recovery loop changing.
///
/// <para>Also note <c>vacuum.start</c> is not a pure "start cycle" in HA — the integration sends
/// <c>set_power_status(True)</c> before <c>start_cleaning()</c>, so starting a cycle silently powers a
/// deliberately-powered-off robot back on. That side effect is acceptable during recovery (a
/// powered-off robot is already unusable) but it is the reason <c>off</c> is classified
/// <see cref="LitterRobotFaultClass.Offline"/> and never auto-recovered.</para>
/// </remarks>
public sealed class HomeAssistantLitterRobotCommands : ILitterRobotCommands
{
    // Candidate entity ids, most-likely first — HA names the vacuum entity "Litter box" under the
    // device, but a single-entity device can collapse to the bare device slug.
    private static readonly string[] VacuumCandidates = ["vacuum.{0}_litter_box", "vacuum.{0}"];
    private static readonly string[] ResetButtonCandidates = ["button.{0}_reset"];

    private readonly HomeAssistantClient _ha;
    private readonly ILogger<HomeAssistantLitterRobotCommands> _logger;

    public HomeAssistantLitterRobotCommands(
        HomeAssistantClient ha,
        ILogger<HomeAssistantLitterRobotCommands> logger)
    {
        _ha = ha;
        _logger = logger;
    }

    public bool Supports(RecoveryStep step) =>
        step is RecoveryStep.Reset or RecoveryStep.CleanCycle;

    public async Task ResetAsync(string slug, CancellationToken ct)
    {
        var entity = await ResolveAsync(slug, ResetButtonCandidates, ct)
            ?? throw new InvalidOperationException(
                $"No reset button entity found for '{slug}'. Expected button.{slug}_reset — note the " +
                "reset button exists only for Litter-Robot 4 and 5.");

        _logger.LogInformation("Pressing reset for {Slug} ({Entity}).", slug, entity);
        await _ha.CallServiceAsync("button", "press", new { entity_id = entity }, ct);
    }

    public async Task StartCleanCycleAsync(string slug, CancellationToken ct)
    {
        var entity = await ResolveAsync(slug, VacuumCandidates, ct)
            ?? throw new InvalidOperationException(
                $"No vacuum entity found for '{slug}'. Expected vacuum.{slug}_litter_box.");

        _logger.LogInformation("Starting clean cycle for {Slug} ({Entity}).", slug, entity);
        await _ha.CallServiceAsync("vacuum", "start", new { entity_id = entity }, ct);
    }

    public Task ShortResetAsync(string slug, CancellationToken ct) =>
        throw new NotSupportedException(
            "Home Assistant exposes no short-reset entity; use the direct Whisker command provider for SHORT_RESET_PRESS.");

    public Task PowerCycleAsync(string slug, CancellationToken ct) =>
        throw new NotSupportedException(
            "Home Assistant conflates power-off into vacuum.stop and offers no discrete power-on; use the direct Whisker command provider.");

    /// <summary>
    /// First candidate entity HA actually knows. Resolved per call rather than cached because an entity
    /// can be renamed or replaced at any time, and a stale id would mean commands going nowhere while
    /// every call still looked successful.
    /// </summary>
    private async Task<string?> ResolveAsync(string slug, string[] candidates, CancellationToken ct)
    {
        foreach (var pattern in candidates)
        {
            var entity = string.Format(System.Globalization.CultureInfo.InvariantCulture, pattern, slug);
            if (await _ha.GetStateAsync(entity, ct) is not null) return entity;
        }
        return null;
    }
}
