namespace HomeHub.Api.Cats;

/// <summary>
/// Read side of the litter-box seam: discovery, status snapshots, health. Deliberately split from
/// <see cref="ILitterRobotCommands"/> so the recovery loop's write path can be swapped for direct
/// Whisker access without touching reads (which HA already serves well, over its own push updates).
/// </summary>
public interface ILitterRobotProvider
{
    bool IsConfigured { get; }

    Task<CatHealth> GetHealthAsync(CancellationToken ct);

    /// <summary>The robots the integration exposes. Empty when not connected.</summary>
    Task<IReadOnlyList<LitterRobotDescriptor>> GetRobotsAsync(CancellationToken ct);

    /// <summary>Current snapshot for one robot, or null when it isn't known.</summary>
    Task<LitterRobotSnapshot?> GetSnapshotAsync(string slug, CancellationToken ct);

    /// <summary>
    /// Snapshots for every robot, bypassing the display cache. The recovery loop uses this: acting on
    /// a cached status would mean commanding the robot based on where it was up to ten seconds ago.
    /// </summary>
    Task<IReadOnlyList<LitterRobotSnapshot>> GetFreshSnapshotsAsync(CancellationToken ct);
}

/// <summary>
/// Write side of the litter-box seam — the escalation ladder. Implementations report which rungs they
/// can actually reach via <see cref="Supports"/>, because Home Assistant exposes no entity for a short
/// reset press or for discrete power commands, while the Whisker cloud API accepts both.
/// </summary>
/// <remarks>
/// Every method here is fire-and-forget from the robot's point of view: the device accepts commands it
/// then silently ignores (a clean cycle requested while a cat is detected is accepted and dropped,
/// with no error). So a successful call proves only that the command was delivered. Recovery is
/// verified by re-reading status through <see cref="ILitterRobotProvider"/> — never by the absence of
/// an exception here.
/// </remarks>
public interface ILitterRobotCommands
{
    /// <summary>Whether this implementation can perform <paramref name="step"/>.</summary>
    bool Supports(RecoveryStep step);

    /// <summary>Clear a fault and re-home the globe.</summary>
    Task ResetAsync(string slug, CancellationToken ct);

    /// <summary>Start a clean cycle.</summary>
    Task StartCleanCycleAsync(string slug, CancellationToken ct);

    /// <summary>
    /// Short press of the reset button — clears the fault and re-homes without a full device reboot.
    /// Throws <see cref="NotSupportedException"/> when <see cref="Supports"/> says no.
    /// </summary>
    Task ShortResetAsync(string slug, CancellationToken ct);

    /// <summary>
    /// Power off, wait, power on. Throws <see cref="NotSupportedException"/> when unsupported.
    /// </summary>
    Task PowerCycleAsync(string slug, CancellationToken ct);
}
