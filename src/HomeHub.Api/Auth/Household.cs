namespace HomeHub.Api.Auth;

using System.Security.Claims;
using HomeHub.Api.Profiles;

/// <summary>
/// The names the authentication boundary is built out of, in one place.
/// </summary>
/// <remarks>
/// Strings that have to agree across a scheme registration, a handler, a policy and a controller
/// attribute are exactly the strings that get mistyped, and a mistyped scheme name fails as
/// "anonymous" rather than as an error — which is the wrong direction to fail in for anything
/// carrying the word auth.
/// </remarks>
public static class Household
{
    /// <summary>The panel/phone session cookie scheme.</summary>
    public const string CookieScheme = "HomeHub.Session";

    /// <summary>The bearer scheme for machine callers — today, the voice bridge.</summary>
    public const string ServiceScheme = "HomeHub.Service";

    /// <summary>The cookie's name on the wire.</summary>
    public const string CookieName = "homehub.session";

    /// <summary>Requires a household administrator. See <see cref="HouseholdAdminRequirement"/>.</summary>
    public const string AdminPolicy = "HouseholdAdmin";

    /// <summary>Allows a household session or the specifically named Pi voice bridge.</summary>
    public const string VoiceBridgePolicy = "VoiceBridge";

    /// <summary>Marks a caller as a service rather than a person.</summary>
    public const string ServiceRole = "Service";

    /// <summary>The service credential's name, for logging and per-caller scoping.</summary>
    public const string ServiceNameClaim = "homehub:service";

    /// <summary>
    /// The signed-in member's id, or null when the caller is a service or anonymous.
    /// </summary>
    /// <remarks>
    /// <b>This replaces <c>?profileId=</c> as the answer to "whose data is this".</b> That query
    /// parameter <i>was</i> the authorisation model — anything on the LAN could read any member's
    /// Assist history by changing a number in a URL. Reading it from the principal means the answer
    /// is whatever the cookie was signed with, which the caller cannot edit.
    /// <para>
    /// Returns null rather than throwing so a caller can distinguish "nobody is signed in" from
    /// "signed in as 0". Endpoints that need a member say so themselves — see
    /// <c>ControllerBase.RequireProfileId</c>.
    /// </para>
    /// </remarks>
    public static int? ProfileId(this ClaimsPrincipal? user)
    {
        var raw = user?.FindFirstValue(ClaimTypes.NameIdentifier);
        return int.TryParse(raw, out var id) && id > 0 ? id : null;
    }

    /// <summary>The signed-in member's display name, when there is one.</summary>
    public static string? ProfileName(this ClaimsPrincipal? user) => user?.FindFirstValue(ClaimTypes.Name);

    /// <summary>Whether this caller holds the household administrator role.</summary>
    public static bool IsHouseholdAdmin(this ClaimsPrincipal? user) =>
        user?.IsInRole(nameof(ProfileRole.Admin)) == true;

    /// <summary>Whether this caller is a machine credential rather than a household member.</summary>
    public static bool IsService(this ClaimsPrincipal? user) => user?.IsInRole(ServiceRole) == true;

    /// <summary>The claim carrying <see cref="Profile.SecurityVersion"/> as minted.</summary>
    public const string SecurityVersionClaim = "homehub:sv";

    /// <summary>The claims a signed-in member carries.</summary>
    /// <remarks>
    /// <b>The role still travels in the cookie, and is now checked against the database on every
    /// request.</b> The comment that used to sit here accepted delayed demotion as the price of not
    /// doing a Profiles lookup per request — "acceptable here, where admin governs household settings
    /// rather than anything dangerous". It was not: the same claims authorise deleting profiles and
    /// editing roles, so a demoted administrator could keep both for the cookie's 400-day sliding
    /// life, and so could anyone holding a copy of that cookie.
    ///
    /// The lookup that was being avoided is a single indexed read of one small table on a household
    /// LAN, against a local database. Hermes ruled explicitly for strict per-request validation over
    /// a cached interval: role change, PIN change, deletion and forced sign-out are revocation
    /// operations, and a deliberate stale-authority window is not wanted at any width.
    /// </remarks>
    public static ClaimsPrincipal PrincipalFor(Profile profile) =>
        new(new ClaimsIdentity(
            [
                new Claim(ClaimTypes.NameIdentifier, profile.Id.ToString(System.Globalization.CultureInfo.InvariantCulture)),
                new Claim(ClaimTypes.Name, profile.Name),
                new Claim(ClaimTypes.Role, profile.Role.ToString()),
                // What makes the three above revocable. Compared per request; a mismatch, or a
                // profile that no longer exists, rejects the cookie.
                new Claim(SecurityVersionClaim, profile.SecurityVersion.ToString(System.Globalization.CultureInfo.InvariantCulture)),
            ],
            CookieScheme));
}
