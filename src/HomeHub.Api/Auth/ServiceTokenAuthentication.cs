namespace HomeHub.Api.Auth;

using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

/// <summary>
/// Bearer credentials for callers that are programs rather than people.
/// </summary>
/// <remarks>
/// <para>
/// The voice bridge is the reason this exists (AUDIT A1). It calls the API server-to-server from a
/// Python process with no browser, so it has nowhere to keep a session cookie and would take a 401
/// on every request the moment <c>[Authorize]</c> became the default. The two alternatives were
/// worse: giving a headless daemon a household member's identity blurs who did what in the ledger,
/// and exempting an address range re-creates the trust-the-network model this whole tranche exists
/// to remove.
/// </para>
/// <para>
/// Shaped after <c>Mcp/McpOptions</c>, which AUDIT calls the one real authorisation model in the
/// app — named credentials rather than one shared key, so revoking the bridge does not revoke
/// anything else, and the log can say which caller did what.
/// </para>
/// <para>
/// <b>No token configured means no service callers.</b> The scheme stays registered but authorises
/// nobody, so a deployment that never sets one is closed rather than open.
/// </para>
/// </remarks>
public sealed class ServiceTokenOptions : AuthenticationSchemeOptions
{
    public const string Section = "Auth:ServiceTokens";

    /// <summary>Credential name (<c>voice-bridge</c>) to bearer token.</summary>
    public Dictionary<string, string> Tokens { get; set; } = new(StringComparer.OrdinalIgnoreCase);
}

/// <inheritdoc cref="ServiceTokenOptions" />
public sealed class ServiceTokenAuthenticationHandler : AuthenticationHandler<ServiceTokenOptions>
{
    public ServiceTokenAuthenticationHandler(
        IOptionsMonitor<ServiceTokenOptions> options, ILoggerFactory logger, UrlEncoder encoder)
        : base(options, logger, encoder)
    {
    }

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var header = Request.Headers.Authorization.ToString();
        if (!header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
            // NoResult, not Fail: a browser request carrying only a cookie is not a *failed* service
            // authentication, it is a request for a different scheme. Failing here would turn every
            // ordinary panel request into a logged authentication error.
            return Task.FromResult(AuthenticateResult.NoResult());

        var presented = header["Bearer ".Length..].Trim();
        if (presented.Length == 0) return Task.FromResult(AuthenticateResult.NoResult());

        var name = Match(presented);
        if (name is null) return Task.FromResult(AuthenticateResult.Fail("Unknown service token."));

        var principal = new ClaimsPrincipal(new ClaimsIdentity(
            [
                new Claim(ClaimTypes.Name, name),
                new Claim(Household.ServiceNameClaim, name),
                // Deliberately NOT a NameIdentifier. A service has no ProfileId, so anything that
                // needs a member — Assist history, someone's calendar — refuses it rather than
                // silently reading whichever profile happened to be first.
                new Claim(ClaimTypes.Role, Household.ServiceRole),
            ],
            Household.ServiceScheme));

        return Task.FromResult(AuthenticateResult.Success(
            new AuthenticationTicket(principal, Household.ServiceScheme)));
    }

    /// <summary>The credential name for this token, or null when it matches none.</summary>
    /// <remarks>
    /// Every configured token is compared, with no early exit, and the comparison is
    /// <see cref="CryptographicOperations.FixedTimeEquals(ReadOnlySpan{byte}, ReadOnlySpan{byte})"/>.
    /// A short-circuiting <c>==</c> over a dictionary leaks both which prefix was right and how many
    /// credentials exist, through timing — cheap to avoid, and this is a token that grants writes to
    /// the house.
    /// </remarks>
    private string? Match(string presented)
    {
        var presentedBytes = Encoding.UTF8.GetBytes(presented);
        string? matched = null;

        foreach (var (name, token) in Options.Tokens)
        {
            if (string.IsNullOrWhiteSpace(token)) continue;
            if (CryptographicOperations.FixedTimeEquals(presentedBytes, Encoding.UTF8.GetBytes(token)))
                matched = name;
        }

        return matched;
    }
}
