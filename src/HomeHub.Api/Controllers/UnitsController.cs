namespace HomeHub.Api.Controllers;

using HomeHub.Api.Pantry;
using Microsoft.AspNetCore.Mvc;

/// <summary>
/// The units the household measures in, for every field that asks for one.
/// </summary>
/// <remarks>
/// Read-only, and deliberately so. There is no "add a unit" screen anywhere in the app because
/// there does not need to be one: typing a unit nobody has used before <i>is</i> adding it
/// (<see cref="UnitRegistry"/>), which happens at the moment somebody actually needs it rather than
/// in a settings page they would have to think to visit first.
/// </remarks>
[ApiController]
[Route("api/units")]
public class UnitsController : ControllerBase
{
    private readonly UnitRegistry _units;

    public UnitsController(UnitRegistry units)
    {
        _units = units;
    }

    /// <summary>The whole list, in picker order — predefined first, then whatever has been typed.</summary>
    [HttpGet]
    public async Task<IReadOnlyList<MeasurementUnitDto>> List(CancellationToken ct)
    {
        var units = await _units.ListAsync(ct);
        return units
            .Select(u => new MeasurementUnitDto(
                u.Canonical,
                u.DisplayName,
                u.Aliases.Select(a => a.Alias).OrderBy(a => a.Length).ThenBy(a => a).ToList(),
                u.IsSeeded))
            .ToList();
    }
}
