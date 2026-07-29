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
    /// <summary>True when the box is usable by the cat right now.</summary>
    public bool IsUsable => Fault.Class is LitterRobotFaultClass.Stable or LitterRobotFaultClass.Transient;
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
