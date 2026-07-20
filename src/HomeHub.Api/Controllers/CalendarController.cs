namespace HomeHub.Api.Controllers;

using HomeHub.Api.Calendar;
using HomeHub.Api.Data;
using Microsoft.AspNetCore.Mvc;

/// <summary>
/// Household calendar CRUD via the calendar seam. Reads a date range (month view / agenda) and
/// upcoming events (dashboard NEXT); writes create/update/delete. With Google configured these
/// round-trip to the shared calendar; otherwise they persist locally.
/// </summary>
[ApiController]
[Route("api/[controller]")]
public class CalendarController : ControllerBase
{
    private readonly ICalendarProvider _calendar;

    public CalendarController(ICalendarProvider calendar) => _calendar = calendar;

    /// <summary>Events overlapping [from, to). Defaults to the current month if unspecified.</summary>
    [HttpGet("events")]
    public async Task<IReadOnlyList<CalendarEventDto>> Events(
        [FromQuery] DateTime? from, [FromQuery] DateTime? to, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var fromUtc = from?.ToUniversalTime() ?? new DateTime(now.Year, now.Month, 1, 0, 0, 0, DateTimeKind.Utc);
        var toUtc = to?.ToUniversalTime() ?? fromUtc.AddMonths(1);
        var events = await _calendar.ListAsync(fromUtc, toUtc, ct);
        return events.Select(CalendarEventDto.From).ToList();
    }

    /// <summary>Upcoming events over the next <paramref name="days"/> days (dashboard NEXT).</summary>
    [HttpGet("upcoming")]
    public async Task<IReadOnlyList<CalendarEventDto>> Upcoming([FromQuery] int days = 7, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        var events = await _calendar.ListAsync(now, now.AddDays(Math.Clamp(days, 1, 31)), ct);
        // Overlap query can include an in-progress event that started earlier; keep those too,
        // but order by start so the soonest surfaces first.
        return events.Select(CalendarEventDto.From).OrderBy(e => e.StartUtc).ToList();
    }

    /// <summary>A single event by id (for the editor).</summary>
    [HttpGet("events/{id:int}")]
    public async Task<ActionResult<CalendarEventDto>> Get(int id, CancellationToken ct)
    {
        var e = await _calendar.GetAsync(id, ct);
        return e is null ? NotFound() : CalendarEventDto.From(e);
    }

    [HttpPost("events")]
    public async Task<ActionResult<CalendarEventDto>> Create(CalendarEventInput input, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(input.Title)) return BadRequest("Title is required.");
        if (input.EndUtc <= input.StartUtc) return BadRequest("End must be after start.");
        var created = await _calendar.CreateAsync(input, ct);
        return CreatedAtAction(nameof(Events), new { id = created.Id }, CalendarEventDto.From(created));
    }

    [HttpPut("events/{id:int}")]
    public async Task<ActionResult<CalendarEventDto>> Update(int id, CalendarEventInput input, [FromQuery] int? baseVersion, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(input.Title)) return BadRequest("Title is required.");
        if (input.EndUtc <= input.StartUtc) return BadRequest("End must be after start.");
        try
        {
            var updated = await _calendar.UpdateAsync(id, input, baseVersion, ct);
            return updated is null ? NotFound() : CalendarEventDto.From(updated);
        }
        catch (ConcurrencyConflictException ex)
        {
            return Conflict(ex.Current);
        }
    }

    [HttpDelete("events/{id:int}")]
    public async Task<IActionResult> Delete(int id, [FromQuery] int? baseVersion, CancellationToken ct)
    {
        try
        {
            var ok = await _calendar.DeleteAsync(id, baseVersion, ct);
            return ok ? NoContent() : NotFound();
        }
        catch (ConcurrencyConflictException ex)
        {
            return Conflict(ex.Current);
        }
    }
}
