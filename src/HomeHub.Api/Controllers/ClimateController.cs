namespace HomeHub.Api.Controllers;

using HomeHub.Api.Climate;
using HomeHub.Api.Data;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// The Climate section: the rooms the household names, the standing targets it owns, the two-hour
/// loans it borrows, and the mini-split units underneath.
/// </summary>
/// <remarks>
/// <b>Zones are rooms; units are machines.</b> <c>/zones</c> serves the panel — one call for the
/// whole screen — and every write on it moves a <em>target</em>. <c>/units</c> is the machine
/// surface: mode, scenes, and the raw set point the control loop owns. No screen offers to edit a
/// set point while the loop is running, so nothing on the panel calls
/// <c>PUT /units/{id}/setpoint</c>; it stays for the assistant and for a house with the loop paused.
/// </remarks>
[ApiController]
[Route("api/[controller]")]
public class ClimateController : ControllerBase
{
    private readonly IClimateProvider _units;
    private readonly ClimateReader _reader;
    private readonly ClimateCommands _commands;
    private readonly HomeHubDbContext _db;

    public ClimateController(
        IClimateProvider units, ClimateReader reader, ClimateCommands commands, HomeHubDbContext db)
    {
        _units = units;
        _reader = reader;
        _commands = commands;
        _db = db;
    }

    // ---- The panel ----

    /// <summary>Everything the Climate screen needs, in one call. The panel polls this.</summary>
    [HttpGet("zones")]
    public Task<ClimatePanelDto> Zones(CancellationToken ct) => _reader.GetPanelAsync(ct);

    /// <summary>
    /// Write the standing target: the drill-in's stepper, and the accepted repeat-offer.
    /// </summary>
    [HttpPut("zones/{id:int}/target")]
    public async Task<ActionResult<ClimatePanelDto>> SetTarget(int id, SetTargetInput input, CancellationToken ct)
    {
        if (input.TargetF < ClimateCommands.MinTargetF || input.TargetF > ClimateCommands.MaxTargetF)
            return BadRequest($"Target must be between {ClimateCommands.MinTargetF} and {ClimateCommands.MaxTargetF}°F.");
        return await _commands.SetStandingTargetAsync(id, input.TargetF, ct)
            ? await _reader.GetPanelAsync(ct)
            : NotFound();
    }

    /// <summary>Borrow the room for two hours. Supersedes any live loan and restarts the clock.</summary>
    [HttpPost("zones/{id:int}/override")]
    public async Task<ActionResult<ClimatePanelDto>> StartOverride(int id, OverrideInput input, CancellationToken ct)
    {
        if (input.TargetF < ClimateCommands.MinTargetF || input.TargetF > ClimateCommands.MaxTargetF)
            return BadRequest($"Target must be between {ClimateCommands.MinTargetF} and {ClimateCommands.MaxTargetF}°F.");
        var profileId = (await _db.Settings.FirstOrDefaultAsync(s => s.Id == 1, ct))?.ActiveProfileId;
        return await _commands.StartOverrideAsync(id, input.TargetF, profileId, ct)
            ? await _reader.GetPanelAsync(ct)
            : NotFound();
    }

    /// <summary>
    /// Keep what was borrowed — 3a's <c>KEEP 69°</c> and 3b's lift-on-keep.
    /// </summary>
    /// <remarks>
    /// One call on purpose. Setting the target and then deleting the override is two, and between
    /// them the zone holds a new standing target with a live loan against it — a state no screen
    /// renders. Promotion cannot half-fail here (CLIMATE_DATA_CONTRACT §3).
    /// </remarks>
    [HttpPost("zones/{id:int}/override/promote")]
    public async Task<ActionResult<ClimatePanelDto>> Promote(int id, PromoteInput? input, CancellationToken ct) =>
        await _commands.PromoteAsync(id, input?.TargetF, ct) ? await _reader.GetPanelAsync(ct) : NotFound();

    /// <summary>Cancel the live loan; the standing target comes straight back.</summary>
    [HttpDelete("zones/{id:int}/override")]
    public async Task<ActionResult<ClimatePanelDto>> CancelOverride(int id, CancellationToken ct) =>
        await _commands.CancelOverrideAsync(id, ct) ? await _reader.GetPanelAsync(ct) : NotFound();

    /// <summary>
    /// <c>UNDO</c> — restore the exact standing target the last promotion replaced.
    /// </summary>
    /// <remarks>
    /// Its own route rather than a flavour of <c>DELETE /override</c>, which the data contract folds
    /// them into: by the time <c>UNDO</c> is on the row the promotion has already ended the loan, so
    /// there is nothing left for a delete to act on. Raised as a contract conflict and resolved this
    /// way because the alternative — a delete that sometimes means "restore the previous target" —
    /// is a route whose meaning depends on state the caller cannot see.
    /// </remarks>
    [HttpPost("zones/{id:int}/undo")]
    public async Task<ActionResult<ClimatePanelDto>> Undo(int id, CancellationToken ct) =>
        await _commands.UndoAsync(id, ct) ? await _reader.GetPanelAsync(ct) : NotFound();

    /// <summary>The four per-room knobs: tolerance, correction strength, quiet hours, room pause.</summary>
    [HttpPatch("zones/{id:int}")]
    public async Task<ActionResult<ClimatePanelDto>> Patch(int id, PatchZoneInput input, CancellationToken ct) =>
        await _commands.PatchAsync(id, input, ct) ? await _reader.GetPanelAsync(ct) : NotFound();

    /// <summary>The drill-in's ledger page — why this room is what it is.</summary>
    [HttpGet("zones/{id:int}/writes")]
    public Task<IReadOnlyList<LoopWriteDto>> Writes(int id, [FromQuery] int take = 30, CancellationToken ct = default) =>
        _reader.GetWritesAsync(id, take, ct);

    /// <summary>Answer the repeat-offer. Declining suppresses that room and time of day for 30 days.</summary>
    [HttpPost("zones/{id:int}/offer")]
    public async Task<ActionResult<ClimatePanelDto>> Offer(
        int id, OfferReplyInput input, [FromQuery] double targetF, [FromQuery] int windowHour, CancellationToken ct)
    {
        return await _commands.ReplyToOfferAsync(id, input.Accept, targetF, windowHour, ct)
            ? await _reader.GetPanelAsync(ct)
            : NotFound();
    }

    /// <summary>Pause or resume the whole house. Reversible, immediate, and it turns nothing off.</summary>
    [HttpPost("pause")]
    public async Task<ClimatePanelDto> Pause(PauseHouseInput input, CancellationToken ct)
    {
        await _commands.PauseHouseAsync(input.Paused, ct);
        return await _reader.GetPanelAsync(ct);
    }

    /// <summary>Every unit off. Destructive-adjacent, so the panel puts a hold-to-confirm in front of it.</summary>
    [HttpPost("units/off")]
    public async Task<IActionResult> UnitsOff(CancellationToken ct)
    {
        await _commands.AllUnitsOffAsync(ct);
        return NoContent();
    }

    // ---- The machines ----

    /// <summary>Every mini-split with the state it reports about itself.</summary>
    [HttpGet("units")]
    public async Task<IReadOnlyList<ClimateUnitDto>> Units(CancellationToken ct)
    {
        var units = await _units.GetUnitsAsync(ct);
        return units.Select(ClimateUnitDto.From).ToList();
    }

    /// <summary>
    /// Move a unit's set point directly.
    /// </summary>
    /// <remarks>
    /// Not reachable from the Climate screen, and that is the point: while the loop is running the
    /// set point is not the household's to move, and anything written here is put back within ten
    /// minutes. It stays for the assistant and for a house running with the loop paused.
    /// </remarks>
    [HttpPut("units/{id:int}/setpoint")]
    public async Task<ActionResult<ClimateUnitDto>> SetPoint(int id, SetPointInput input, CancellationToken ct)
    {
        if (input.SetPointF < ClimateLoop.UnitMinF || input.SetPointF > ClimateLoop.UnitMaxF)
            return BadRequest($"Set point must be between {ClimateLoop.UnitMinF} and {ClimateLoop.UnitMaxF}°F.");
        var unit = await _units.SetSetPointAsync(id, input.SetPointF, ct);
        return unit is null ? NotFound() : ClimateUnitDto.From(unit);
    }

    /// <summary>Mode passthrough. The loop never changes mode or fan speed — it moves set points only.</summary>
    [HttpPut("units/{id:int}/mode")]
    public async Task<ActionResult<ClimateUnitDto>> SetMode(int id, SetModeInput input, CancellationToken ct)
    {
        var unit = await _units.SetModeAsync(id, input.Mode, ct);
        return unit is null ? NotFound() : ClimateUnitDto.From(unit);
    }

    /// <summary>Apply a scene: "evening" (saved preset) or "all-off".</summary>
    [HttpPost("scene")]
    public async Task<IActionResult> Scene(SceneInput input, CancellationToken ct)
    {
        var scene = input.Scene?.Trim().ToLowerInvariant();
        if (scene is not ("evening" or "all-off")) return BadRequest("Unknown scene.");
        await _units.ApplySceneAsync(scene, ct);
        return NoContent();
    }
}
