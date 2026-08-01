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

    /// <summary>Owning profile for Google events (per-profile calendars); null for local events.</summary>
    public int? ProfileId { get; set; }

    /// <summary>The Google calendar this event belongs to; null for local events.</summary>
    public string? GoogleCalendarId { get; set; }

    /// <summary>Display name of the owning calendar at sync time (for grouping / offline labelling).</summary>
    public string? CalendarName { get; set; }

    /// <summary>
    /// Google's own <c>eventType</c> as returned ("birthday", "outOfOffice", "fromGmail", …), or null
    /// for local events and for calendars synced before this was captured. Stored raw rather than
    /// pre-classified so a change to <see cref="EventKinds"/> re-reads history correctly instead of
    /// needing a resync.
    /// </summary>
    public string? GoogleEventType { get; set; }

    /// <summary>
    /// Google's <c>birthdayProperties.type</c> ("birthday", "anniversary", "custom", "other") — the
    /// only signal that distinguishes an anniversary from a birthday.
    /// </summary>
    public string? GoogleBirthdayType { get; set; }

    /// <summary>Providing source: "local" (simulated) or "google".</summary>
    public required string Source { get; set; }

    public required string Title { get; set; }

    public DateTime StartUtc { get; set; }
    public DateTime EndUtc { get; set; }

    public string? Location { get; set; }
    public string? Notes { get; set; }

    /// <summary>CSV of profile ids tagged on this event (local WHO mapping); empty when untagged.</summary>
    public string OwnerTags { get; set; } = "";

    /// <summary>
    /// A mark chosen by the household for this one event, overriding both its kind and its calendar's
    /// mark; null to inherit. Local like <see cref="OwnerTags"/> — Google has no field for it — and
    /// deliberately untouched by the sync upsert, so an event keeps its mark when it next syncs.
    /// </summary>
    public string? Mark { get; set; }

    public DateTime UpdatedUtc { get; set; }

    /// <summary>Optimistic-concurrency token: bumped on every update. Used by the offline write-queue
    /// to detect edit-vs-edit conflicts (Stage 9b).</summary>
    public int Version { get; set; } = 1;
}
