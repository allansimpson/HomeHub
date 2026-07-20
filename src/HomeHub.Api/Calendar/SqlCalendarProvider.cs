namespace HomeHub.Api.Calendar;

using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// Local, SQL-backed calendar. Used until Google OAuth is configured — the panel is fully
/// usable (create/edit/delete persist) without any external account. When Google is wired in,
/// <see cref="GoogleCalendarProvider"/> takes over and this table becomes its offline cache.
/// </summary>
public sealed class SqlCalendarProvider : ICalendarProvider
{
    private readonly HomeHubDbContext _db;

    public SqlCalendarProvider(HomeHubDbContext db) => _db = db;

    public string Source => "local";

    public async Task<IReadOnlyList<CalendarEvent>> ListAsync(DateTime fromUtc, DateTime toUtc, CancellationToken ct)
    {
        // Events that overlap the [from, to) window.
        return await _db.CalendarEvents
            .Where(e => e.StartUtc < toUtc && e.EndUtc > fromUtc)
            .OrderBy(e => e.StartUtc)
            .ToListAsync(ct);
    }

    public async Task<CalendarEvent?> GetAsync(int id, CancellationToken ct) =>
        await _db.CalendarEvents.FindAsync([id], ct);

    public async Task<CalendarEvent> CreateAsync(CalendarEventInput input, CancellationToken ct)
    {
        var e = new CalendarEvent
        {
            Source = Source,
            Title = input.Title.Trim(),
            StartUtc = input.StartUtc,
            EndUtc = input.EndUtc,
            Location = input.Location,
            Notes = input.Notes,
            OwnerTags = input.OwnersCsv,
            UpdatedUtc = DateTime.UtcNow,
        };
        _db.CalendarEvents.Add(e);
        await _db.SaveChangesAsync(ct);
        return e;
    }

    public async Task<CalendarEvent?> UpdateAsync(int id, CalendarEventInput input, CancellationToken ct)
    {
        var e = await _db.CalendarEvents.FindAsync([id], ct);
        if (e is null) return null;

        e.Title = input.Title.Trim();
        e.StartUtc = input.StartUtc;
        e.EndUtc = input.EndUtc;
        e.Location = input.Location;
        e.Notes = input.Notes;
        e.OwnerTags = input.OwnersCsv;
        e.UpdatedUtc = DateTime.UtcNow;
        await _db.SaveChangesAsync(ct);
        return e;
    }

    public async Task<bool> DeleteAsync(int id, CancellationToken ct)
    {
        var e = await _db.CalendarEvents.FindAsync([id], ct);
        if (e is null) return false;
        _db.CalendarEvents.Remove(e);
        await _db.SaveChangesAsync(ct);
        return true;
    }
}
