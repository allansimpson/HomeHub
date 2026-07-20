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

    /// <summary>Update an event. When <paramref name="baseVersion"/> is given and doesn't match the
    /// stored version, throws <see cref="Data.ConcurrencyConflictException"/> (409).</summary>
    Task<CalendarEvent?> UpdateAsync(int id, CalendarEventInput input, int? baseVersion, CancellationToken ct);

    /// <summary>Delete an event, with the same optional optimistic-concurrency check as update.</summary>
    Task<bool> DeleteAsync(int id, int? baseVersion, CancellationToken ct);
}
