namespace HomeHub.Api.Auth;

using Microsoft.AspNetCore.Mvc;

/// <summary>
/// How a controller answers "whose data is this request about" (AUDIT A1.2).
/// </summary>
/// <remarks>
/// <para>
/// There are two different questions behind the <c>profileId</c> that used to be a query parameter
/// on fifteen endpoints, and conflating them is what made the old model a hole:
/// </para>
/// <list type="bullet">
/// <item>
/// <b>"my own data"</b> — my chats, my calendar, my tasks. <see cref="CallerId"/>. The caller has no
/// say in the answer; it is whatever the cookie was signed with. This is the case that was
/// exploitable, because the caller <i>did</i> have a say: changing a number in a URL read somebody
/// else's Assist history.
/// </item>
/// <item>
/// <b>"this member's settings"</b> — which agents Astrid may use, which of Elliot's calendars sync.
/// The id is a genuine argument here; the endpoint is about a named member, reached from a settings
/// screen that may be administering someone else. <see cref="MayActFor"/> is the check: it is mine,
/// or I am an administrator.
/// </item>
/// </list>
/// <para>
/// Keeping the second case as a parameter rather than forcing everything through the session is
/// deliberate. §11.1 of the audit says a rewrite should have "no endpoint ever accepts
/// <c>profileId</c> as an input" — but that is about the <i>authorisation</i> never coming from the
/// caller, which is what these two helpers guarantee. An endpoint whose whole purpose is to
/// configure another member has to be told which one.
/// </para>
/// </remarks>
public static class CallerScope
{
    /// <summary>The signed-in member's id, or null for a service token or anonymous caller.</summary>
    public static int? CallerId(this ControllerBase controller) => controller.User.ProfileId();

    /// <summary>
    /// Whether the caller may read or change <paramref name="profileId"/>'s settings.
    /// </summary>
    /// <remarks>
    /// Self-or-admin. A service token gets false: it has no <c>ProfileId</c>, so the first clause
    /// cannot match, and it holds no household role, so the second cannot either. The voice bridge
    /// has no business reconfiguring anyone's account.
    /// </remarks>
    public static bool MayActFor(this ControllerBase controller, int profileId) =>
        controller.User.ProfileId() == profileId || controller.User.IsHouseholdAdmin();
}
