namespace HomeHub.Api.Net;

/// <summary>
/// The names of the guarded <see cref="HttpClient"/> registrations, so a caller cannot ask for the
/// wrong one by mistyping a string.
/// </summary>
/// <remarks>
/// <b>These exist because the unnamed default client was a hole with no edges.</b>
/// <c>IHttpClientFactory.CreateClient()</c> hands back a client with the framework's default handler:
/// no address screen, and automatic redirects on. Any caller that reached for it inherited neither
/// half of the egress policy, silently, and the account-link token exchange did exactly that — posting
/// an OAuth client secret and PKCE verifier through it while the background providers beside it were
/// guarded. A named client is a thing a caller has to choose, and choosing wrongly is visible.
/// </remarks>
public static class GuardedClients
{
    /// <summary>Google's OAuth and calendar endpoints.</summary>
    public const string Google = "guarded-google";

    /// <summary>Microsoft's OAuth and Graph endpoints, shared with the grocery mirror.</summary>
    public const string Microsoft = "guarded-microsoft";

    /// <summary>
    /// A placeholder registration so that <c>IHttpClientFactory</c> is available without the unnamed
    /// default being.
    /// </summary>
    /// <remarks>
    /// `AddHttpClient()` registers the factory <i>and</i> a default client that `CreateClient()` with
    /// no name returns — configured with nothing. Naming this one keeps the factory available to
    /// injection while leaving the unnamed slot empty, so a caller that reaches for the default gets
    /// an unconfigured client rather than an unguarded one that works.
    /// </remarks>
    public const string Unconfigured = "unconfigured";
}
