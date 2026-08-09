namespace HomeHub.Api.Assist;

using HomeHub.Api.Ai;
using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// Works through the pending session deletions until every one is confirmed absent.
/// </summary>
/// <remarks>
/// <para>
/// The household's retention promise is only as good as its worst day. A conversation deleted while
/// Hermes was restarting must still lose its transcripts once Hermes comes back — so deletion is a
/// durable queue drained in the background, not a best-effort loop inside the request that happened
/// to notice.
/// </para>
/// <para>
/// Deliberately unhurried: this is cleanup nobody is waiting on, and hammering a busy agent to remove
/// something that is already invisible to the household would be the wrong trade.
/// </para>
/// </remarks>
public sealed class SessionDeletionWorker : BackgroundService
{
    /// <summary>How often to look for work. Slow on purpose — see the class remarks.</summary>
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(2);

    /// <summary>
    /// Attempts before a row is left alone and reported.
    /// </summary>
    /// <remarks>
    /// It is never discarded. A tombstone that has given up is the record that a transcript is still
    /// out there — deleting it would turn a known problem into an invisible one.
    /// </remarks>
    public const int MaxAttempts = 12;

    private readonly IServiceScopeFactory _scopes;
    private readonly ILogger<SessionDeletionWorker> _logger;

    public SessionDeletionWorker(IServiceScopeFactory scopes, ILogger<SessionDeletionWorker> logger)
    {
        _scopes = scopes;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await DrainAsync(ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // A failure here must not take the worker down; the queue is durable and the next
                // pass will find the same rows.
                _logger.LogError(ex, "Session deletion pass failed.");
            }

            try { await Task.Delay(Interval, ct); }
            catch (OperationCanceledException) { return; }
        }
    }

    /// <summary>One pass. Public so a test can drive it without waiting for the timer.</summary>
    public async Task<int> DrainAsync(CancellationToken ct)
    {
        using var scope = _scopes.CreateScope();
        var db = scope.ServiceProvider.GetService<HomeHubDbContext>();
        if (db is null) return 0; // no database configured — nothing was ever queued

        var hermes = scope.ServiceProvider.GetRequiredService<HermesClient>();
        var roster = scope.ServiceProvider.GetRequiredService<AgentRoster>();
        var now = DateTime.UtcNow;

        var due = await db.HermesSessionDeletions
            .Where(d => d.CompletedAtUtc == null
                && d.Attempts < MaxAttempts
                && (d.NextAttemptUtc == null || d.NextAttemptUtc <= now))
            .OrderBy(d => d.RequestedAtUtc)
            .Take(50)
            .ToListAsync(ct);

        if (due.Count == 0) return 0;

        var completed = 0;
        foreach (var row in due)
        {
            var agent = roster.Find(row.AgentKey);
            if (agent is null || !agent.IsConfigured)
            {
                // The agent has been removed from configuration. Nothing can be deleted from a
                // gateway that is no longer described, and pretending otherwise would quietly mark a
                // surviving transcript as gone.
                row.Attempts++;
                row.LastError = $"Agent '{row.AgentKey}' is not configured on this panel.";
                row.NextAttemptUtc = now.Add(Backoff(row.Attempts));
                continue;
            }

            row.Attempts++;
            try
            {
                // 404 counts as done: the outcome asked for already holds for this id. It says
                // nothing about the rest of the lineage — which is why each id has its own row.
                if (await hermes.DeleteSessionAsync(agent.Key, row.SessionId, ct))
                {
                    row.CompletedAtUtc = DateTime.UtcNow;
                    row.LastError = null;
                    completed++;
                }
                else
                {
                    row.LastError = "The agent did not confirm the deletion.";
                    row.NextAttemptUtc = now.Add(Backoff(row.Attempts));
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // Message only, never the exception's full detail — an auth failure is where a
                // misconfigured deployment is most likely to reflect a credential back.
                row.LastError = ex.GetType().Name;
                row.NextAttemptUtc = now.Add(Backoff(row.Attempts));
            }
        }

        await db.SaveChangesAsync(ct);

        var stuck = due.Count(d => d.CompletedAtUtc is null && d.Attempts >= MaxAttempts);
        if (stuck > 0)
            _logger.LogWarning(
                "{Count} Hermes transcript(s) could not be deleted after {Max} attempts and remain on the agent.",
                stuck, MaxAttempts);

        return completed;
    }

    /// <summary>Exponential, capped at an hour. Cleanup nobody is waiting for can afford to be patient.</summary>
    private static TimeSpan Backoff(int attempts) =>
        TimeSpan.FromSeconds(Math.Min(3600, 30 * Math.Pow(2, Math.Min(attempts, 7))));
}
