namespace HomeHub.Api.Settings;

/// <summary>Household settings as sent to / from the client.</summary>
public record SettingsDto(
    int IdleTimeoutMinutes,
    bool IdleDimmingEnabled,
    string DaylightBoost,
    int? ActiveProfileId,
    /// <summary>What the household calls the cat; null falls back to the literal word everywhere.</summary>
    string? CatName,
    /// <summary>Drawer fullness (%) at which the panel asks for the litter to be changed.</summary>
    int LitterFullPercent)
{
    public static SettingsDto From(HouseholdSettings s) => new(
        s.IdleTimeoutMinutes, s.IdleDimmingEnabled, s.DaylightBoost, s.ActiveProfileId, s.CatName,
        s.LitterFullPercent);
}

/// <summary>Update payload for the editable household settings (active profile has its own route).</summary>
public record UpdateSettingsRequest(
    int IdleTimeoutMinutes,
    bool IdleDimmingEnabled,
    string DaylightBoost);

/// <summary>Active-profile switch payload; null clears the active profile.</summary>
public record SetActiveProfileRequest(int? ProfileId);

/// <summary>
/// The cat's name, on its own route.
/// </summary>
/// <remarks>
/// Separate from <see cref="UpdateSettingsRequest"/> because it is edited from Litter Settings, which
/// holds no idle-timeout or daylight state to send back — folding it into the whole-object PUT would
/// make that screen capable of clobbering settings it never showed. Blank clears it.
/// </remarks>
public record SetCatNameRequest(string? Name);

/// <summary>
/// The drawer-full threshold, on its own route for the same reason as <see cref="SetCatNameRequest"/>:
/// it is edited from Litter Settings, which holds none of the whole-object PUT's other state.
/// </summary>
public record SetLitterFullPercentRequest(int Percent);
