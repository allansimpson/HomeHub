namespace HomeHub.Api.Tasks;

/// <summary>A task as sent to the client.</summary>
public record TaskItemDto(
    int Id,
    int ProfileId,
    string Title,
    string? Note,
    DateTime? DueUtc,
    bool Completed,
    string Source,
    int Version)
{
    public static TaskItemDto From(TaskItem t) =>
        new(t.Id, t.ProfileId, t.Title, t.Note, t.DueUtc, t.Completed, t.Source, t.Version);
}

/// <summary>Create payload — a new task belongs to a profile and starts not-completed.</summary>
public record TaskCreateInput(int ProfileId, string Title, string? Note, DateTime? DueUtc);

/// <summary>Toggle payload for completing / un-completing a task.</summary>
public record TaskCompleteInput(bool Completed);
