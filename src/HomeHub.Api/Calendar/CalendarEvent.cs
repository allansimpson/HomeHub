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

    /// <summary>
    /// Whether this event occupies whole days rather than an hour of one.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>A stored fact, not a shape read off the times.</b> The panel used to infer this — local
    /// midnight, spanning a day or more — because that is how Google's all-day events arrive and
    /// nothing else in the payload distinguished them. Inference is fine for reading and useless for
    /// writing: an event the household *declares* all-day has to reach Google as a bare
    /// <c>date</c>, and a heuristic cannot tell "all day" from "an event that happens to start at
    /// midnight".
    /// </para>
    /// <para>
    /// Set on sync from whether Google sent <c>date</c> or <c>dateTime</c>, so cached rows carry the
    /// truth rather than the guess. The client's own heuristic survives only as the fallback for
    /// rows synced before this column existed.
    /// </para>
    /// <para>
    /// <see cref="StartUtc"/> and <see cref="EndUtc"/> still bound the event when this is true —
    /// local midnight to local midnight, end exclusive, so every range query keeps working without
    /// knowing about the flag.
    /// </para>
    /// </remarks>
    public bool IsAllDay { get; set; }

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

    /// <summary>
    /// Whether this engagement was read off a photograph rather than typed.
    /// </summary>
    /// <remarks>
    /// Provenance, and deliberately independent of whether the photograph itself survived: the
    /// calendar row says FROM A PHOTO either way, because how an event got onto the calendar is a
    /// fact about the event and not about whether some bytes are still on disk. Local like
    /// <see cref="Mark"/> — Google has nowhere to put it — and left untouched by the sync upsert for
    /// the same reason.
    /// </remarks>
    public bool FromPhoto { get; set; }

    /// <summary>
    /// The kept photograph's filename, or null when none was kept.
    /// </summary>
    /// <remarks>
    /// A content hash, so several engagements read off one flyer share a file — which is why nothing
    /// may delete it without counting the others first. Null covers three ordinary cases, none of
    /// them an error: a format the panel cannot draw, retention switched off in Config, and a file
    /// since removed. <b>Local, and untouched by the sync upsert</b>, exactly like
    /// <see cref="Mark"/>; without that the flyer would detach itself the next time the calendar
    /// synced.
    /// </remarks>
    public string? PhotoFile { get; set; }

    /// <summary>
    /// When the photograph was taken, from its EXIF original date — or null when it carried none.
    /// </summary>
    /// <remarks>
    /// Null is common and is not a gap to be filled: a screenshot has no EXIF, and a screenshot of a
    /// message was one of the three things this feature was asked to read. The detail screen says
    /// TAKEN when this is set and ADDED when it is not, rather than passing off a file's timestamp
    /// as the moment somebody pointed a camera at something.
    /// </remarks>
    public DateTime? PhotoTakenUtc { get; set; }

    /// <summary>
    /// When this engagement was written down, or null for a row that predates the column.
    /// </summary>
    /// <remarks>
    /// Distinct from <see cref="UpdatedUtc"/>, which moves every time somebody edits the engagement.
    /// Read by the source block on a photographed engagement whose file carried no EXIF date — that
    /// case says ADDED rather than TAKEN, and needs a date that means what it says.
    /// </remarks>
    public DateTime? CreatedUtc { get; set; }

    public DateTime UpdatedUtc { get; set; }

    /// <summary>Optimistic-concurrency token: bumped on every update. Used by the offline write-queue
    /// to detect edit-vs-edit conflicts (Stage 9b).</summary>
    public int Version { get; set; } = 1;
}
