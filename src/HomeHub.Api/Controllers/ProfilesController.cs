namespace HomeHub.Api.Controllers;

using System.Linq;
using HomeHub.Api.Auth;
using HomeHub.Api.Data;
using HomeHub.Api.Profiles;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// Household profile CRUD plus PIN set and clear. Hashes are never returned to the client (see
/// <see cref="ProfileDto"/>).
///
/// <para>
/// <b><c>verify-pin</c> used to live here and is gone</b> (AUDIT A1). It answered "is this the right
/// PIN" and left it to the browser whether to act on the answer, which made the lock advisory — and
/// the PIN it guarded could be cleared by an unauthenticated <c>DELETE</c> from anything on the LAN.
/// The PIN is now checked by <c>POST /api/session</c>, where getting it right is what mints the
/// cookie rather than what returns <c>true</c>. Its lockout counter moved to <see cref="PinLockout"/>
/// so both places share one, and five attempts means five rather than five per endpoint.
/// </para>
/// </summary>
[ApiController]
[Route("api/[controller]")]
public class ProfilesController : ControllerBase
{
    private const int PinLength = 4;

    private readonly HomeHubDbContext _db;
    private readonly PinLockout _lockout;

    public ProfilesController(HomeHubDbContext db, PinLockout lockout)
    {
        _db = db;
        _lockout = lockout;
    }

    /// <summary>The household roster, for the tile picker and the sign-in screen.</summary>
    /// <remarks>
    /// <b>Anonymous, because the sign-in screen has to draw before anyone is signed in.</b> This is
    /// the same trade every lock screen makes: names and monograms are visible to anyone who can
    /// reach the panel, which is anyone who can already see the panel on the wall. It exposes no
    /// PIN hash (<see cref="ProfileDto"/> reports only <c>HasPin</c>), no role-bearing action, and
    /// nothing about what any member has done. Everything the roster is a key *to* is authorised.
    /// </remarks>
    [AllowAnonymous]
    [HttpGet]
    public async Task<IReadOnlyList<ProfileDto>> List() =>
        await _db.Profiles
            .OrderBy(p => p.DisplayOrder)
            .Select(p => ProfileDto.From(p))
            .ToListAsync();

    /// <summary>Add a household member. Administrators only (AUDIT A1.4).</summary>
    [Authorize(Policy = Household.AdminPolicy)]
    [HttpPost]
    public async Task<ActionResult<ProfileDto>> Create(CreateProfileRequest req)
    {
        var name = req.Name?.Trim();
        if (string.IsNullOrEmpty(name)) return BadRequest("Name is required.");

        var nextOrder = await _db.Profiles.AnyAsync()
            ? await _db.Profiles.MaxAsync(p => p.DisplayOrder) + 1
            : 0;

        var profile = new Profile
        {
            Name = name,
            Initial = NormalizeInitial(req.Initial, name),
            DisplayOrder = nextOrder,
            StayLoggedIn = true,
        };
        _db.Profiles.Add(profile);
        await _db.SaveChangesAsync();

        return CreatedAtAction(nameof(List), new { id = profile.Id }, ProfileDto.From(profile));
    }

    /// <summary>
    /// Edit a member. Administrators only — this is also where <see cref="ProfileRole"/> is granted.
    /// </summary>
    /// <remarks>
    /// The role field is what makes this an admin endpoint rather than a merely sensitive one:
    /// without the gate, any caller could promote themselves and the policy would mean nothing.
    /// </remarks>
    [Authorize(Policy = Household.AdminPolicy)]
    [HttpPut("{id:int}")]
    public async Task<ActionResult<ProfileDto>> Update(int id, UpdateProfileRequest req)
    {
        var profile = await _db.Profiles.FindAsync(id);
        if (profile is null) return NotFound();

        var name = req.Name?.Trim();
        if (string.IsNullOrEmpty(name)) return BadRequest("Name is required.");

        profile.Name = name;
        profile.Initial = NormalizeInitial(req.Initial, name);
        profile.RequirePinWhenIdle = req.RequirePinWhenIdle;
        profile.StayLoggedIn = req.StayLoggedIn;
        profile.DisplayOrder = req.DisplayOrder;
        // Omitted means unchanged — see UpdateProfileRequest. A payload that never mentions
        // ageBand must not be able to un-child a profile.
        if (req.Role is { } role) profile.Role = role;

        await _db.SaveChangesAsync();
        return ProfileDto.From(profile);
    }

    /// <summary>Remove a household member. Administrators only.</summary>
    [Authorize(Policy = Household.AdminPolicy)]
    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id)
    {
        var profile = await _db.Profiles.FindAsync(id);
        if (profile is null) return NotFound();

        _db.Profiles.Remove(profile);
        await _db.SaveChangesAsync();
        _lockout.Forget(id);
        return NoContent();
    }

    /// <summary>Set or change a member's PIN. Their own, or an administrator setting anyone's.</summary>
    /// <remarks>
    /// <para>
    /// Self-or-admin rather than admin-only, because a household member choosing their own PIN
    /// should not have to find someone else to do it — and because admin-only would mean a
    /// household with no administrator (see <see cref="HouseholdAdminHandler"/>) could not set a
    /// PIN at all, which is the wrong way round for the endpoint that creates the lock.
    /// </para>
    /// <para>
    /// The check is here rather than in a policy because it depends on the route value: it is a
    /// question about <i>this</i> profile, not about the caller in general.
    /// </para>
    /// <para>
    /// <b>Changing your own PIN means proving you still know it</b> — see
    /// <see cref="RefuseWithoutCurrentPin"/>. A session is not that proof: the wall panel holds a
    /// persistent one, so anybody standing at an unlocked kitchen screen could otherwise set the
    /// PIN to something only they knew and lock the household out of a member's own profile.
    /// </para>
    /// </remarks>
    [HttpPut("{id:int}/pin")]
    public async Task<IActionResult> SetPin(int id, SetPinRequest req)
    {
        if (!MaySetPinFor(id)) return Forbid();
        if (!IsValidPin(req.Pin)) return BadRequest($"PIN must be {PinLength} digits.");

        var profile = await _db.Profiles.FindAsync(id);
        if (profile is null) return NotFound();

        if (RefuseWithoutCurrentPin(profile, req.CurrentPin) is { } refusal) return refusal;

        // Creating a lock implies the profile wants to be lockable when idle — but *changing* the
        // PIN says nothing about that, and asserting it here would quietly re-enable idle locking
        // for somebody who deliberately turned it off and kept the PIN on sign-in. The two settings
        // answer different questions (see `lockGating.rowAction`), and only the first is implied.
        var creating = string.IsNullOrEmpty(profile.PinHash);
        profile.PinHash = PinHasher.Hash(req.Pin);
        if (creating)
        {
            profile.RequirePinWhenIdle = true;
            profile.StayLoggedIn = false;
        }
        await _db.SaveChangesAsync();
        _lockout.Forget(id);
        return NoContent();
    }

    /// <summary>
    /// Remove a member's PIN. Their own, or an administrator removing anyone's.
    /// </summary>
    /// <remarks>
    /// <b>This is the endpoint AUDIT A1 opens with.</b> Unauthenticated, it meant the lock screen
    /// was decorative: anything on the LAN could clear the PIN and then walk up to a panel that no
    /// longer asked for one. It is now the same self-or-admin rule as setting one, behind a session
    /// that the PIN itself is what mints — so clearing a PIN requires already having got past it.
    /// <para>
    /// <b>Removing your own PIN asks for it first, exactly as changing it does.</b> Without that the
    /// re-entry <see cref="SetPin"/> demands would be theatre: clear, then set, is a change of PIN
    /// with two taps and no PIN typed. The current one travels in the body — unusual on a
    /// <c>DELETE</c>, and preferable to a query string, which is the one place a PIN would end up in
    /// a log. An absent body is allowed and means "none offered", which is all an administrator
    /// resetting somebody else's needs to send.
    /// </para>
    /// </remarks>
    [HttpDelete("{id:int}/pin")]
    public async Task<IActionResult> ClearPin(
        int id,
        [FromBody(EmptyBodyBehavior = EmptyBodyBehavior.Allow)] ClearPinRequest? req)
    {
        if (!MaySetPinFor(id)) return Forbid();

        var profile = await _db.Profiles.FindAsync(id);
        if (profile is null) return NotFound();

        if (RefuseWithoutCurrentPin(profile, req?.CurrentPin) is { } refusal) return refusal;

        profile.PinHash = null;
        profile.RequirePinWhenIdle = false;
        profile.StayLoggedIn = true;
        await _db.SaveChangesAsync();
        _lockout.Forget(id);
        return NoContent();
    }

    /// <summary>Whether the caller may change this profile's PIN: it is theirs, or they are admin.</summary>
    private bool MaySetPinFor(int id) => User.ProfileId() == id || User.IsHouseholdAdmin();

    /// <summary>
    /// The refusal to return when somebody is changing their own PIN and has not proved they know
    /// the one they have — or null when there is nothing to prove.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Two cases pass straight through, and both are deliberate. A profile with no PIN has nothing
    /// to ask for; and an <i>administrator acting on somebody else</i> is the household's only
    /// recovery path for a PIN that has been forgotten, which is a real event in a house with a
    /// child's tablet in it. What is closed is the case that made the lock advisory in practice: the
    /// wall panel holds a persistent session, so "already signed in" was enough to overwrite the PIN
    /// of the profile that was signed in — the one thing the PIN exists to stop.
    /// </para>
    /// <para>
    /// Wrong attempts go through the same <see cref="PinLockout"/> as sign-in, so this is not a
    /// quieter place to guess four digits: five tries here and at the Lock screen are five tries in
    /// total. The body is a <see cref="SignInFailure"/> because it is the same fact — a PIN was
    /// refused, and possibly with a cooldown — and the client already reads that shape to draw the
    /// wait.
    /// </para>
    /// </remarks>
    private IActionResult? RefuseWithoutCurrentPin(Profile profile, string? currentPin)
    {
        if (string.IsNullOrEmpty(profile.PinHash)) return null;
        if (User.ProfileId() != profile.Id) return null;

        if (_lockout.RetryAfterSeconds(profile.Id) is { } cooldown)
            return Unauthorized(new SignInFailure("Too many attempts. Wait a moment.", cooldown));

        if (string.IsNullOrEmpty(currentPin) || !PinHasher.Verify(currentPin, profile.PinHash))
        {
            var started = _lockout.RecordFailure(profile.Id);
            return Unauthorized(new SignInFailure("That PIN is not right.", started));
        }

        return null;
    }

    private static bool IsValidPin(string? pin) =>
        pin is { Length: PinLength } && pin.All(char.IsDigit);

    /// <summary>Uppercase 1–2 char monogram; falls back to the first letter of the name.</summary>
    private static string NormalizeInitial(string? initial, string name)
    {
        var source = string.IsNullOrWhiteSpace(initial) ? name : initial.Trim();
        source = source.ToUpperInvariant();
        return source.Length > 2 ? source[..2] : source;
    }
}
