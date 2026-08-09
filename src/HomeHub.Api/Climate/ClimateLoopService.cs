namespace HomeHub.Api.Climate;

/// <summary>
/// Runs <see cref="ClimateLoop"/> once a minute for as long as the app is up.
/// </summary>
/// <remarks>
/// The loop is HomeHub's, not Home Assistant's and not Sensibo's. Put in HA it would live in YAML
/// outside the product and the panel could only report on it; left to Sensibo's own Climate React it
/// could only see the unit's own sensor, which is the very reading this section exists to stop
/// trusting (DECISIONS §1).
/// <para>
/// A minute is the tick, not the write rate — how often a unit may actually be told anything is the
/// per-zone minimum interval, which the loop enforces and the panel does not expose.
/// </para>
/// </remarks>
public sealed class ClimateLoopService : BackgroundService
{
    private static readonly TimeSpan Tick = TimeSpan.FromMinutes(1);

    private readonly IServiceScopeFactory _scopeFactory;
    private readonly TimeProvider _time;
    private readonly ILogger<ClimateLoopService> _logger;

    public ClimateLoopService(
        IServiceScopeFactory scopeFactory, TimeProvider time, ILogger<ClimateLoopService> logger)
    {
        _scopeFactory = scopeFactory;
        _time = time;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("Climate loop started; one tick per minute.");
        using var timer = new PeriodicTimer(Tick, _time);
        do
        {
            try
            {
                using var scope = _scopeFactory.CreateScope();
                var loop = scope.ServiceProvider.GetRequiredService<ClimateLoop>();
                await loop.TickAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                // A bad tick must never take the loop down: the next one is sixty seconds away, and a
                // room whose loop has stopped is a room nobody is holding.
                _logger.LogError(ex, "Climate loop tick failed; will retry on the next tick.");
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
