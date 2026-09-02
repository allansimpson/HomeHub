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

/// <summary>
/// What the sign-in picker needs, and nothing else.
/// </summary>
/// <remarks>
/// <b>The roster is readable before anybody has signed in</b> — the picker has to draw names before
/// there is a session to authorise it — and the full <see cref="ProfileDto"/> was what it drew from.
/// That handed an unauthenticated caller the household's security policy: who is an administrator,
/// who has a PIN, who locks when idle, who stays signed in, and stable ids for all of them. Anyone
/// who can reach the panel could read which member to attack and how that member is defended.
///
/// Signing in needs four things: an id to sign in as, a name and an initial to draw, and whether a
/// keypad is required. <see cref="HasPin"/> is the one that looks like policy and is not — the server
/// demands the PIN of any profile that has one, so a picker that could not ask would simply fail.
///
/// Everything else moved behind authentication. `Role` in particular is not the picker's business:
/// the panel never draws it before sign-in, and publishing it names the account worth compromising.
/// </remarks>
public record ProfilePickerDto(int Id, string Name, string Initial, bool HasPin)
{
    public static ProfilePickerDto From(Profile p) =>
        new(p.Id, p.Name, p.Initial, !string.IsNullOrEmpty(p.PinHash));
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
/// <summary>
/// How a profile wants to be locked when the panel goes idle. <b>Its owner's setting alone.</b>
/// </summary>
/// <remarks>
/// Separate from <see cref="UpdateProfileRequest"/> because the two answer to different people. A
/// name, an initial and a running order are the household's to arrange and live behind the admin
/// policy; whether <i>your</i> screen locks when you walk away is yours, and an administrator
/// turning it off is the same act as unlocking your profile.
/// </remarks>
public record LockPreferenceRequest(bool RequirePinWhenIdle, bool StayLoggedIn);

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
