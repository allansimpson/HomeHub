namespace HomeHub.Api.Assist;

using HomeHub.Api.Data;
using HomeHub.Api.Settings;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// Forgetting conversations the household has said it no longer wants kept.
/// </summary>
/// <remarks>
/// <para>
/// <b>Split out of <c>AssistController</c> because it was doing two things wrong in one method.</b>
/// The sweep ran inside a member's conversation-list read and deleted <i>every</i> expired
/// conversation in the household — so opening Assist as one member destroyed another member's chats,
/// which is the boundary AUDIT A1.2 exists to hold. And it removed the HomeHub rows and their lineage
/// references without recording anything about the Hermes transcripts behind them, so the agent kept
/// what the panel had just promised to forget.
/// </para>
/// <para>
/// <b>Tombstones, not round-trips.</b> The old comment argued against deleting agent sessions here on
/// the grounds that it would put N HTTP calls inside a list read that runs on every poll. That
/// reasoning was right and the conclusion did not follow: writing a
/// <see cref="HermesSessionDeletion"/> is a database row, and <see cref="SessionDeletionWorker"/>
/// drains the queue in the background. The obligation is recorded synchronously and discharged
/// slowly, which is what the explicit delete already does.
/// </para>
/// <para>
/// <b>Two entry points, because retention is a household policy applied to one member's data.</b>
/// {@link SweepForAsync} runs in a member's own read and touches only their conversations — prompt,
/// and incapable of reaching anybody else. {@link SweepHouseholdAsync} runs in the background so a
/// member who has stopped opening Assist still has their old chats forgotten on schedule; without it,
/// scoping the request path would have quietly turned retention off for exactly the people who use
/// the panel least.
/// </para>
/// </remarks>
public sealed class AssistRetention
{
    private readonly HomeHubDbContext _db;
    private readonly ILogger<AssistRetention> _logger;

    public AssistRetention(HomeHubDbContext db, ILogger<AssistRetention> logger)
    {
        _db = db;
        _logger = logger;
    }

    /// <summary>Forget this member's expired conversations. Returns how many were removed.</summary>
    public Task<int> SweepForAsync(HouseholdSettings settings, int? profileId, CancellationToken ct) =>
        SweepAsync(settings, c => c.ProfileId == profileId, ct);

    /// <summary>Forget every member's expired conversations. For the background pass only.</summary>
    public Task<int> SweepHouseholdAsync(HouseholdSettings settings, CancellationToken ct) =>
        SweepAsync(settings, _ => true, ct);

    private async Task<int> SweepAsync(
        HouseholdSettings settings,
        System.Linq.Expressions.Expression<Func<Conversation, bool>> scope,
        CancellationToken ct)
    {
        var retentionDays = settings.ConversationRetentionDays;

        /*
         * <b>Nothing is deleted until somebody has looked at this database's lineage.</b>
         *
         * The tombstones below cover every session HomeHub knows about, and on a database that
         * predates lineage recording that is not every session there is: a chain that became
         * <c>A → B → C</c> while only <c>A</c> was stored resolves to <c>C</c>, so B is never
         * tombstoned and stays on the agent with its messages once the local row is gone. Deleting
         * first and auditing afterwards cannot recover it — the anchor is the thing being deleted.
         *
         * Retention is automatic, so it is the path where that would happen without anybody choosing
         * it. It waits. `LineageAuditedAtUtc` is stamped at startup for a database with no history to
         * be incomplete about, and by running the lineage report otherwise.
         */
        if (settings.LineageAuditedAtUtc is null)
        {
            _logger.LogWarning(
                "Assist retention is paused: this database's historical Hermes lineage has not been "
                + "audited, so deleting a conversation could leave intermediate transcripts on the "
                + "agent with nothing left to find them by. Run the lineage report to release it.");
            return 0;
        }

        // Zero days means never, and it is a real setting rather than an absent one: a household that
        // wants to keep its own conversations indefinitely should not have to express that as "365
        // days and remember to come back". Nothing is swept in that state — not "swept less often".
        if (retentionDays <= 0) return 0;

        var cutoff = DateTime.UtcNow.AddDays(-retentionDays);
        var expired = await _db.Conversations
            .Where(scope)
            .Where(c => c.LastAtUtc < cutoff)
            .Include(c => c.SessionReferences)
            .ToListAsync(ct);
        if (expired.Count == 0) return 0;

        var now = DateTime.UtcNow;
        foreach (var row in expired)
        {
            /*
             * Every session this conversation ever had, not only the one it ended on.
             *
             * A long chat is re-sessioned as it goes — a restart, a model change, a lineage fork — and
             * the transcripts of the earlier ones are as much the household's words as the last. The
             * explicit delete walks the same lineage; retention was walking none of it.
             */
            var lineage = row.SessionReferences
                .Select(s => s.SessionId)
                .Concat(row.HermesSessionId is { Length: > 0 } current ? [current] : Array.Empty<string>())
                .Distinct(StringComparer.Ordinal);

            foreach (var sessionId in lineage)
            {
                _db.HermesSessionDeletions.Add(new HermesSessionDeletion
                {
                    ConversationId = row.Id,
                    // The profile travels with the id. A Barnaby session means nothing to Geist's
                    // database, so this is the only endpoint it may ever be sent to.
                    AgentKey = row.AgentKey,
                    SessionId = sessionId,
                    RequestedAtUtc = now,
                });
            }
        }

        // Messages and lineage references go with the conversations by cascade — see HomeHubDbContext,
        // where that cascade is a privacy guarantee rather than a convenience. The tombstones do not
        // cascade, which is the entire point of them: the obligation has to outlive the row.
        _db.Conversations.RemoveRange(expired);
        await _db.SaveChangesAsync(ct);

        _logger.LogInformation(
            "Assist retention swept {Count} conversations older than {Days} days.",
            expired.Count, retentionDays);
        return expired.Count;
    }
}

/// <summary>
/// Applies the household's conversation retention on a schedule rather than on somebody's read.
/// </summary>
/// <remarks>
/// <para>
/// Retention is a household policy about household data, and the request path can only be trusted
/// with one member's own — so the part that reaches everybody has to happen where no member is
/// asking. Without this, scoping the read to its caller would have meant a member who stopped opening
/// Assist kept their old conversations for ever, which is the retention promise failing quietly for
/// the people least likely to notice.
/// </para>
/// <para>
/// Unhurried on purpose, like <see cref="SessionDeletionWorker"/> beside it. The unit of this setting
/// is days; an hour's lag in applying it is not a thing anybody can perceive, and a tight loop over
/// the whole conversation table would be.
/// </para>
/// </remarks>
public sealed class AssistRetentionWorker : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromHours(1);

    private readonly IServiceScopeFactory _scopes;
    private readonly ILogger<AssistRetentionWorker> _logger;

    public AssistRetentionWorker(IServiceScopeFactory scopes, ILogger<AssistRetentionWorker> logger)
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
                using var scope = _scopes.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
                var settings = await db.Settings.AsNoTracking().FirstOrDefaultAsync(ct);
                if (settings is not null)
                {
                    await scope.ServiceProvider.GetRequiredService<AssistRetention>()
                        .SweepHouseholdAsync(settings, ct);
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // A failure here must not take the worker down; the next pass finds the same rows.
                _logger.LogError(ex, "Assist retention pass failed.");
            }

            try { await Task.Delay(Interval, ct); }
            catch (OperationCanceledException) { return; }
        }
    }
}
