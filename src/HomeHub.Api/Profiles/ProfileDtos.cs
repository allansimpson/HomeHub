namespace HomeHub.Api.Profiles;

/// <summary>
/// Profile as sent to the client. Never exposes the PIN hash — only whether one is set.
///
/// <see cref="Role"/> crosses as a string, following every other response DTO here
/// (<c>MealPlanEntryDto.Slot</c>, <c>ClimateRowDto.Mode</c>): the name is what the client TS union
/// mirrors, and an ordinal would put the two out of lockstep the first time an enum member is
/// inserted rather than appended.
/// </summary>
public record ProfileDto(
    int Id,
    string Name,
    string Initial,
    bool HasPin,
    bool RequirePinWhenIdle,
    bool StayLoggedIn,
    int DisplayOrder,
    string Role)
{
    public static ProfileDto From(Profile p) => new(
        p.Id, p.Name, p.Initial, !string.IsNullOrEmpty(p.PinHash),
        p.RequirePinWhenIdle, p.StayLoggedIn, p.DisplayOrder, p.Role.ToString());
}

/// <summary>Create payload — a new profile starts with no PIN and as a Member.</summary>
public record CreateProfileRequest(string Name, string Initial);

/// <summary>
/// Full update of a profile's editable fields (PIN is managed via its own endpoints).
///
/// <see cref="Role"/> is the exception to "full": it is nullable and <c>null</c> means <i>leave as
/// it is</i>. Every other field here is a display detail a stale client can safely round-trip, but
/// a grant that governs who may change the panel's settings should not be revoked by omission.
/// </summary>
public record UpdateProfileRequest(
    string Name,
    string Initial,
    bool RequirePinWhenIdle,
    bool StayLoggedIn,
    int DisplayOrder,
    ProfileRole? Role = null);

/// <summary>Set-PIN payload.</summary>
/// <param name="CurrentPin">
/// The PIN being replaced, required when a member is changing their <i>own</i> — see
/// <c>ProfilesController.RefuseWithoutCurrentPin</c>. Null on the two occasions there is nothing to
/// prove: a profile that has no PIN yet, and an administrator resetting somebody else's.
/// <para>
/// Optional and last so that every existing caller — and the tests that construct this positionally
/// — still compiles and still means the same thing.
/// </para>
/// </param>
public record SetPinRequest(string Pin, string? CurrentPin = null);

/// <summary>
/// Clear-PIN payload: the PIN being removed, on the same rule as changing one.
/// </summary>
/// <remarks>
/// A body on a <c>DELETE</c>, which is unusual enough to say why: the alternative is a query string,
/// and a query string is the one place a PIN reliably ends up written down — in an access log. The
/// whole request is optional (see the endpoint), so a caller with nothing to prove sends nothing.
/// </remarks>
public record ClearPinRequest(string? CurrentPin = null);

/// <summary>Verify-PIN payload.</summary>
public record VerifyPinRequest(string Pin);

/// <summary>Verify result — <c>success</c> false may also carry a lockout hint.</summary>
public record VerifyPinResult(bool Success, int? LockedForSeconds = null);
