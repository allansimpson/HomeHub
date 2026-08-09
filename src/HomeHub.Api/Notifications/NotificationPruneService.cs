namespace HomeHub.Api.Notifications;

/// <summary>
/// Applies the notification store's retention on a slow loop.
/// </summary>
/// <remarks>
/// <see cref="NotificationService.PruneAsync"/> existed but nothing called it, so retention was only
/// ever a filter on the way *out*: <c>ListAsync</c> hid old rows while the table itself grew without
/// bound. On a panel that runs for months that is not merely untidy — every
/// <see cref="NotificationService.RecordAsync"/> does a dedupe lookup, and that lookup was scanning
/// the whole accumulated history rather than the seven days anyone can actually see.
///
/// <para>Registered only alongside a database, like the rest of the DB-gated services. The interval
/// is deliberately long: nothing observable depends on a row disappearing promptly, and the startup
/// pass is the one that matters after a panel has been off for a while.</para>
/// </remarks>
public sealed class NotificationPruneService : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromHours(6);

    private readonly IServiceScopeFactory _scopes;
    private readonly ILogger<NotificationPruneService> _logger;

    public NotificationPruneService(IServiceScopeFactory scopes, ILogger<NotificationPruneService> logger)
    {
        _scopes = scopes;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var scope = _scopes.CreateScope();
                var notifications = scope.ServiceProvider.GetRequiredService<NotificationService>();
                var removed = await notifications.PruneAsync(stoppingToken);
                if (removed > 0) _logger.LogInformation("Pruned {Count} notifications past retention.", removed);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                // A database that is asleep or unreachable is not a reason to stop pruning forever;
                // the next pass picks it up. Retention is housekeeping, never load-bearing.
                _logger.LogWarning(ex, "Notification prune failed; retrying on the next pass.");
            }

            try
            {
                await Task.Delay(Interval, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }
}
