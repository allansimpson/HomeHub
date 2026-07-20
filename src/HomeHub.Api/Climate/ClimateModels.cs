namespace HomeHub.Api.Climate;

/// <summary>HVAC mode. Off means the unit is powered down (no set point shown).</summary>
public enum ClimateMode
{
    Off = 0,
    Cool = 1,
    Heat = 2,
    Fan = 3,
    Auto = 4,
}

/// <summary>A climate zone as sent to the client.</summary>
public record ClimateZoneDto(
    int Id,
    string Name,
    double CurrentTempF,
    double? SetPointF,
    string Mode,
    string? FanMode,
    bool Running,
    string Source)
{
    public static ClimateZoneDto From(ClimateZone z) => new(
        z.Id, z.Name, Math.Round(z.CurrentTempF),
        z.Mode == ClimateMode.Off ? null : Math.Round(z.SetPointF),
        z.Mode.ToString(), z.FanMode, z.Mode != ClimateMode.Off, z.Source);
}

/// <summary>Set-point change payload (°F).</summary>
public record SetPointInput(double SetPointF);

/// <summary>Mode change payload.</summary>
public record SetModeInput(ClimateMode Mode);

/// <summary>Scene action payload — "evening" or "all-off".</summary>
public record SceneInput(string Scene);
