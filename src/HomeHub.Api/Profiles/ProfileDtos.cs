namespace HomeHub.Api.Profiles;

/// <summary>Profile as sent to the client. Never exposes the PIN hash — only whether one is set.</summary>
public record ProfileDto(
    int Id,
    string Name,
    string Initial,
    bool HasPin,
    bool RequirePinWhenIdle,
    bool StayLoggedIn,
    int DisplayOrder)
{
    public static ProfileDto From(Profile p) => new(
        p.Id, p.Name, p.Initial, !string.IsNullOrEmpty(p.PinHash),
        p.RequirePinWhenIdle, p.StayLoggedIn, p.DisplayOrder);
}

/// <summary>Create payload — a new profile starts with no PIN.</summary>
public record CreateProfileRequest(string Name, string Initial);

/// <summary>Full update of a profile's editable fields (PIN is managed via its own endpoints).</summary>
public record UpdateProfileRequest(
    string Name,
    string Initial,
    bool RequirePinWhenIdle,
    bool StayLoggedIn,
    int DisplayOrder);

/// <summary>Set-PIN payload.</summary>
public record SetPinRequest(string Pin);

/// <summary>Verify-PIN payload.</summary>
public record VerifyPinRequest(string Pin);

/// <summary>Verify result — <c>success</c> false may also carry a lockout hint.</summary>
public record VerifyPinResult(bool Success, int? LockedForSeconds = null);
