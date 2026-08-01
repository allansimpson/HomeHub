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

    /// <summary>
    /// Levels, weights and fault-class share over the last <paramref name="days"/>, from Home
    /// Assistant's recorder. Null when the robot isn't known.
    /// </summary>
    /// <remarks>
    /// HomeHub stores no litter time series of its own, so this is the recorder's to give — and the
    /// recorder purges. The result says whether the window was actually covered rather than quietly
    /// returning a shorter one.
    /// </remarks>
    Task<LitterRobotHistory?> GetHistoryAsync(string slug, int days, CancellationToken ct);
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

    /// <summary>
    /// Zero the waste-drawer reading, after a person has emptied it.
    /// </summary>
    /// <remarks>
    /// Destructive in the only sense that matters here: pressing it without emptying the drawer leaves
    /// the panel confidently reporting 0% on a full drawer until the robot next refuses to cycle. The
    /// UI holds to confirm and asks the emptied-it question first.
    /// </remarks>
    Task ResetWasteDrawerAsync(string slug, CancellationToken ct);

    /// <summary>
    /// Reset the litter level to full, after a person has topped the globe up. Same shape and the same
    /// hazard as <see cref="ResetWasteDrawerAsync"/> — claiming a full globe that isn't full is how the
    /// recovery loop's litter floor gets bypassed.
    /// </summary>
    Task ResetLitterLevelAsync(string slug, CancellationToken ct);

    /// <summary>
    /// Set one of the robot's toggles. Fire-and-forget like every other command here — confirm by
    /// re-reading <see cref="LitterRobotSnapshot.Controls"/>, not by this returning.
    /// </summary>
    Task SetSwitchAsync(string slug, LitterRobotSwitch which, bool on, CancellationToken ct);

    /// <summary>
    /// Move one of the robot's multi-position settings.
    /// </summary>
    /// <remarks>
    /// Separate from <see cref="SetSwitchAsync"/> because these genuinely are not booleans — the night
    /// light is Off/Low/Medium/High. <paramref name="option"/> must be one of the values the entity
    /// declares; the caller checks that against the snapshot, because Home Assistant rejects an
    /// unknown option with an error that says nothing useful about which options exist.
    /// </remarks>
    Task SetSelectAsync(string slug, LitterRobotSelect which, string option, CancellationToken ct);
}
