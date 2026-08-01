namespace HomeHub.Api.Calendar;

/// <summary>
/// A Google calendar a profile has chosen to display on the panel. When a profile has any rows,
/// only those calendars sync; with no rows the default is to sync all of the account's calendars.
/// Mirrors <see cref="Tasks.SyncedList"/>.
/// </summary>
public class SyncedCalendar
{
    public int ProfileId { get; set; }

    /// <summary>Google calendar id (an email for the primary, or a "…@group.calendar.google.com").</summary>
    public required string GoogleCalendarId { get; set; }

    /// <summary>Display name at the time it was selected (for offline labelling).</summary>
    public required string CalendarName { get; set; }

    /// <summary>
    /// Icon id shown for this calendar's events, or null for none. Household-assigned and free-form —
    /// the API stores whatever the panel's icon set offers rather than an enum, so adding an icon to
    /// the sprite needs no migration here.
    /// </summary>
    public string? Icon { get; set; }
}
