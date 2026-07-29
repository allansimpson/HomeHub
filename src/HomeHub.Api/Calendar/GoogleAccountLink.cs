namespace HomeHub.Api.Calendar;

/// <summary>
/// A profile's link to its own Google account for calendar sync. Each profile authorises once;
/// the refresh token yields access tokens silently. Mirrors <see cref="Tasks.MicrosoftAccountLink"/>.
/// </summary>
public class GoogleAccountLink
{
    /// <summary>Profile id (primary key — one Google link per profile).</summary>
    public int ProfileId { get; set; }

    public required string RefreshToken { get; set; }

    /// <summary>Calendar new events are created on; null = the account's "primary" calendar.</summary>
    public string? PrimaryCalendarId { get; set; }

    /// <summary>Once the profile has chosen which calendars to sync, only <see cref="SyncedCalendar"/>
    /// rows sync (may be none). While false — never configured — all calendars sync (default).</summary>
    public bool CalendarsConfigured { get; set; }
}
