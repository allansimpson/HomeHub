namespace HomeHub.Api.Controllers;

using HomeHub.Api.Auth;
using HomeHub.Api.Data;
using HomeHub.Api.Profiles;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// Who this device is signed in as (AUDIT A1).
/// </summary>
/// <remarks>
/// <para>
/// <b>What changed, and why it is not just "a login screen".</b> Before this, "who is active" was
/// a single row in household settings — one value, shared by every device, set by an unauthenticated
/// <c>PUT</c>. It answered a display question ("whose avatar is in the corner") and was then used
/// as the answer to an authorisation question ("whose chat history may I read"), which it could
/// never be: any client could change it, and every client shared it.
/// </para>
/// <para>
/// A session is per-device. The wall panel signs in once and stays signed in; a phone signs in as
/// whoever is holding it; the two no longer overwrite each other. That is a behaviour change and a
/// deliberate one — the old model meant somebody opening Assist on their phone changed whose
/// account the panel in the kitchen was showing.
/// </para>
/// <para>
/// <b>The PIN is now load-bearing.</b> <c>verify-pin</c> was advisory: it answered a question the
/// browser was free to ignore, and the PIN it guarded could be cleared by an unauthenticated
/// <c>DELETE</c> from anything on the LAN. Here the PIN is what mints the cookie, so declining to
/// ask it does not get you in.
/// </para>
/// </remarks>
[ApiController]
[Route("api/session")]
public class SessionController : ControllerBase
{
    private readonly HomeHubDbContext? _db;
    private readonly PinLockout _lockout;
    private readonly ILogger<SessionController> _logger;

    public SessionController(PinLockout lockout, ILogger<SessionController> logger, HomeHubDbContext? db = null)
    {
        _lockout = lockout;
        _logger = logger;
        _db = db;
    }

    /// <summary>Who this device is signed in as. Anonymous — the answer may be "nobody".</summary>
    /// <remarks>
    /// The client's first call on boot. It is <c>[AllowAnonymous]</c> because "am I signed in" that
    /// requires being signed in to ask is not a useful question, and answering 401 here would make
    /// the shell unable to tell a signed-out panel from an unreachable server — which are the two
    /// states it most needs to distinguish, since one shows a sign-in screen and the other shows
    /// "Reconnecting".
    /// </remarks>
    [AllowAnonymous]
    [HttpGet]
    public ActionResult<SessionDto> Current()
    {
        if (User.ProfileId() is not { } profileId) return new SessionDto(null, null, false, false);

        return new SessionDto(profileId, User.ProfileName(), User.IsHouseholdAdmin(), true);
    }

    /// <summary>Sign this device in as a member.</summary>
    /// <remarks>
    /// <para>
    /// The PIN is required exactly when the profile has one. A profile with no PIN signs in by being
    /// chosen, which is what keeps a shared kitchen panel usable — the household's own decision
    /// about whether their panel needs a PIN is recorded on the profile, and this endpoint honours
    /// it rather than overriding it.
    /// </para>
    /// <para>
    /// <b><c>remember</c> is what makes the kiosk survivable.</b> The wall panel sets it and holds a
    /// persistent cookie, so a power cut does not leave the household at a sign-in screen they have
    /// to find a PIN for before they can see the time. A phone leaves it off and gets a session
    /// cookie that dies with the browser.
    /// </para>
    /// </remarks>
    [AllowAnonymous]
    [EnableRateLimiting(RateLimits.SignIn)]
    [HttpPost]
    public async Task<ActionResult<SessionDto>> SignIn(SignInRequest req)
    {
        if (_db is null) return StatusCode(StatusCodes.Status503ServiceUnavailable, "No database is configured.");

        var profile = await _db.Profiles.FindAsync(req.ProfileId);
        // Deliberately the same answer as a wrong PIN. Distinguishing them turns this endpoint into
        // a way to enumerate which profile ids exist, and the sign-in screen already lists the real
        // ones — so the distinction helps nobody who is meant to be here.
        if (profile is null) return this.CredentialRejected(new SignInFailure("That did not work.", null));

        if (_lockout.RetryAfterSeconds(profile.Id) is { } cooldown)
            return this.CredentialRejected(new SignInFailure("Too many attempts. Wait a moment.", cooldown));

        if (!string.IsNullOrEmpty(profile.PinHash))
        {
            if (string.IsNullOrEmpty(req.Pin) || !PinHasher.Verify(req.Pin, profile.PinHash))
            {
                var started = _lockout.RecordFailure(profile.Id);
                return this.CredentialRejected(new SignInFailure("That PIN is not right.", started));
            }
        }

        _lockout.Forget(profile.Id);

        await HttpContext.SignInAsync(
            Household.CookieScheme,
            Household.PrincipalFor(profile),
            new AuthenticationProperties
            {
                // Persistent only when asked. The distinction is the whole kiosk-versus-phone
                // difference, and it is the caller's to make because only the caller knows which
                // it is.
                IsPersistent = req.Remember,
                IssuedUtc = TimeProvider.System.GetUtcNow(),
            });

        _logger.LogInformation(
            "Signed in profile {ProfileId} ({Remember}).", profile.Id, req.Remember ? "persistent" : "session");

        return new SessionDto(profile.Id, profile.Name, profile.Role == ProfileRole.Admin, true);
    }

    /// <summary>Sign this device out. Idempotent.</summary>
    /// <remarks>
    /// Anonymous so that signing out of an already-expired session succeeds rather than 401-ing —
    /// a client trying to reach a signed-out state should never be told it cannot because it is
    /// already there.
    /// </remarks>
    // Not named SignOut: ControllerBase already has one, and hiding it would mean a later `return
    // SignOut()` inside this class silently called the wrong thing.
    [AllowAnonymous]
    [HttpDelete]
    public async Task<IActionResult> EndSession()
    {
        await HttpContext.SignOutAsync(Household.CookieScheme);
        return NoContent();
    }
}

/// <summary>Who the caller is, as the client sees it.</summary>
/// <param name="ProfileId">Null when nobody is signed in on this device.</param>
/// <param name="IsAdmin">
/// Whether the admin-only parts of Config should be offered. The client uses this to hide what it
/// cannot do; the server enforces it regardless, so a client that shows them anyway achieves
/// nothing but a 403.
/// </param>
public record SessionDto(int? ProfileId, string? Name, bool IsAdmin, bool SignedIn);

/// <param name="Pin">Required when the profile has one, ignored when it does not.</param>
/// <param name="Remember">
/// True for a device that should stay signed in across restarts — the wall panel. False for a
/// browser session that should end when the browser does.
/// </param>
public record SignInRequest(int ProfileId, string? Pin, bool Remember = false);

/// <param name="RetryAfterSeconds">
/// Set when the profile is in its lockout cooldown, so the PIN pad can show the wait rather than
/// letting the household keep trying against a door that will not open yet.
/// </param>
public record SignInFailure(string Message, int? RetryAfterSeconds);
