namespace HomeHub.Api.Controllers;

using HomeHub.Api.Care;
using HomeHub.Api.Data;
using Microsoft.AspNetCore.Mvc;

/// <summary>
/// Care logging HomeHub owns — ten types, a real time, and entries that can be corrected.
/// </summary>
/// <remarks>
/// <para>
/// Distinct from <c>BabyController</c>, which fronts the Huckleberry integration and always will:
/// that surface reads live sensors and drives the timers the household's own app can see. This one
/// is HomeHub's own log, and it is the only thing the panel writes to now.
/// </para>
/// <para>
/// Six of its ten types exist nowhere else — the integration has no service to write them and no
/// sensor to read them — which is the reason it was built.
/// </para>
/// </remarks>
[ApiController]
[Route("api/care")]
public class CareController : ControllerBase
{
    private readonly CareLogService _log;
    private readonly CareImportService _import;

    public CareController(CareLogService log, CareImportService import)
    {
        _log = log;
        _import = import;
    }

    /// <summary>Everything in a window, newest first. Defaults to today.</summary>
    [HttpGet("{childKey}/entries")]
    public async Task<IReadOnlyList<CareEntryDto>> Entries(
        string childKey,
        [FromQuery] DateTime? from,
        [FromQuery] DateTime? to,
        CancellationToken ct)
    {
        var end = to ?? DateTime.UtcNow.AddDays(1).Date;
        var start = from ?? end.AddDays(-1);
        var rows = await _log.ListAsync(childKey, start, end, ct);
        return [.. rows.Select(CareEntryDto.From)];
    }

    /// <summary>
    /// The newest of each type, plus any running timers — one read for the whole landing screen.
    /// </summary>
    /// <remarks>
    /// The tile captions and every sheet's pre-fill come from here, so it is one request rather than
    /// ten: the design's grid shows each type's opening value before the tap, and ten round trips to
    /// draw one screen is how a wall panel feels slow.
    /// </remarks>
    [HttpGet("{childKey}/summary")]
    public async Task<CareSummaryDto> Summary(string childKey, CancellationToken ct)
    {
        var last = await _log.LastByTypeAsync(childKey, ct);
        var timers = await _log.RunningAsync(childKey, ct);
        return new CareSummaryDto(
            [.. last.Values.Select(CareEntryDto.From)],
            [.. timers.Select(t => CareTimerDto.From(t, _log.ElapsedMinutes(t)))]);
    }

    [HttpPost("{childKey}/entries")]
    public async Task<ActionResult<CareEntryDto>> Add(string childKey, CareEntryInput input, CancellationToken ct)
    {
        var entry = await _log.AddAsync(childKey, input, ct);
        return Ok(CareEntryDto.From(entry));
    }

    /// <summary>Correct an entry — the thing Huckleberry cannot do from here at all.</summary>
    /// <remarks>
    /// <paramref name="baseVersion"/> makes the correction conditional on the row it was typed
    /// against, which is what a queued edit needs: it may have been sitting on a phone with no
    /// signal while the same entry was corrected on the panel. A mismatch is a 409 carrying the
    /// current row, and the household picks — never a silent overwrite.
    /// </remarks>
    [HttpPut("entries/{id:int}")]
    public async Task<ActionResult<CareEntryDto>> Update(
        int id, CareEntryInput input, [FromQuery] int? baseVersion, CancellationToken ct)
    {
        try
        {
            var entry = await _log.UpdateAsync(id, input, baseVersion, ct);
            return entry is null ? NotFound() : Ok(CareEntryDto.From(entry));
        }
        catch (ConcurrencyConflictException ex) when (ex.Current is CareEntry current)
        {
            return Conflict(CareEntryDto.From(current));
        }
    }

    [HttpDelete("entries/{id:int}")]
    public async Task<IActionResult> Delete(int id, [FromQuery] int? baseVersion, CancellationToken ct)
    {
        try
        {
            return await _log.DeleteAsync(id, baseVersion, ct) ? NoContent() : NotFound();
        }
        catch (ConcurrencyConflictException ex) when (ex.Current is CareEntry current)
        {
            return Conflict(CareEntryDto.From(current));
        }
    }

    // ---- timers ----

    [HttpPost("{childKey}/timer/{type}/start")]
    public async Task<ActionResult<CareTimerDto>> Start(
        string childKey, CareEntryType type,
        [FromQuery] string? side, [FromQuery] int? phaseOne, [FromQuery] int? phaseTwo,
        CancellationToken ct)
    {
        var timer = await _log.StartTimerAsync(childKey, type, side, phaseOne, phaseTwo, ct);
        return Ok(CareTimerDto.From(timer, _log.ElapsedMinutes(timer)));
    }

    [HttpPost("{childKey}/timer/{type}/pause")]
    public async Task<ActionResult<CareTimerDto>> Pause(string childKey, CareEntryType type, CancellationToken ct) =>
        await _log.PauseTimerAsync(childKey, type, ct) is { } t
            ? Ok(CareTimerDto.From(t, _log.ElapsedMinutes(t))) : NotFound();

    [HttpPost("{childKey}/timer/{type}/resume")]
    public async Task<ActionResult<CareTimerDto>> Resume(string childKey, CareEntryType type, CancellationToken ct) =>
        await _log.ResumeTimerAsync(childKey, type, ct) is { } t
            ? Ok(CareTimerDto.From(t, _log.ElapsedMinutes(t))) : NotFound();

    [HttpPost("{childKey}/timer/{type}/side/{side}")]
    public async Task<ActionResult<CareTimerDto>> Side(
        string childKey, CareEntryType type, string side, CancellationToken ct) =>
        await _log.SwitchSideAsync(childKey, type, side, ct) is { } t
            ? Ok(CareTimerDto.From(t, _log.ElapsedMinutes(t))) : NotFound();

    /// <summary>Advance a pump session to expression, early or on time.</summary>
    [HttpPost("{childKey}/timer/pump/phase")]
    public async Task<ActionResult<CareTimerDto>> Phase(string childKey, CancellationToken ct) =>
        await _log.SwitchPhaseAsync(childKey, ct) is { } t
            ? Ok(CareTimerDto.From(t, _log.ElapsedMinutes(t))) : NotFound();

    /// <summary>
    /// Stop the clock and hold the session for its amount. Writes nothing.
    /// </summary>
    /// <remarks>
    /// Pump only, and deliberately neither of the other two stops: COMPLETE writes, CANCEL discards,
    /// and this measures. The amount is knowable only once the session is over, so the panel asks
    /// for it against a held session and completes with it in hand.
    /// </remarks>
    [HttpPost("{childKey}/timer/{type}/finish")]
    public async Task<ActionResult<CareTimerDto>> Finish(string childKey, CareEntryType type, CancellationToken ct) =>
        await _log.FinishTimerAsync(childKey, type, ct) is { } t
            ? Ok(CareTimerDto.From(t, _log.ElapsedMinutes(t))) : NotFound();

    /// <summary>Throw the session away. Writes nothing — deliberately not the same act as complete.</summary>
    [HttpPost("{childKey}/timer/{type}/cancel")]
    public async Task<IActionResult> Cancel(string childKey, CareEntryType type, CancellationToken ct) =>
        await _log.CancelTimerAsync(childKey, type, ct) ? NoContent() : NotFound();

    /// <summary>End the session and write it, back-dated to when it started.</summary>
    [HttpPost("{childKey}/timer/{type}/complete")]
    public async Task<ActionResult<CareEntryDto>> Complete(
        string childKey, CareEntryType type,
        [FromQuery] double? amount, [FromQuery] string? unit, [FromQuery] DateTime? atUtc,
        CancellationToken ct) =>
        await _log.CompleteTimerAsync(childKey, type, amount, unit, atUtc, ct) is { } entry
            ? Ok(CareEntryDto.From(entry)) : NotFound();

    // ---- import ----

    /// <summary>
    /// Pull the household's own history out of Huckleberry, on demand.
    /// </summary>
    /// <remarks>
    /// Safe to run as often as wanted: each upstream event is keyed and written once, so a second
    /// pull over the same window reports it as already had rather than duplicating it. Defaults to
    /// ninety days, which is Home Assistant's own recorder retention — asking for more returns
    /// nothing older, because there is nothing older to return.
    /// </remarks>
    [HttpPost("{childKey}/import")]
    public async Task<ActionResult<CareImportResult>> Import(
        string childKey, [FromQuery] int days, CancellationToken ct)
    {
        var window = days <= 0 ? 90 : Math.Min(days, 400);
        var to = DateTimeOffset.UtcNow;
        return Ok(await _import.ImportAsync(childKey, to.AddDays(-window), to, ct));
    }
}

/// <summary>One logged moment, as the panel reads it.</summary>
public sealed record CareEntryDto(
    int Id,
    string ChildKey,
    string Type,
    DateTime AtUtc,
    double? Amount,
    string? Unit,
    double? DurationMinutes,
    string? Kind,
    string? Side,
    string? PeeAmount,
    string? PooAmount,
    string? Color,
    string? Consistency,
    bool? DiaperRash,
    double? Pounds,
    double? Ounces,
    double? HeightInches,
    double? HeadInches,
    string? Notes,
    /// <summary>Typed on the panel, or pulled in from Huckleberry — the log shows which.</summary>
    string Source,
    bool Edited,
    /// <summary>
    /// What the panel called this entry when it wrote it, or null if it did not say.
    /// </summary>
    /// <remarks>
    /// <b>How a queued entry finds itself again after a reconnect.</b> An entry logged offline is
    /// shown from the panel's own store under an id the server has never seen; when the queue
    /// replays and the read comes back, this is what says "the row you are holding is that one" —
    /// without it the entry appears twice, once as the local copy and once as the server's, and the
    /// household counts two feeds where there was one.
    /// </remarks>
    string? ClientKey,
    /// <summary>
    /// Bumped on every correction, so an edit made offline can be conditional on what it edited.
    /// </summary>
    /// <remarks>
    /// The write queue sends it back as <c>?baseVersion=</c>. A correction that was queued for
    /// hours is exactly the one that may be editing a row somebody has since changed on the panel,
    /// and the household is told rather than one silently overwriting the other.
    /// </remarks>
    int Version)
{
    /// <summary>The <c>panel:</c> prefix is a storage detail; the client only ever sees its own key.</summary>
    private const string PanelKeyPrefix = "panel:";

    public static CareEntryDto From(CareEntry e)
    {
        ArgumentNullException.ThrowIfNull(e);
        return new(
            e.Id, e.ChildKey, e.Type.ToString(), e.AtUtc, e.Amount, e.Unit, e.DurationMinutes,
            e.Kind, e.Side, e.PeeAmount, e.PooAmount, e.Color, e.Consistency, e.DiaperRash,
            e.Pounds, e.Ounces, e.HeightInches, e.HeadInches, e.Notes,
            e.Source.ToString(), e.UpdatedUtc is not null,
            // Imported rows carry an `hb:` key that means nothing to the panel, and reporting it as
            // a client key would have the client matching its own entries against Huckleberry's.
            e.ExternalKey is { } k && k.StartsWith(PanelKeyPrefix, StringComparison.Ordinal)
                ? k[PanelKeyPrefix.Length..]
                : null,
            e.Version);
    }
}

/// <summary>A session that is running or paused, with its elapsed time already worked out.</summary>
/// <remarks>
/// The server computes the elapsed minutes rather than handing over a start time and letting the
/// panel subtract: a paused timer is not simply "now minus started", and two places doing that sum
/// is two places to get a pause wrong.
/// </remarks>
public sealed record CareTimerDto(
    string Type,
    string? Side,
    DateTime StartedUtc,
    bool Paused,
    double ElapsedMinutes,
    int? PhaseOneMinutes,
    int? PhaseTwoMinutes,
    int? Phase,
    /// <summary>Elapsed minutes at the switch, so expression can be counted from it. Null before.</summary>
    double? PhaseTwoAtMinutes,
    /// <summary>Finished and held for its amount. The session is measured; nothing is written yet.</summary>
    DateTime? EndedUtc)
{
    public static CareTimerDto From(CareTimer t, double elapsed)
    {
        ArgumentNullException.ThrowIfNull(t);
        return new(t.Type.ToString(), t.Side, t.StartedUtc, t.PausedUtc is not null,
            Math.Round(elapsed, 2), t.PhaseOneMinutes, t.PhaseTwoMinutes, t.Phase, t.PhaseTwoAtMinutes,
            t.EndedUtc);
    }
}

/// <summary>Everything the landing screen needs, in one read.</summary>
public sealed record CareSummaryDto(
    IReadOnlyList<CareEntryDto> LastByType,
    IReadOnlyList<CareTimerDto> Timers);
