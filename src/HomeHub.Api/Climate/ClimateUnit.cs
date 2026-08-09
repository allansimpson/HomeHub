namespace HomeHub.Api.Climate;

/// <summary>
/// A mini-split unit. Local store for the simulated provider and offline cache for the Home
/// Assistant provider (<see cref="ProviderRef"/> = HA <c>climate.*</c> entity id when sourced from
/// HA). Set point is only meaningful when <see cref="Mode"/> is not Off.
/// </summary>
/// <remarks>
/// <b>Named for the machine, not the room.</b> This was <c>ClimateZone</c> until the Climate rework,
/// which needed that word for the thing a household actually names — a room with a probe, a standing
/// target and a class (<see cref="Climate.ClimateZone"/>). Two entities called "zone", one meaning
/// the unit and one meaning the room, is precisely the confusion the section exists to remove: the
/// probe is the truth and the set point is the machine's business, so they cannot share a noun.
/// <para>
/// What a unit owns is one number the loop writes — <see cref="SetPointF"/> — plus the mode and fan
/// setting it reports. Nothing here is a person's preference.
/// </para>
/// </remarks>
public class ClimateUnit
{
    public int Id { get; set; }

    public required string Name { get; set; }

    /// <summary>Providing source: "simulated" or "homeassistant".</summary>
    public required string Source { get; set; }

    /// <summary>Opaque source id (HA entity id, or a sim key).</summary>
    public required string ProviderRef { get; set; }

    /// <summary>
    /// The unit's own return-air reading — the air two feet below the ceiling beside it, which is
    /// <em>not</em> the temperature of the room. The loop never controls against this; it is here so
    /// the drill-in can show what the machine thinks it is doing.
    /// </summary>
    public double CurrentTempF { get; set; }

    public double SetPointF { get; set; }

    public ClimateMode Mode { get; set; }

    /// <summary>Fan setting label, e.g. "Quiet" / "Auto" (display only).</summary>
    public string? FanMode { get; set; }

    public int DisplayOrder { get; set; }

    public DateTime UpdatedUtc { get; set; }
}
