namespace HomeHub.Api.Tasks;

/// <summary>A task as sent to the client. <see cref="ListName"/> drives the TODO screen's grouping.</summary>
public record TaskItemDto(
    int Id,
    int ProfileId,
    string Title,
    string? Note,
    DateTime? DueUtc,
    bool Completed,
    string Source,
    int Version,
    string? ListName,
    string? GraphListId,
    bool Important)
{
    public static TaskItemDto From(TaskItem t) =>
        new(t.Id, t.ProfileId, t.Title, t.Note, t.DueUtc, t.Completed, t.Source, t.Version, t.ListName, t.GraphListId, t.Important);
}

/// <summary>Create payload — a new task belongs to a profile and a target list (by Graph id / name).</summary>
public record TaskCreateInput(int ProfileId, string Title, string? Note, DateTime? DueUtc, string? GraphListId = null, string? ListName = null);

/// <summary>Toggle payload for completing / un-completing a task.</summary>
public record TaskCompleteInput(bool Completed);

/// <summary>A Microsoft To Do list offered for syncing, with its current selected state.</summary>
public record SyncListDto(string GraphListId, string Name, bool Selected);

/// <summary>Replace a profile's synced-list selection with the given Graph list ids.</summary>
public record SetSyncedListsInput(int ProfileId, IReadOnlyList<string> SelectedGraphListIds);
