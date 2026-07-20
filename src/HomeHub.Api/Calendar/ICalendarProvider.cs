namespace HomeHub.Api.Calendar;

/// <summary>
/// The calendar seam: list a date range and create/update/delete events. UI/logic depend on
/// this, not on Google. <see cref="SqlCalendarProvider"/> is the local store (default, works
/// offline); <see cref="GoogleCalendarProvider"/> round-trips to Google when configured.
/// </summary>
public interface ICalendarProvider
{
    string Source { get; }

    Task<IReadOnlyList<CalendarEvent>> ListAsync(DateTime fromUtc, DateTime toUtc, CancellationToken ct);
    Task<CalendarEvent?> GetAsync(int id, CancellationToken ct);
    Task<CalendarEvent> CreateAsync(CalendarEventInput input, CancellationToken ct);
    Task<CalendarEvent?> UpdateAsync(int id, CalendarEventInput input, CancellationToken ct);
    Task<bool> DeleteAsync(int id, CancellationToken ct);
}
