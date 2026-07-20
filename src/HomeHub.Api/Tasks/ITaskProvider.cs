namespace HomeHub.Api.Tasks;

/// <summary>
/// The task seam: per-profile task lists with add / complete / delete. UI/logic depend on this,
/// not on Microsoft Graph. <see cref="SqlTaskProvider"/> is the local store (default, works
/// offline); <see cref="MicrosoftTodoProvider"/> round-trips to Microsoft To Do when configured.
/// A null profile id means "everyone" — the aggregate across linked/known profiles.
/// </summary>
public interface ITaskProvider
{
    string Source { get; }

    Task<IReadOnlyList<TaskItem>> ListAsync(int? profileId, CancellationToken ct);
    Task<TaskItem?> GetAsync(int id, CancellationToken ct);
    Task<TaskItem> CreateAsync(TaskCreateInput input, CancellationToken ct);

    /// <summary>Complete/uncomplete a task. When <paramref name="baseVersion"/> is given and doesn't
    /// match, throws <see cref="Data.ConcurrencyConflictException"/> (409).</summary>
    Task<TaskItem?> SetCompletedAsync(int id, bool completed, int? baseVersion, CancellationToken ct);

    /// <summary>Delete a task, with the same optional optimistic-concurrency check.</summary>
    Task<bool> DeleteAsync(int id, int? baseVersion, CancellationToken ct);
}
