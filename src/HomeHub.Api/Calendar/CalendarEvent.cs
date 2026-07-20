namespace HomeHub.Api.Calendar;

/// <summary>
/// A calendar event. This table is the local store for the simulated provider and the offline
/// cache for the Google provider. <see cref="GoogleId"/> links a row to its Google event when
/// synced. <see cref="OwnerTags"/> is optional local member-tagging (CSV of profile ids) that
/// drives the WHO chips — kept local, not pushed to Google.
/// </summary>
public class CalendarEvent
{
    public int Id { get; set; }

    /// <summary>Google Calendar event id when synced; null for local-only / simulated events.</summary>
    public string? GoogleId { get; set; }

    /// <summary>Providing source: "local" (simulated) or "google".</summary>
    public required string Source { get; set; }

    public required string Title { get; set; }

    public DateTime StartUtc { get; set; }
    public DateTime EndUtc { get; set; }

    public string? Location { get; set; }
    public string? Notes { get; set; }

    /// <summary>CSV of profile ids tagged on this event (local WHO mapping); empty when untagged.</summary>
    public string OwnerTags { get; set; } = "";

    public DateTime UpdatedUtc { get; set; }

    /// <summary>Optimistic-concurrency token: bumped on every update. Used by the offline write-queue
    /// to detect edit-vs-edit conflicts (Stage 9b).</summary>
    public int Version { get; set; } = 1;
}
