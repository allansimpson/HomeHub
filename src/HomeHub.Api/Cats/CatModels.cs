namespace HomeHub.Api.Cats;

/// <summary>
/// How the Litter-Robot integration is doing. Kept distinguishable for the same reason
/// <see cref="Baby.HuckleberryStatus"/> is: "HA is down", "the integration isn't there" and "Whisker's
/// cloud is unreachable" need different fixes, and the panel should say which.
/// </summary>
public enum CatIntegrationStatus
{
    /// <summary>No HA config, or the section is switched off. Not an error.</summary>
    NotConfigured,
    Ok,
    /// <summary>Home Assistant itself did not answer.</summary>
    HomeAssistantUnreachable,
    /// <summary>HA answered but exposes no Litter-Robot entities.</summary>
    IntegrationMissing,
    /// <summary>Serving a cached snapshot after a failed refresh.</summary>
    Stale,
}

public sealed record CatHealth(CatIntegrationStatus Status, string? Detail, DateTimeOffset? LastGoodUtc);

/// <summary>A litter box, keyed by the entity-id slug HA derives from the robot's name in the Whisker app.</summary>
public sealed record LitterRobotDescriptor(string Slug, string Name);

/// <summary>
/// Everything the panel and the recovery loop need about one robot in a single read.
/// </summary>
/// <remarks>
/// Percentages and weight are nullable throughout: the LR3 can't measure litter level at all, and any
/// entity can be <c>unavailable</c> while Whisker's cloud is down. A missing value shows as unknown
/// rather than as zero — reading a null litter level as 0% would trip the empty-globe alert on every
/// cloud hiccup.
/// </remarks>
public sealed record LitterRobotSnapshot(
    string Slug,
    string Name,
    LitterRobotFault Fault,
    double? WasteDrawerPercent,
    double? LitterPercent,
    double? PetWeightLbs,
    int? TotalCycles,
    DateTimeOffset? LastSeenUtc,
    DateTimeOffset FetchedUtc,
    bool Stale)
{
    /// <summary>
    /// Which controls this robot actually exposes, and where the switches currently sit. Not positional
    /// so the recovery loop — which only cares about faults and levels — keeps constructing snapshots
    /// unchanged.
    /// </summary>
    public LitterRobotControls Controls { get; init; } = LitterRobotControls.None;

    /// <summary>
    /// When the robot entered its current status, from the status entity's <c>last_changed</c>.
    /// </summary>
    /// <remarks>
    /// Distinct from <see cref="FetchedUtc"/>, which is when *we* read. Mid-cycle the panel needs the
    /// moment the cycle began — using the read time instead would restate the start on every poll and
    /// reset any elapsed-time estimate built on it.
    /// </remarks>
    public DateTimeOffset? StatusSinceUtc { get; init; }

    /// <summary>
    /// Which generation of the hardware this is — <c>LR4</c> or <c>LR3</c>, or null when it cannot be
    /// told apart.
    /// </summary>
    /// <remarks>
    /// Home Assistant publishes no model attribute, so this is inferred from the one capability that
    /// actually separates the two: the LR4 measures litter level and the LR3 cannot. Inferred from the
    /// <em>entity's existence</em>, not from its value — an LR4 whose cloud connection has dropped
    /// reports <c>unavailable</c>, and that is still an LR4.
    ///
    /// <para>It exists for one line of UI: the panel names the box as the household does
    /// (<c>MIKA'S BOX · LR4</c>) rather than showing the entity slug, which carries a typo the
    /// household will never fix.</para>
    /// </remarks>
    public string? Model { get; init; }

    /// <summary>True when the box is usable by the cat right now.</summary>
    public bool IsUsable => Fault.Class is LitterRobotFaultClass.Stable or LitterRobotFaultClass.Transient;
}

/// <summary>
/// The switches and maintenance buttons Home Assistant exposes for one robot, and where the switches
/// currently sit.
/// </summary>
/// <remarks>
/// Switch states are nullable for the same reason the gauges are: an entity that is absent (the LR3 has
/// no panel lockout) or <c>unavailable</c> must read as unknown, never as "off". A control drawn in the
/// off position invites a press that goes nowhere, which is worse than a control that says it can't be
/// reached. The two button flags exist because a button has no state to read — presence in HA's entity
/// list is the only signal that pressing it will land.
/// </remarks>
public sealed record LitterRobotControls(
    bool? SleepMode,
    bool? NightLight,
    bool? PanelLock,
    bool CanResetDrawer,
    bool CanAddLitter)
{
    /// <summary>
    /// The scheduled quiet window, when the robot reports one.
    /// </summary>
    /// <remarks>
    /// Read-only, and separate from <see cref="SleepMode"/> on purpose: the current integration
    /// publishes the schedule as two timestamp sensors while exposing no switch to set it. A panel
    /// that can't change the setting can still say what it is, which beats a dead toggle.
    /// </remarks>
    public DateTimeOffset? SleepStartsUtc { get; init; }

    public DateTimeOffset? SleepEndsUtc { get; init; }

    /// <summary>
    /// The robot's multi-position settings, as Home Assistant publishes them.
    /// </summary>
    /// <remarks>
    /// These are <c>select</c> entities, not switches — the night light in particular is
    /// Off/Low/Medium/High, and rendering it as a toggle is the mistake the first design made. Each
    /// carries its current value and the options the entity itself declares, so the panel offers
    /// exactly what the robot accepts rather than a hardcoded list that drifts.
    /// </remarks>
    public IReadOnlyDictionary<LitterRobotSelect, LitterRobotSelectState> Selects { get; init; } =
        new Dictionary<LitterRobotSelect, LitterRobotSelectState>();

    /// <summary>The LitterHopper accessory's status, when one is fitted.</summary>
    public string? HopperStatus { get; init; }

    /// <summary>The firmware the robot is running, from its HA update entity.</summary>
    public string? FirmwareVersion { get; init; }

    /// <summary>
    /// Whether a firmware update is waiting. Read-only on the panel — updates are applied from the
    /// Whisker app, and a half-finished firmware flash on a box the cat needs is not a button worth
    /// putting on a wall.
    /// </summary>
    public bool? FirmwareUpdateAvailable { get; init; }

    /// <summary>Nothing known and nothing commandable — the not-connected and pre-refresh case.</summary>
    public static readonly LitterRobotControls None = new(null, null, null, false, false);
}

/// <summary>One multi-position setting: where it sits now, and what it will accept.</summary>
public sealed record LitterRobotSelectState(string? Current, IReadOnlyList<string> Options);

/// <summary>
/// The robot's <c>select</c> entities. Every one of these is commandable today and none were used by
/// the panel before the 2026-07-30 pass.
/// </summary>
public enum LitterRobotSelect
{
    /// <summary>Night light — Off / Low / Medium / High. Not a boolean.</summary>
    NightLight = 0,
    GlobeBrightness = 1,
    PanelBrightness = 2,
    /// <summary>How long the robot waits after the cat leaves before cycling — 3 / 7 / 15 minutes.</summary>
    CleanCycleWait = 3,
}

/// <summary>The robot's toggleable settings, as opposed to the momentary buttons.</summary>
public enum LitterRobotSwitch
{
    /// <summary>Suppresses cycling during the configured quiet hours.</summary>
    SleepMode = 0,
    NightLight = 1,
    /// <summary>Panel lockout — disables the buttons on the unit itself.</summary>
    PanelLock = 2,
}

/// <summary>Outcome of one recovery attempt, as recorded and as reported to the panel.</summary>
public enum RecoveryOutcome
{
    /// <summary>The attempt is in flight.</summary>
    Started = 0,
    /// <summary>The robot reached a stable or cycling state — verified by observed status, not by HTTP success.</summary>
    Recovered = 1,
    /// <summary>Commands were accepted but the robot stayed faulted.</summary>
    Failed = 2,
    /// <summary>Aborted before commanding, e.g. a cat arrived during the settle window.</summary>
    Aborted = 3,
    /// <summary>A command call itself threw (HA down, auth, timeout).</summary>
    Errored = 4,
}

/// <summary>
/// Which rung of the escalation ladder an attempt used. Only the first two are reachable through Home
/// Assistant; <see cref="ShortReset"/> and <see cref="PowerCycle"/> exist for the direct-Whisker
/// command implementation, whose <c>SHORT_RESET_PRESS</c> and discrete power commands HA exposes no
/// entity for.
/// </summary>
public enum RecoveryStep
{
    /// <summary>Gentlest: short press of reset. Direct-Whisker only.</summary>
    ShortReset = 0,
    /// <summary>Full device reset — <c>button.{robot}_reset</c> in HA.</summary>
    Reset = 1,
    /// <summary>Start a clean cycle — <c>vacuum.start</c> in HA.</summary>
    CleanCycle = 2,
    /// <summary>Power off, wait, power on. Direct-Whisker only.</summary>
    PowerCycle = 3,
}

/// <summary>
/// Live recovery state for one robot, for the panel's "auto-recovery" line. Distinct from the
/// persisted <see cref="LitterRobotRecovery"/> rows, which are the audit trail.
/// </summary>
public sealed record RecoveryState(
    string Slug,
    bool Enabled,
    string? ActiveFaultCode,
    DateTimeOffset? FaultSinceUtc,
    int AttemptsThisEpisode,
    int AttemptsToday,
    DateTimeOffset? LastAttemptUtc,
    DateTimeOffset? NextAttemptDueUtc,
    string? HoldReason);
