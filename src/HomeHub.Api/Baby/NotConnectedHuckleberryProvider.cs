namespace HomeHub.Api.Baby;

/// <summary>
/// Stands in when Home Assistant isn't configured. There is deliberately no simulated Huckleberry
/// provider: unlike climate or sensors, fake baby data is worse than none — a demo weight or a
/// pretend sleep timer is indistinguishable from the real thing on a wall panel. The Baby section
/// renders "Not connected" instead, which is honest and unmistakable.
/// </summary>
public sealed class NotConnectedHuckleberryProvider : IHuckleberryProvider
{
    public bool IsConfigured => false;

    public Task<HuckleberryHealth> GetHealthAsync(CancellationToken ct) =>
        Task.FromResult(new HuckleberryHealth(
            HuckleberryStatus.NotConfigured,
            "Home Assistant is not configured, so Huckleberry is unavailable.",
            null));

    public Task<IReadOnlyList<BabyChild>> GetChildrenAsync(CancellationToken ct) =>
        Task.FromResult<IReadOnlyList<BabyChild>>([]);

    public Task<BabyState?> GetStateAsync(string childKey, CancellationToken ct) =>
        Task.FromResult<BabyState?>(null);

    public Task<IReadOnlyList<BabyHistoryEvent>> GetHistoryAsync(
        string childKey, DateTimeOffset fromUtc, DateTimeOffset toUtc, CancellationToken ct) =>
        Task.FromResult<IReadOnlyList<BabyHistoryEvent>>([]);

    // Writes fail rather than pretending to succeed — the panel must never imply it recorded
    // something Huckleberry never received.
    private static Task<BabyWriteResult> NotConnected() =>
        Task.FromResult(BabyWriteResult.Fail("Huckleberry is not connected."));

    public Task<BabyWriteResult> TimerActionAsync(
        string childKey, BabyTimerKind timer, BabyTimerAction action, NursingSide? side, CancellationToken ct) =>
        NotConnected();

    public Task<BabyWriteResult> LogDiaperAsync(string childKey, DiaperEntry entry, CancellationToken ct) =>
        NotConnected();

    public Task<BabyWriteResult> LogBottleAsync(string childKey, BottleEntry entry, CancellationToken ct) =>
        NotConnected();

    public Task<BabyWriteResult> LogGrowthAsync(string childKey, GrowthEntry entry, CancellationToken ct) =>
        NotConnected();
}
