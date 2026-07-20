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
    Task<TaskItem?> SetCompletedAsync(int id, bool completed, CancellationToken ct);
    Task<bool> DeleteAsync(int id, CancellationToken ct);
}
