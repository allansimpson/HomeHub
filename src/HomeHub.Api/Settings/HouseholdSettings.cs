namespace HomeHub.Api.Settings;

/// <summary>
/// Single household-level settings row (id fixed to 1). Modelled as one extensible record so
/// later stages can add fields (Stage 2 populates the alert thresholds this stage only stores).
/// Per-user preferences live on <see cref="Profiles.Profile"/>; this is the shared surface.
/// </summary>
public class HouseholdSettings
{
    /// <summary>Always 1 — there is exactly one household settings row.</summary>
    public int Id { get; set; } = 1;

    /// <summary>Minutes of inactivity before the panel returns to the dashboard / Lock.</summary>
    public int IdleTimeoutMinutes { get; set; } = 5;

    /// <summary>Dim the dashboard to 40% after 10 PM (see the daylight/idle behaviour).</summary>
    public bool IdleDimmingEnabled { get; set; } = true;

    /// <summary>Alert-threshold placeholder — freezer warning above this °C. Consumed in Stage 2.</summary>
    public int FreezerWarnAboveCelsius { get; set; } = 10;

    /// <summary>Alert-threshold placeholder — humidity warning above this %. Consumed in Stage 2.</summary>
    public int HumidityWarnAbovePercent { get; set; } = 65;

    /// <summary>Which profile is currently active on the panel (persists across reboots). Null = none chosen.</summary>
    public int? ActiveProfileId { get; set; }
}
