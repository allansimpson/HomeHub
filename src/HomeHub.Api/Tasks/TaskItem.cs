namespace HomeHub.Api.Tasks;

/// <summary>
/// A per-profile task. Local store for the simulated provider and offline cache for the
/// Microsoft To Do provider (<see cref="GraphId"/> links a row to its Graph task when synced).
/// Owned by exactly one profile — the active profile drives which account writes are made to.
/// </summary>
public class TaskItem
{
    public int Id { get; set; }

    /// <summary>Owning profile.</summary>
    public int ProfileId { get; set; }

    /// <summary>Microsoft Graph task id when synced; null for local-only tasks.</summary>
    public string? GraphId { get; set; }

    /// <summary>Providing source: "local" or "microsoft".</summary>
    public required string Source { get; set; }

    public required string Title { get; set; }

    public string? Note { get; set; }

    public DateTime? DueUtc { get; set; }

    public bool Completed { get; set; }
    public DateTime? CompletedAtUtc { get; set; }

    public DateTime CreatedUtc { get; set; }
    public DateTime UpdatedUtc { get; set; }
}
