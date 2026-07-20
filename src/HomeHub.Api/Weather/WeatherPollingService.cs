namespace HomeHub.Api.Weather;

using HomeHub.Api.Data;
using Microsoft.Extensions.Options;

/// <summary>
/// Refreshes weather + NWS alerts on the configured interval, caching last-known in SQL.
/// Resilient: a failed fetch is logged and retried next tick, keeping last-known visible. Only
/// registered when a database is configured.
/// </summary>
public sealed class WeatherPollingService : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly WeatherOptions _options;
    private readonly ILogger<WeatherPollingService> _logger;

    public WeatherPollingService(
        IServiceScopeFactory scopeFactory,
        IOptions<WeatherOptions> options,
        ILogger<WeatherPollingService> logger)
    {
        _scopeFactory = scopeFactory;
        _options = options.Value;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var interval = TimeSpan.FromMinutes(Math.Max(1, _options.PollMinutes));
        _logger.LogInformation("Weather poller started; interval {Minutes}m.", _options.PollMinutes);

        using var timer = new PeriodicTimer(interval);
        do
        {
            try
            {
                using var scope = _scopeFactory.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
                var refresher = scope.ServiceProvider.GetRequiredService<WeatherRefresher>();
                await refresher.RefreshAsync(db, DateTime.UtcNow, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Weather refresh failed; last-known stays cached, will retry.");
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
