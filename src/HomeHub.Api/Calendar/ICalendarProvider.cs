namespace HomeHub.Api.Calendar;

/// <summary>
/// The calendar seam: list a date range and create/update/delete events. UI/logic depend on
/// this, not on Google. <see cref="SqlCalendarProvider"/> is the local store (default, works
/// offline); <see cref="GoogleCalendarProvider"/> round-trips to Google when configured.
/// </summary>
public interface ICalendarProvider
{
    string Source { get; }

    /// <summary>Events overlapping [from, to). <paramref name="profileId"/> scopes to one profile's
    /// calendars (Google); null lists everything (the local store ignores it).</summary>
    Task<IReadOnlyList<CalendarEvent>> ListAsync(int? profileId, DateTime fromUtc, DateTime toUtc, CancellationToken ct);
    Task<CalendarEvent?> GetAsync(int id, CancellationToken ct);
    Task<CalendarEvent> CreateAsync(CalendarEventInput input, CancellationToken ct);

    /// <summary>Update an event. When <paramref name="baseVersion"/> is given and doesn't match the
    /// stored version, throws <see cref="Data.ConcurrencyConflictException"/> (409).</summary>
    Task<CalendarEvent?> UpdateAsync(int id, CalendarEventInput input, int? baseVersion, CancellationToken ct);

    /// <summary>Delete an event, with the same optional optimistic-concurrency check as update.</summary>
    Task<bool> DeleteAsync(int id, int? baseVersion, CancellationToken ct);
}

/// <summary>
/// Optional capability for calendar providers whose events come from selectable calendars (Google).
/// The controller exposes the choose-calendars endpoints only when the active provider implements it.
/// Mirrors <see cref="Tasks.IListSyncProvider"/>.
/// </summary>
public interface ICalendarListSyncProvider
{
    /// <summary>The profile's available calendars with their current selected state.</summary>
    Task<IReadOnlyList<SyncCalendarDto>> GetCalendarsAsync(int profileId, CancellationToken ct);

    /// <summary>Replace the profile's synced-calendar selection (empty = sync none).</summary>
    Task SetSelectedCalendarsAsync(int profileId, IReadOnlyList<string> selectedCalendarIds, CancellationToken ct);

    /// <summary>
    /// Set (or clear, with a null icon) the icon shown for a calendar's events.
    /// </summary>
    /// <returns>
    /// <c>false</c> when the profile has explicitly deselected this calendar, so there is nothing to
    /// mark and nothing was stored. Reported rather than swallowed: a silent no-op here is
    /// indistinguishable from success at the panel, and the mark simply vanishes on the next read.
    /// </returns>
    Task<bool> SetCalendarIconAsync(int profileId, string calendarId, string? icon, CancellationToken ct);
}
