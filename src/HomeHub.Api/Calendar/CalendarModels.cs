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
    string? CalendarName)
{
    public static CalendarEventDto From(CalendarEvent e) => new(
        e.Id, e.Title, e.StartUtc, e.EndUtc, e.Location, e.Notes, ParseOwners(e.OwnerTags), e.Source, e.Version, e.ProfileId, e.CalendarName);

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
    string? GoogleCalendarId = null)
{
    public string OwnersCsv => OwnerIds is null ? "" : string.Join(',', OwnerIds.Distinct());
}

/// <summary>A Google calendar offered for display, with its current selected state.</summary>
public record SyncCalendarDto(string CalendarId, string Name, bool Selected);

/// <summary>Replace a profile's synced-calendar selection with the given calendar ids.</summary>
public record SetSyncedCalendarsInput(int ProfileId, IReadOnlyList<string> SelectedCalendarIds);
