namespace HomeHub.Api.Climate;

/// <summary>
/// The climate seam: enumerate mini-split units with live state and control set point / mode /
/// scenes. Everything that touches a unit — the control loop included — depends on this and never
/// on Home Assistant specifics. <see cref="SimulatedClimateProvider"/> is the local default;
/// <see cref="HomeAssistantClimateProvider"/> drives the real units through HA when configured.
/// </summary>
/// <remarks>
/// This is the <em>only</em> path to a unit. Sensibo's own cloud API is deliberately not used: the
/// units are already in Home Assistant, and a second control path would fight the first
/// (CLIMATE_DATA_CONTRACT §5).
/// </remarks>
public interface IClimateProvider
{
    string Source { get; }

    Task<IReadOnlyList<ClimateUnit>> GetUnitsAsync(CancellationToken ct);
    Task<ClimateUnit?> SetSetPointAsync(int id, double setPointF, CancellationToken ct);
    Task<ClimateUnit?> SetModeAsync(int id, ClimateMode mode, CancellationToken ct);

    /// <summary>Apply a named scene: "evening" (a saved multi-unit preset) or "all-off".</summary>
    Task ApplySceneAsync(string scene, CancellationToken ct);
}
