namespace HomeHub.Api.Tasks;

using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// Local, SQL-backed per-profile tasks. Used until Microsoft Graph is configured — the panel is
/// fully usable (add/complete/delete persist) without any linked account. When Graph is wired in,
/// <see cref="MicrosoftTodoProvider"/> takes over and this table becomes its offline cache.
/// </summary>
public sealed class SqlTaskProvider : ITaskProvider
{
    private readonly HomeHubDbContext _db;

    public SqlTaskProvider(HomeHubDbContext db) => _db = db;

    public string Source => "local";

    public async Task<IReadOnlyList<TaskItem>> ListAsync(int? profileId, CancellationToken ct)
    {
        var query = _db.Tasks.AsQueryable();
        if (profileId is { } pid) query = query.Where(t => t.ProfileId == pid);
        // Open tasks first (by due then creation), completed sink to the bottom.
        return await query
            .OrderBy(t => t.Completed)
            .ThenBy(t => t.DueUtc ?? DateTime.MaxValue)
            .ThenBy(t => t.CreatedUtc)
            .ToListAsync(ct);
    }

    public async Task<TaskItem?> GetAsync(int id, CancellationToken ct) =>
        await _db.Tasks.FindAsync([id], ct);

    public async Task<TaskItem> CreateAsync(TaskCreateInput input, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var task = new TaskItem
        {
            ProfileId = input.ProfileId,
            Source = Source,
            Title = input.Title.Trim(),
            Note = input.Note,
            DueUtc = input.DueUtc,
            Completed = false,
            CreatedUtc = now,
            UpdatedUtc = now,
        };
        _db.Tasks.Add(task);
        await _db.SaveChangesAsync(ct);
        return task;
    }

    public async Task<TaskItem?> SetCompletedAsync(int id, bool completed, int? baseVersion, CancellationToken ct)
    {
        var task = await _db.Tasks.FindAsync([id], ct);
        if (task is null) return null;
        if (baseVersion is { } v && v != task.Version) throw new ConcurrencyConflictException(TaskItemDto.From(task));
        task.Completed = completed;
        task.CompletedAtUtc = completed ? DateTime.UtcNow : null;
        task.UpdatedUtc = DateTime.UtcNow;
        task.Version++;
        await _db.SaveChangesAsync(ct);
        return task;
    }

    public async Task<bool> DeleteAsync(int id, int? baseVersion, CancellationToken ct)
    {
        var task = await _db.Tasks.FindAsync([id], ct);
        if (task is null) return false;
        if (baseVersion is { } v && v != task.Version) throw new ConcurrencyConflictException(TaskItemDto.From(task));
        _db.Tasks.Remove(task);
        await _db.SaveChangesAsync(ct);
        return true;
    }
}
