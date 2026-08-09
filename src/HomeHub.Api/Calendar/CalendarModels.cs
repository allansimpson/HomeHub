namespace HomeHub.Api.Calendar;

/// <summary>Calendar event as sent to the client. Times are UTC; the client renders local.</summary>
public record CalendarEventDto(
    int Id,
    string Title,
    DateTime StartUtc,
    DateTime EndUtc,
    string? Location,
    string? Notes,
    IReadOnlyList<int> OwnerIds,
    string Source,
    int Version,
    int? ProfileId,
    string? CalendarName,
    /// <summary>What this event is — see <see cref="EventKinds"/>. Always set; "default" when unknown.</summary>
    string Kind,
    /// <summary>
    /// Google's own word for the event, or null. Present so the panel can tell a *stated* kind from an
    /// *inferred* one: kind "birthday" with a null eventType was read off the title.
    /// </summary>
    string? GoogleEventType,
    /// <summary>
    /// The owning Google calendar's id, or null for local events. The join key for the second icon
    /// axis: <see cref="SyncCalendarDto.Icon"/> is stored per calendar id, and the panel resolves an
    /// event's mark from it when the event's own <see cref="Kind"/> says nothing. The display name is
    /// not a key — two accounts can both call a calendar "Work".
    /// </summary>
    string? GoogleCalendarId,
    /// <summary>
    /// A mark the household chose for this one event, or null to inherit. The third and most specific
    /// axis: it is an explicit statement about this event, so it outranks both the provider's kind and
    /// the calendar's mark.
    /// </summary>
    string? Mark)
{
    public static CalendarEventDto From(CalendarEvent e) => new(
        e.Id, e.Title, e.StartUtc, e.EndUtc, e.Location, e.Notes, ParseOwners(e.OwnerTags), e.Source, e.Version, e.ProfileId, e.CalendarName,
        EventKinds.Refine(EventKinds.Classify(e.GoogleEventType, e.GoogleCalendarId, e.Title), e.GoogleBirthdayType),
        e.GoogleEventType, e.GoogleCalendarId, e.Mark);

    public static IReadOnlyList<int> ParseOwners(string csv) =>
        string.IsNullOrWhiteSpace(csv)
            ? []
            : csv.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                 .Select(s => int.TryParse(s, out var v) ? v : (int?)null)
                 .Where(v => v is not null)
                 .Select(v => v!.Value)
                 .ToList();
}

/// <summary>Create/update payload for an event.</summary>
public record CalendarEventInput(
    string Title,
    DateTime StartUtc,
    DateTime EndUtc,
    string? Location,
    string? Notes,
    IReadOnlyList<int>? OwnerIds,
    /// <summary>Owning profile (whose Google account it's created on). Null for the local calendar.</summary>
    int? ProfileId = null,
    /// <summary>Target Google calendar for a new event; null = the profile's primary calendar.</summary>
    string? GoogleCalendarId = null,
    /// <summary>
    /// Mark for this one event, overriding its kind and its calendar's mark; null to inherit. Stored
    /// locally — Google has nowhere to put it.
    /// </summary>
    string? Mark = null)
{
    public string OwnersCsv => OwnerIds is null ? "" : string.Join(',', OwnerIds.Distinct());

    /// <summary>The mark trimmed, with blank treated as "inherit" rather than as an empty mark.</summary>
    public string? NormalizedMark => string.IsNullOrWhiteSpace(Mark) ? null : Mark.Trim();
}

/// <summary>A Google calendar offered for display, with its current selected state and icon.</summary>
/// <param name="Icon">
/// Icon id the household assigned to this calendar, or null for none. The second of the two icon
/// axes: this one says "everything on Work looks like this", while an event's own
/// <see cref="CalendarEventDto.Kind"/> says what that single event is.
/// </param>
/// <param name="CanWrite">
/// Whether this account may add events here. Google publishes read-only calendars (holidays, anyone
/// else's shared calendar) that accept a create only to reject it, so the editor offers as a target
/// only the calendars that can actually take one.
/// </param>
/// <param name="IsPrimary">
/// The account's own default calendar — where an event goes when no other is chosen. Sent so the
/// editor can show that choice rather than leaving the default unstated.
/// </param>
public record SyncCalendarDto(string CalendarId, string Name, bool Selected, string? Icon, bool CanWrite, bool IsPrimary);

/// <summary>Assign (or clear, with a null icon) the icon shown for a calendar's events.</summary>
public record SetCalendarIconInput(int ProfileId, string CalendarId, string? Icon);

/// <summary>Replace a profile's synced-calendar selection with the given calendar ids.</summary>
public record SetSyncedCalendarsInput(int ProfileId, IReadOnlyList<string> SelectedCalendarIds);
