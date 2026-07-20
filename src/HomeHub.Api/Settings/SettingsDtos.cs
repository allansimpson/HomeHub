namespace HomeHub.Api.Settings;

/// <summary>Household settings as sent to / from the client.</summary>
public record SettingsDto(
    int IdleTimeoutMinutes,
    bool IdleDimmingEnabled,
    int? ActiveProfileId)
{
    public static SettingsDto From(HouseholdSettings s) => new(
        s.IdleTimeoutMinutes, s.IdleDimmingEnabled, s.ActiveProfileId);
}

/// <summary>Update payload for the editable household settings (active profile has its own route).</summary>
public record UpdateSettingsRequest(
    int IdleTimeoutMinutes,
    bool IdleDimmingEnabled);

/// <summary>Active-profile switch payload; null clears the active profile.</summary>
public record SetActiveProfileRequest(int? ProfileId);
