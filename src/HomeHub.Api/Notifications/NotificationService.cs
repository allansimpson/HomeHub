namespace HomeHub.Api.Notifications;

using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// The one notification queue. Live cards, the pull-down drawer and the inbox all read from here —
/// if a notification can appear in one place and not another, this service is wrong.
/// </summary>
public sealed class NotificationService
{
    /// <summary>Nothing is kept past seven days.</summary>
    public static readonly TimeSpan Retention = TimeSpan.FromDays(7);

    private readonly HomeHubDbContext _db;
    private readonly TimeProvider _time;
    private readonly ILogger<NotificationService> _logger;

    public NotificationService(HomeHubDbContext db, TimeProvider time, ILogger<NotificationService> logger)
    {
        _db = db;
        _time = time;
        _logger = logger;
    }

    /// <summary>
    /// Record something that happened, unless it has been recorded already or its source is switched
    /// off. Returns the row, or null when it was suppressed.
    /// </summary>
    /// <remarks>
    /// <paramref name="dedupeKey"/> is doing real work: the alert feed is re-evaluated every thirty
    /// seconds and the app restarts, and neither may tell the household the same thing twice. The
    /// unique index behind it means a race between two callers loses cleanly rather than duplicating.
    ///
    /// <para>A source that is switched off is dropped <em>here</em>, on the way in, rather than
    /// filtered on the way out — a notification that existed in the store but was hidden from a view
    /// would be exactly the split-brain the one-queue rule exists to prevent.</para>
    /// </remarks>
    public async Task<Notification?> RecordAsync(
        string source,
        string label,
        string severity,
        string accent,
        string headline,
        string dedupeKey,
        DateTime atUtc,
        string? meta = null,
        string? route = null,
        CancellationToken ct = default)
    {
        if (!await IsEnabledAsync(source, ct)) return null;
        if (await _db.Notifications.AnyAsync(n => n.DedupeKey == dedupeKey, ct)) return null;

        var entry = new Notification
        {
            Source = source,
            Label = label,
            Severity = severity,
            Accent = accent,
            Headline = headline,
            Meta = meta,
            Route = route,
            DedupeKey = dedupeKey,
            AtUtc = atUtc,
        };

        _db.Notifications.Add(entry);
        try
        {
            await _db.SaveChangesAsync(ct);
            return entry;
        }
        catch (DbUpdateException ex)
        {
            // Lost a race on the unique index — the household has been told, which is the point.
            _db.Entry(entry).State = EntityState.Detached;
            _logger.LogDebug(ex, "Notification {Key} already recorded by another caller.", dedupeKey);
            return null;
        }
    }

    /// <summary>The last seven days, newest first.</summary>
    public async Task<IReadOnlyList<Notification>> ListAsync(CancellationToken ct = default)
    {
        var cutoff = _time.GetUtcNow().UtcDateTime - Retention;
        return await _db.Notifications
            .Where(n => n.AtUtc >= cutoff)
            .OrderByDescending(n => n.AtUtc)
            .ToListAsync(ct);
    }

    public async Task<int> UnreadCountAsync(CancellationToken ct = default)
    {
        var cutoff = _time.GetUtcNow().UtcDateTime - Retention;
        return await _db.Notifications.CountAsync(n => n.AtUtc >= cutoff && n.ReadAtUtc == null, ct);
    }

    /// <summary>Mark one as read. Reading is not clearing, and neither is an action on what it reported.</summary>
    public async Task<bool> MarkReadAsync(int id, CancellationToken ct = default)
    {
        var row = await _db.Notifications.FindAsync([id], ct);
        if (row is null) return false;
        row.ReadAtUtc ??= _time.GetUtcNow().UtcDateTime;
        await _db.SaveChangesAsync(ct);
        return true;
    }

    /// <summary>
    /// Empty the list.
    /// </summary>
    /// <remarks>
    /// Clearing is a reading gesture. It does not cancel a retry, and it certainly does not unlog a
    /// Baby entry — nothing in Baby can be unlogged at all. The rows go; what they reported does not.
    /// </remarks>
    public async Task<int> ClearAsync(string? severity = null, CancellationToken ct = default)
    {
        var query = _db.Notifications.AsQueryable();
        if (severity is not null) query = query.Where(n => n.Severity == severity);
        return await query.ExecuteDeleteAsync(ct);
    }

    /// <summary>Drop anything past retention. Cheap, and idempotent.</summary>
    public async Task<int> PruneAsync(CancellationToken ct = default)
    {
        var cutoff = _time.GetUtcNow().UtcDateTime - Retention;
        return await _db.Notifications.Where(n => n.AtUtc < cutoff).ExecuteDeleteAsync(ct);
    }

    // ---- Sources ----

    public async Task<IReadOnlyDictionary<string, bool>> GetSourcesAsync(CancellationToken ct = default)
    {
        var saved = await _db.NotificationSources.ToDictionaryAsync(s => s.Source, s => s.Enabled, ct);
        return NotificationSources.All.ToDictionary(
            s => s,
            s => saved.TryGetValue(s, out var on) ? on : NotificationSources.DefaultFor(s));
    }

    public async Task SetSourceAsync(string source, bool enabled, CancellationToken ct = default)
    {
        var row = await _db.NotificationSources.FirstOrDefaultAsync(s => s.Source == source, ct);
        if (row is null) _db.NotificationSources.Add(new NotificationSourceSetting { Source = source, Enabled = enabled });
        else row.Enabled = enabled;
        await _db.SaveChangesAsync(ct);
    }

    private async Task<bool> IsEnabledAsync(string source, CancellationToken ct)
    {
        var row = await _db.NotificationSources.FirstOrDefaultAsync(s => s.Source == source, ct);
        return row?.Enabled ?? NotificationSources.DefaultFor(source);
    }
}
