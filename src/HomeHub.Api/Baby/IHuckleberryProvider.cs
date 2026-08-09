namespace HomeHub.Api.Baby;

/// <summary>
/// The Huckleberry seam. <see cref="HuckleberryHomeAssistantProvider"/> is the chosen path (HA-first,
/// via the Huckleberry HACS integration); a direct FastAPI sidecar wrapping Woyken's
/// <c>huckleberry-api</c> is the documented fallback behind this same interface if HA's coverage
/// gaps bite. <see cref="NotConnectedHuckleberryProvider"/> stands in when HA isn't configured, so
/// the app boots and the Baby section honestly reads "Not connected".
/// </summary>
/// <remarks>
/// Huckleberry is the system of record — HomeHub never stores baby data, it displays it and asks
/// Huckleberry to record changes.
/// <para>
/// <b>Writes never queue.</b> Unlike the Stage 9b offline write-queue used for calendar and tasks,
/// a failed baby write fails visibly: a silently delayed "fell asleep" timestamp is worse than an
/// obvious error. The 9b queue is opt-in per provider, so this simply doesn't enlist.
/// </para>
/// <para>
/// <b>Writes are irreversible.</b> The integration exposes no delete or edit service (verified at
/// Gate H0.2), so nothing written here can be retracted by HomeHub — only in the Huckleberry app.
/// </para>
/// </remarks>
public interface IHuckleberryProvider
{
    /// <summary>False when HA isn't configured; the panel shows "Not connected" rather than an error.</summary>
    bool IsConfigured { get; }

    /// <summary>Distinguishes not-configured / HA-down / integration-missing / stale.</summary>
    Task<HuckleberryHealth> GetHealthAsync(CancellationToken ct);

    /// <summary>The children the integration exposes.</summary>
    Task<IReadOnlyList<BabyChild>> GetChildrenAsync(CancellationToken ct);

    /// <summary>Current state for one child, or null when that child isn't known.</summary>
    Task<BabyState?> GetStateAsync(string childKey, CancellationToken ct);

    /// <summary>
    /// History over a window, from the child's HA calendar entity. Returns empty when the calendar
    /// entity is absent or its payloads are unusable (Gate H0.3) — an empty history is a display
    /// state, not a failure.
    /// </summary>
    Task<IReadOnlyList<BabyHistoryEvent>> GetHistoryAsync(
        string childKey, DateTimeOffset fromUtc, DateTimeOffset toUtc, CancellationToken ct);

    /// <summary>
    /// Drives a sleep or nursing timer. <paramref name="side"/> applies only to nursing start/resume
    /// and is ignored elsewhere.
    /// </summary>
    Task<BabyWriteResult> TimerActionAsync(
        string childKey, BabyTimerKind timer, BabyTimerAction action, NursingSide? side, CancellationToken ct);

    /// <summary>Logs a diaper change now. There is no way to log one retroactively.</summary>
    Task<BabyWriteResult> LogDiaperAsync(string childKey, DiaperEntry entry, CancellationToken ct);

    /// <summary>Logs a bottle feed now.</summary>
    Task<BabyWriteResult> LogBottleAsync(string childKey, BottleEntry entry, CancellationToken ct);

    /// <summary>
    /// Logs growth measurements. Irreversible and chart-affecting — callers should confirm before
    /// calling, and must be certain of the unit system.
    /// </summary>
    Task<BabyWriteResult> LogGrowthAsync(string childKey, GrowthEntry entry, CancellationToken ct);
}
