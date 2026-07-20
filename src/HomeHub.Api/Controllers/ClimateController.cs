namespace HomeHub.Api.Controllers;

using HomeHub.Api.Climate;
using Microsoft.AspNetCore.Mvc;

/// <summary>
/// Multi-zone climate via the climate seam: live zone state, set-point / mode changes, and
/// scene actions. With Home Assistant configured these drive the real mini-splits; otherwise a
/// simulated set of zones responds believably. No HA specifics leak here — only <see cref="IClimateProvider"/>.
/// </summary>
[ApiController]
[Route("api/[controller]")]
public class ClimateController : ControllerBase
{
    private const double MinSetPoint = 60;
    private const double MaxSetPoint = 85;

    private readonly IClimateProvider _climate;

    public ClimateController(IClimateProvider climate) => _climate = climate;

    /// <summary>All zones with live current temp / set point / mode.</summary>
    [HttpGet("zones")]
    public async Task<IReadOnlyList<ClimateZoneDto>> Zones(CancellationToken ct)
    {
        var zones = await _climate.GetZonesAsync(ct);
        return zones.Select(ClimateZoneDto.From).ToList();
    }

    [HttpPut("zones/{id:int}/setpoint")]
    public async Task<ActionResult<ClimateZoneDto>> SetPoint(int id, SetPointInput input, CancellationToken ct)
    {
        if (input.SetPointF < MinSetPoint || input.SetPointF > MaxSetPoint)
            return BadRequest($"Set point must be between {MinSetPoint} and {MaxSetPoint}°F.");
        var zone = await _climate.SetSetPointAsync(id, input.SetPointF, ct);
        return zone is null ? NotFound() : ClimateZoneDto.From(zone);
    }

    [HttpPut("zones/{id:int}/mode")]
    public async Task<ActionResult<ClimateZoneDto>> SetMode(int id, SetModeInput input, CancellationToken ct)
    {
        var zone = await _climate.SetModeAsync(id, input.Mode, ct);
        return zone is null ? NotFound() : ClimateZoneDto.From(zone);
    }

    /// <summary>Apply a scene: "evening" (saved preset) or "all-off".</summary>
    [HttpPost("scene")]
    public async Task<IActionResult> Scene(SceneInput input, CancellationToken ct)
    {
        var scene = input.Scene?.Trim().ToLowerInvariant();
        if (scene is not ("evening" or "all-off")) return BadRequest("Unknown scene.");
        await _climate.ApplySceneAsync(scene, ct);
        return NoContent();
    }
}
