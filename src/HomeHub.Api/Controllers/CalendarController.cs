namespace HomeHub.Api.Controllers;

using HomeHub.Api.Calendar;
using HomeHub.Api.Data;
using HomeHub.Api.Auth;
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

    /// <summary>Events overlapping [from, to) for the caller's calendars. Defaults to the current month.</summary>
    /// <remarks>
    /// The profile is the caller (AUDIT A1.2). It was a query parameter, which meant reading any
    /// member's calendar was a matter of changing a number.
    /// </remarks>
    [HttpGet("events")]
    public async Task<IReadOnlyList<CalendarEventDto>> Events(
        [FromQuery] DateTime? from, [FromQuery] DateTime? to, CancellationToken ct)
    {
        var profileId = this.CallerId();
        var now = DateTime.UtcNow;
        var fromUtc = from?.ToUniversalTime() ?? new DateTime(now.Year, now.Month, 1, 0, 0, 0, DateTimeKind.Utc);
        var toUtc = to?.ToUniversalTime() ?? fromUtc.AddMonths(1);
        var events = await _calendar.ListAsync(profileId, fromUtc, toUtc, ct);
        return events.Select(CalendarEventDto.From).ToList();
    }

    /// <summary>Upcoming events over the next <paramref name="days"/> days for the caller (dashboard NEXT).</summary>
    [HttpGet("upcoming")]
    public async Task<IReadOnlyList<CalendarEventDto>> Upcoming([FromQuery] int days = 7, CancellationToken ct = default)
    {
        var profileId = this.CallerId();
        var now = DateTime.UtcNow;
        var events = await _calendar.ListAsync(profileId, now, now.AddDays(Math.Clamp(days, 1, 31)), ct);
        // Overlap query can include an in-progress event that started earlier; keep those too,
        // but order by start so the soonest surfaces first.
        return events.Select(CalendarEventDto.From).OrderBy(e => e.StartUtc).ToList();
    }

    /// <summary>The profile's Google calendars with their display selection (501 unless Google is configured).</summary>
    [HttpGet("calendars")]
    public async Task<ActionResult<IReadOnlyList<SyncCalendarDto>>> Calendars([FromQuery] int profileId, CancellationToken ct)
    {
        // Self-or-admin: this configures a named member's account from a settings screen.
        if (!this.MayActFor(profileId)) return Forbid();
        if (_calendar is not ICalendarListSyncProvider lister)
            return StatusCode(501, "Calendar selection needs Google configured.");

        try
        {
            return Ok(await lister.GetCalendarsAsync(profileId, ct));
        }
        catch (GoogleAuthException ex)
        {
            // 409, not 500 and not an empty list. The account is linked and Google is refusing the
            // token, which is neither a fault in this app nor "no calendars on this account" — it is
            // a person needing to sign in again, and the screen says exactly that.
            return Conflict(new { needsReauth = true, detail = ex.Message });
        }
    }

    /// <summary>Replace which calendars a profile displays (empty = show none).</summary>
    [HttpPut("calendars")]
    public async Task<IActionResult> SetCalendars(SetSyncedCalendarsInput input, CancellationToken ct)
    {
        // Self-or-admin: configures a named member's account. The id stays in the body because the
        // settings screen may be administering someone else; what changed is that it no longer
        // decides *whether* the caller may.
        if (!this.MayActFor(input.ProfileId)) return Forbid();
        if (_calendar is not ICalendarListSyncProvider lister)
            return StatusCode(501, "Calendar selection needs Google configured.");
        await lister.SetSelectedCalendarsAsync(input.ProfileId, input.SelectedCalendarIds ?? [], ct);
        return NoContent();
    }

    /// <summary>Set (or clear) the icon shown for one calendar's events.</summary>
    [HttpPut("calendars/icon")]
    public async Task<IActionResult> SetCalendarIcon(SetCalendarIconInput input, CancellationToken ct)
    {
        if (!this.MayActFor(input.ProfileId)) return Forbid();
        if (_calendar is not ICalendarListSyncProvider lister)
            return StatusCode(501, "Calendar icons need Google configured.");
        if (string.IsNullOrWhiteSpace(input.CalendarId)) return BadRequest("A calendar is required.");
        var stored = await lister.SetCalendarIconAsync(input.ProfileId, input.CalendarId, input.Icon, ct);
        // Answering 204 when nothing was written is what made this look like it saved: the panel had
        // already drawn the mark, and only a later reload revealed it had gone nowhere.
        if (!stored) return Conflict("That calendar is hidden. Show it before giving it a mark.");
        return NoContent();
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
