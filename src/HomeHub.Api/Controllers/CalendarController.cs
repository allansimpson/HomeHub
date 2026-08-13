namespace HomeHub.Api.Controllers;

using System.Globalization;
using HomeHub.Api.Calendar;
using HomeHub.Api.Calendar.Capture;
using HomeHub.Api.Data;
using HomeHub.Api.Auth;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

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
    private readonly IEventExtractor _extractor;
    private readonly EventPhotoStore _photos;
    private readonly HomeHubDbContext _db;

    public CalendarController(
        ICalendarProvider calendar,
        IEventExtractor extractor,
        EventPhotoStore photos,
        HomeHubDbContext db)
    {
        _calendar = calendar;
        _extractor = extractor;
        _photos = photos;
        _db = db;
    }

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
        ArgumentNullException.ThrowIfNull(input);
        if (string.IsNullOrWhiteSpace(input.Title)) return BadRequest("Title is required.");
        if (input.EndUtc <= input.StartUtc) return BadRequest("End must be after start.");

        // The photograph, if one came with the press. Resolved to a filename here — never taken from
        // the caller — and null whenever it was not kept, which is an ordinary outcome rather than a
        // failure: an unrenderable format, retention switched off, or a write that did not land.
        var stored = await KeepPhotoAsync(input, ct);
        var created = await _calendar.CreateAsync(input with { PhotoFile = stored, PhotoBase64 = null }, ct);
        return CreatedAtAction(nameof(Events), new { id = created.Id }, CalendarEventDto.From(created));
    }

    /// <summary>The stored filename for this write's photograph, or null if nothing was kept.</summary>
    private async Task<string?> KeepPhotoAsync(CalendarEventInput input, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(input.PhotoBase64)) return null;

        var settings = await _db.Settings.AsNoTracking().FirstOrDefaultAsync(s => s.Id == 1, ct);
        // Off is a household decision, and it applies from here forward only — photographs already
        // kept are not swept up by a switch somebody flicked afterwards.
        if (settings is { KeepEventPhotos: false }) return null;

        return await _photos.KeepAsync(input.PhotoBase64, ct);
    }

    /// <summary>
    /// The photograph an engagement was read from.
    /// </summary>
    /// <remarks>
    /// By event id rather than by filename: the stored name is a content hash and an implementation
    /// detail, and putting one in front of a browser would make every kept photograph reachable by
    /// anyone who could guess a hash. This way the ordinary authorisation on the controller is what
    /// governs the bytes.
    /// </remarks>
    [HttpGet("events/{id:int}/photo")]
    public async Task<IActionResult> Photo(int id, CancellationToken ct)
    {
        var e = await _calendar.GetAsync(id, ct);
        if (e?.PhotoFile is not { } fileName) return NotFound();

        var path = _photos.Resolve(fileName);
        var contentType = EventPhotoStore.ContentTypeFor(fileName);
        // A row pointing at a file that is gone is not an error worth a 500 — the detail screen has
        // a state for exactly this, and it reads "not kept".
        if (path is null || contentType is null) return NotFound();

        return PhysicalFile(path, contentType);
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

    /// <summary>
    /// Read a photograph for engagements. Returns drafts; writes nothing.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Nothing here persists, and that is the point.</b> The write is a separate, ordinary create
    /// that a person makes after confirming what was read — so an engagement can only reach the
    /// calendar through a decision, never through a reading. The photograph is not stored either;
    /// keeping it is the create's business, and only when the household has said yes.
    /// </para>
    /// <para>
    /// The reading itself carries no tools and answers a fixed schema
    /// (<see cref="IEventExtractor"/>), because everything printed on a flyer is untrusted input.
    /// </para>
    /// </remarks>
    [HttpPost("read-photo")]
    public async Task<ActionResult<ReadPhotoResponse>> ReadPhoto(ReadPhotoRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (string.IsNullOrEmpty(request.ImageBase64)) return BadRequest("A photograph is required.");

        // Measured on the decoded length, so the number means what it says on a file listing.
        if ((long)request.ImageBase64.Length * 3L / 4L > EventCaptureLimits.MaxImageBytes)
            return BadRequest("That picture is too large to read.");

        if (!_extractor.IsAvailable)
        {
            // Not a failure of the photograph, and not phrased as one. The panel keeps quiet.
            return Ok(new ReadPhotoResponse(
                nameof(ExtractionConfidence.Empty), [], "Reading photographs isn't switched on for this panel.", false));
        }

        var context = request.Context;
        if (context is { Length: > EventCaptureLimits.MaxContextChars })
            context = context[..EventCaptureLimits.MaxContextChars];

        var result = await _extractor.ReadAsync(
            new ExtractionRequest(
                request.ImageBase64,
                string.IsNullOrWhiteSpace(request.MediaType) ? "image/jpeg" : request.MediaType,
                ParseLocalDate(request.LocalDate),
                context),
            ct);

        return Ok(ReadPhotoResponse.From(result, available: true));
    }

    /// <summary>
    /// Delete a kept photograph, but only once nothing still points at it.
    /// </summary>
    /// <remarks>
    /// <b>The sibling case is the whole reason this exists.</b> A reading can turn one flyer into
    /// four engagements, and because the filename is a hash of the bytes those four share a single
    /// file. Deleting one of them — or undoing a batch part-way — must not take the photograph away
    /// from the others, so the file goes only when the last reference does.
    /// </remarks>
    private async Task ForgetPhotoIfUnusedAsync(string photoFile, CancellationToken ct)
    {
        var stillUsed = await _db.CalendarEvents.AnyAsync(e => e.PhotoFile == photoFile, ct);
        if (!stillUsed) _photos.Forget(photoFile);
    }

    /// <summary>The panel's own date, or the server's when it did not send a usable one.</summary>
    private static DateOnly ParseLocalDate(string? value) =>
        DateOnly.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed)
            ? parsed
            : DateOnly.FromDateTime(DateTime.Now);

    [HttpDelete("events/{id:int}")]
    public async Task<IActionResult> Delete(int id, [FromQuery] int? baseVersion, CancellationToken ct)
    {
        try
        {
            // Read the filename before the row goes, so the sibling count below has something to
            // count. One flyer can back four engagements and they share a file.
            var photoFile = (await _calendar.GetAsync(id, ct))?.PhotoFile;

            var ok = await _calendar.DeleteAsync(id, baseVersion, ct);
            if (ok && photoFile is not null) await ForgetPhotoIfUnusedAsync(photoFile, ct);
            return ok ? NoContent() : NotFound();
        }
        catch (ConcurrencyConflictException ex)
        {
            return Conflict(ex.Current);
        }
    }
}
