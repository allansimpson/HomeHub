namespace HomeHub.Api.Climate;

/// <summary>
/// The climate seam: enumerate zones with live state and control set point / mode / scenes. All
/// Climate UI/logic depends on this, never on Home Assistant specifics.
/// <see cref="SimulatedClimateProvider"/> is the local default; <see cref="HomeAssistantClimateProvider"/>
/// drives real mini-splits through HA when configured.
/// </summary>
public interface IClimateProvider
{
    string Source { get; }

    Task<IReadOnlyList<ClimateZone>> GetZonesAsync(CancellationToken ct);
    Task<ClimateZone?> SetSetPointAsync(int id, double setPointF, CancellationToken ct);
    Task<ClimateZone?> SetModeAsync(int id, ClimateMode mode, CancellationToken ct);

    /// <summary>Apply a named scene: "evening" (a saved multi-zone preset) or "all-off".</summary>
    Task ApplySceneAsync(string scene, CancellationToken ct);
}
