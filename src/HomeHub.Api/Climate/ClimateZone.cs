namespace HomeHub.Api.Climate;

/// <summary>
/// A conditioned zone (a mini-split unit). Local store for the simulated provider and offline
/// cache for the Home Assistant provider (<see cref="ProviderRef"/> = HA <c>climate.*</c> entity
/// id when sourced from HA). Set point is only meaningful when <see cref="Mode"/> is not Off.
/// </summary>
public class ClimateZone
{
    public int Id { get; set; }

    public required string Name { get; set; }

    /// <summary>Providing source: "simulated" or "homeassistant".</summary>
    public required string Source { get; set; }

    /// <summary>Opaque source id (HA entity id, or a sim key).</summary>
    public required string ProviderRef { get; set; }

    public double CurrentTempF { get; set; }
    public double SetPointF { get; set; }

    public ClimateMode Mode { get; set; }

    /// <summary>Fan setting label, e.g. "Quiet" / "Auto" (display only).</summary>
    public string? FanMode { get; set; }

    public int DisplayOrder { get; set; }

    public DateTime UpdatedUtc { get; set; }
}
