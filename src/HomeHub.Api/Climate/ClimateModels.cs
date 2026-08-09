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

/// <summary>
/// A mini-split unit as sent to the client — what the machine reports about itself.
/// </summary>
/// <remarks>
/// Only the room drill-in renders this, and only as a fact (CLIMATE_SCREEN §8 · THE UNIT). No row
/// on the Climate list shows a set point, and nothing on the panel offers to edit one: while the
/// loop is running the set point is not the household's to move.
/// </remarks>
public record ClimateUnitDto(
    int Id,
    string Name,
    double CurrentTempF,
    double? SetPointF,
    string Mode,
    string? FanMode,
    bool Running,
    string Source,
    /// <summary>Local clock estimate of when the set point is reached, e.g. "8:10 PM"; null when already there / off.</summary>
    string? ReachesAtLocal)
{
    /// <summary>Rough minutes to move one °F — enough for a plausible "reaches by" estimate on the panel.</summary>
    private const double MinutesPerDegree = 6;

    public static ClimateUnitDto From(ClimateUnit z)
    {
        var current = Math.Round(z.CurrentTempF);
        var running = z.Mode != ClimateMode.Off;
        var setPoint = running ? Math.Round(z.SetPointF) : (double?)null;
        return new(
            z.Id, z.Name, current, setPoint,
            z.Mode.ToString(), z.FanMode, running, z.Source,
            EstimateReachesAt(z.Mode, current, setPoint));
    }

    /// <summary>Only Cool/Heat with a &gt;=1° gap produce an ETA (Fan/Auto/Off hold, so none).</summary>
    private static string? EstimateReachesAt(ClimateMode mode, double currentF, double? setPointF)
    {
        if (setPointF is not { } target || (mode != ClimateMode.Cool && mode != ClimateMode.Heat)) return null;
        var delta = Math.Abs(currentF - target);
        if (delta < 1) return null;
        var reachesAt = DateTime.Now.AddMinutes(delta * MinutesPerDegree);
        return reachesAt.ToString("h:mm tt", System.Globalization.CultureInfo.InvariantCulture);
    }
}

/// <summary>Set-point change payload (°F).</summary>
public record SetPointInput(double SetPointF);

/// <summary>Mode change payload.</summary>
public record SetModeInput(ClimateMode Mode);

/// <summary>Scene action payload — "evening" or "all-off".</summary>
public record SceneInput(string Scene);
