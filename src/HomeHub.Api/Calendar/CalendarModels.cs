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
    int Version)
{
    public static CalendarEventDto From(CalendarEvent e) => new(
        e.Id, e.Title, e.StartUtc, e.EndUtc, e.Location, e.Notes, ParseOwners(e.OwnerTags), e.Source, e.Version);

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
    IReadOnlyList<int>? OwnerIds)
{
    public string OwnersCsv => OwnerIds is null ? "" : string.Join(',', OwnerIds.Distinct());
}
