namespace HomeHub.Api.Tasks;

/// <summary>
/// A Microsoft To Do list a profile has chosen to sync onto the panel. When a profile has any rows,
/// only those lists sync (and appear as TODO tabs); with no rows the default is to sync all lists.
/// </summary>
public class SyncedList
{
    public int ProfileId { get; set; }

    /// <summary>Microsoft Graph list id.</summary>
    public required string GraphListId { get; set; }

    /// <summary>Display name at the time it was selected (for offline labelling).</summary>
    public required string ListName { get; set; }
}
