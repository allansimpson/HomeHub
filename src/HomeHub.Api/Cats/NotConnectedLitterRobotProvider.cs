namespace HomeHub.Api.Cats;

/// <summary>
/// Stand-in when Home Assistant isn't configured or the section is switched off. Reports "not
/// connected" rather than simulating a litter box: a fake globe position or a fake litter level would
/// be a claim about a real animal's facilities, and the honest empty state is more useful than a demo.
/// </summary>
public sealed class NotConnectedLitterRobotProvider : ILitterRobotProvider
{
    public bool IsConfigured => false;

    public Task<CatHealth> GetHealthAsync(CancellationToken ct) =>
        Task.FromResult(new CatHealth(
            CatIntegrationStatus.NotConfigured,
            "Home Assistant is not configured, so the litter box can't be read.",
            null));

    public Task<IReadOnlyList<LitterRobotDescriptor>> GetRobotsAsync(CancellationToken ct) =>
        Task.FromResult<IReadOnlyList<LitterRobotDescriptor>>([]);

    public Task<LitterRobotSnapshot?> GetSnapshotAsync(string slug, CancellationToken ct) =>
        Task.FromResult<LitterRobotSnapshot?>(null);

    public Task<IReadOnlyList<LitterRobotSnapshot>> GetFreshSnapshotsAsync(CancellationToken ct) =>
        Task.FromResult<IReadOnlyList<LitterRobotSnapshot>>([]);

    public Task<LitterRobotHistory?> GetHistoryAsync(string slug, int days, CancellationToken ct) =>
        Task.FromResult<LitterRobotHistory?>(null);
}

/// <summary>Command seam stand-in; every rung refuses rather than pretending to have acted.</summary>
public sealed class NotConnectedLitterRobotCommands : ILitterRobotCommands
{
    private const string Message = "Home Assistant is not configured, so no litter-box command can be sent.";

    public bool Supports(RecoveryStep step) => false;

    public Task ResetAsync(string slug, CancellationToken ct) => throw new InvalidOperationException(Message);

    public Task StartCleanCycleAsync(string slug, CancellationToken ct) => throw new InvalidOperationException(Message);

    public Task ShortResetAsync(string slug, CancellationToken ct) => throw new NotSupportedException(Message);

    public Task PowerCycleAsync(string slug, CancellationToken ct) => throw new NotSupportedException(Message);

    public Task ResetWasteDrawerAsync(string slug, CancellationToken ct) => throw new InvalidOperationException(Message);

    public Task ResetLitterLevelAsync(string slug, CancellationToken ct) => throw new InvalidOperationException(Message);

    public Task SetSwitchAsync(string slug, LitterRobotSwitch which, bool on, CancellationToken ct) =>
        throw new InvalidOperationException(Message);

    public Task SetSelectAsync(string slug, LitterRobotSelect which, string option, CancellationToken ct) =>
        throw new InvalidOperationException(Message);
}
