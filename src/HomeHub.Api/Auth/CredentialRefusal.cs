namespace HomeHub.Api.Auth;

using Microsoft.AspNetCore.Mvc;

/// <summary>
/// Marks the 401s that are about a credential rather than about a session.
/// </summary>
/// <remarks>
/// <para>
/// <b>Both are 401 and they mean opposite things, so the server has to say which.</b> A mistyped PIN
/// and an expired cookie arrive at the panel as the same status, and the panel has to do opposite
/// things about them: show "that PIN is not right" and stay where it is, or lock and drop to the
/// picker because there is no session behind the screens it is drawing.
/// </para>
/// <para>
/// <b>The client used to guess, by path and method, and the guess was wrong in one direction.</b>
/// <c>PUT</c> and <c>DELETE</c> on <c>/profiles/{id}/pin</c> were excused wholesale on the reasoning
/// that a 401 from them is a wrong PIN. That is true of one of the two ways they answer 401 and false
/// of the other: a member changing their PIN on a panel whose cookie has expired is refused for the
/// session, and the excuse meant nothing noticed. The panel stayed unlocked over the household's
/// private screens with no session behind them.
/// </para>
/// <para>
/// A path cannot tell those apart. Only the endpoint knows which of its own refusals it just made, so
/// it marks the one that is about the credential and the client reads the mark — treating an unmarked
/// 401 as a lost session, which is the fail-closed direction.
/// </para>
/// <para>
/// A header rather than a body field: the client must be able to decide before, and independently of,
/// reading a body, because not every authenticated transport reads one — the Assist cancel is a
/// fire-and-forget <c>POST</c>, and the durable write queue classifies by status.
/// </para>
/// </remarks>
public static class CredentialRefusal
{
    /// <summary>The header name, matched by <c>client/src/api/privateNetwork.ts</c>.</summary>
    public const string HeaderName = "HomeHub-Auth";

    /// <summary>Its only meaningful value. Anything else is not a mark.</summary>
    public const string HeaderValue = "credential-rejected";

    /// <summary>
    /// A 401 that refuses the credential offered, not the session that carried it.
    /// </summary>
    /// <remarks>
    /// Every credential refusal in the app goes through here, so the mark cannot be forgotten at one
    /// of them — which is the failure mode the path-based guess it replaces already had.
    /// </remarks>
    /// <returns>
    /// An <see cref="ActionResult"/> rather than an <see cref="IActionResult"/>, so it converts
    /// implicitly into the <c>ActionResult&lt;T&gt;</c> the typed endpoints return.
    /// </returns>
    public static ActionResult CredentialRejected(this ControllerBase controller, object? body = null)
    {
        controller.Response.Headers[HeaderName] = HeaderValue;
        return body is null ? controller.Unauthorized() : controller.Unauthorized(body);
    }
}
