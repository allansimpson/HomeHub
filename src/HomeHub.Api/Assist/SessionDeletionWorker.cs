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
    /// Attempts before a row is reported as stuck and its retries slow to a daily cadence.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>It is never discarded, and it is no longer excluded either.</b> The row used to drop out of
    /// the query at this count — kept as a record, and inert. So a Hermes that was down for a day, or
    /// a gateway whose credential was rotated and then fixed, left the household's transcripts on the
    /// agent for ever with nothing that would ever try again. "Never discarded" was true and was not
    /// the promise that mattered.
    /// </para>
    /// <para>
    /// Past this count the backoff goes to {@link StuckRetry} and the warning is logged, which is what
    /// the threshold is actually for: telling somebody. The retry continues, because the transcript is
    /// still there and the agent may come back at any time.
    /// </para>
    /// </remarks>
    public const int MaxAttempts = 12;

    /// <summary>
    /// How often a row that has passed {@link MaxAttempts} tries again.
    /// </summary>
    /// <remarks>
    /// Daily rather than hourly: at this point the agent has refused a dozen times over several hours,
    /// so the next attempt is not about to succeed, and a household's deleted transcript surviving one
    /// more day on a machine in their own house is the lesser of the two costs. What matters is that
    /// there is a next attempt at all.
    /// </remarks>
    private static readonly TimeSpan StuckRetry = TimeSpan.FromHours(24);

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

        /*
         * Every incomplete row, however many times it has failed.
         *
         * `d.Attempts < MaxAttempts` used to be here, and it made a tombstone that had given up into a
         * tombstone that would never be tried again — the household's transcript left on the agent
         * with no path back even once Hermes recovered. The count still means something: past it the
         * backoff widens to a day and the warning is logged. It no longer means "stop".
         */
        var due = await db.HermesSessionDeletions
            .Where(d => d.CompletedAtUtc == null
                && (d.NextAttemptUtc == null || d.NextAttemptUtc <= now))
            .OrderBy(d => d.RequestedAtUtc)
            .Take(50)
            .ToListAsync(ct);

        if (due.Count == 0) return 0;

        /*
         * Descendants first, because a lineage can grow after the conversation is gone.
         *
         * A tombstone names the sessions HomeHub knew about when the row was removed. Hermes rotates a
         * session into a child when it compresses, and that can happen after the delete, or between
         * the check that authorised it and the drain — at which point the child is a transcript of the
         * household's words with nothing left pointing at it. The local anchor is gone by then, so the
         * only remaining anchor is the tombstone itself, and this is where it can still be followed.
         *
         * Once per agent per pass rather than once per row: the index read is the cost, and a household
         * deleting a long conversation would otherwise pay it for every session in the lineage.
         */
        await ExpandLineageAsync(due, roster, db, hermes, ct);

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

    /// <summary>
    /// Add a tombstone for every descendant of a pending one that is not already recorded.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>The half of the promise that could not be kept at deletion time.</b> Deleting writes down
    /// what HomeHub knew; a compression afterwards creates a child it never saw, and the conversation
    /// row that would have recorded it has been removed. Expanding here means the obligation grows to
    /// match the lineage instead of being fixed at the moment it was made — and it works while the
    /// agent is down, because the drain simply retries.
    /// </para>
    /// <para>
    /// Failure is not fatal and not silent: the pass continues with what it has, and the descendants
    /// are found on a later one. A tombstone that cannot be expanded is still a tombstone.
    /// </para>
    /// </remarks>
    private async Task ExpandLineageAsync(
        IReadOnlyList<HermesSessionDeletion> due,
        AgentRoster roster,
        HomeHubDbContext db,
        HermesClient hermes,
        CancellationToken ct)
    {
        foreach (var agentKey in due.Select(d => d.AgentKey).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var agent = roster.Find(agentKey);
            if (agent is null || !agent.IsConfigured) continue;

            List<HermesSessionSummary> sessions;
            try
            {
                sessions = await hermes.AllSessionsAsync(agentKey, ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogDebug(ex, "Could not read {Agent}'s session index to expand lineage.", agentKey);
                continue;
            }
            if (sessions.Count == 0) continue;

            var childrenOf = sessions
                .Where(s => s.ParentSessionId is { Length: > 0 })
                .GroupBy(s => s.ParentSessionId!, StringComparer.Ordinal)
                .ToDictionary(g => g.Key, g => g.Select(s => s.Id).ToList(), StringComparer.Ordinal);

            foreach (var row in due.Where(d => string.Equals(d.AgentKey, agentKey, StringComparison.OrdinalIgnoreCase)))
            {
                foreach (var descendant in Descendants(row.SessionId, childrenOf))
                {
                    var already = await db.HermesSessionDeletions.AnyAsync(
                        d => d.AgentKey == agentKey && d.SessionId == descendant, ct);
                    if (already) continue;

                    db.HermesSessionDeletions.Add(new HermesSessionDeletion
                    {
                        ConversationId = row.ConversationId,
                        AgentKey = agentKey,
                        SessionId = descendant,
                        RequestedAtUtc = DateTime.UtcNow,
                    });
                    _logger.LogInformation(
                        "Lineage grew after deletion: session {Session} on {Agent} descends from a "
                        + "tombstoned one and is now queued for deletion too.",
                        descendant, agentKey);
                }
            }
        }

        await db.SaveChangesAsync(ct);
    }

    /// <summary>Every session below this one, breadth-first, cycle-safe.</summary>
    private static IEnumerable<string> Descendants(
        string root, IReadOnlyDictionary<string, List<string>> childrenOf)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal) { root };
        var queue = new Queue<string>([root]);
        while (queue.Count > 0)
        {
            if (!childrenOf.TryGetValue(queue.Dequeue(), out var children)) continue;
            foreach (var child in children.Where(seen.Add))
            {
                queue.Enqueue(child);
                yield return child;
            }
        }
    }

    /// <summary>
    /// Exponential to an hour, then daily once the row is reported stuck.
    /// </summary>
    /// <remarks>
    /// Cleanup nobody is waiting for can afford to be patient — and must not stop. The daily tier is
    /// what replaced excluding the row from the query entirely; see {@link MaxAttempts}.
    /// </remarks>
    private static TimeSpan Backoff(int attempts) =>
        attempts >= MaxAttempts
            ? StuckRetry
            : TimeSpan.FromSeconds(Math.Min(3600, 30 * Math.Pow(2, Math.Min(attempts, 7))));
}
