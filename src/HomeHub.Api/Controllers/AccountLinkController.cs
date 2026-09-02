namespace HomeHub.Api.Controllers;

using System.Net.Http.Json;
using System.Text.Json.Serialization;
using HomeHub.Api.Net;
using HomeHub.Api.Accounts;
using HomeHub.Api.Auth;
using HomeHub.Api.Calendar;
using HomeHub.Api.Data;
using HomeHub.Api.Tasks;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

/// <summary>
/// Linking a household member's Google or Microsoft account, from the panel.
/// </summary>
/// <remarks>
/// Replaces a procedure that ran through the OAuth Playground and a hand-written SQL INSERT — which
/// worked, but meant a token expiring on a Tuesday needed a laptop and the README to fix. Both
/// providers use the same authorisation-code flow, so both live here rather than being spread across
/// the calendar and task controllers.
///
/// <para>Refresh tokens never reach the browser: the code is exchanged server-side and only the
/// resulting link is stored.</para>
/// </remarks>
[ApiController]
[Route("api/link")]
public class AccountLinkController : ControllerBase
{
    private const string Google = "google";
    private const string Microsoft = "microsoft";

    private readonly AccountLinkState _state;
    private readonly HomeHubDbContext? _db;
    private readonly GoogleCalendarOptions _google;
    private readonly MicrosoftTodoOptions _microsoft;
    private readonly IHttpClientFactory _http;
    private readonly ILogger<AccountLinkController> _logger;

    public AccountLinkController(
        AccountLinkState state,
        IOptions<GoogleCalendarOptions> google,
        IOptions<MicrosoftTodoOptions> microsoft,
        IHttpClientFactory http,
        ILogger<AccountLinkController> logger,
        IServiceProvider services)
    {
        _state = state;
        _google = google.Value;
        _microsoft = microsoft.Value;
        _http = http;
        _logger = logger;
        _db = services.GetService<HomeHubDbContext>();
    }

    /// <summary>Which providers can be linked, and whether this member is linked already.</summary>
    /// <remarks>Self-or-admin (AUDIT A1.4) — it reports on a named member's cloud accounts.</remarks>
    [HttpGet("status")]
    public async Task<ActionResult<IReadOnlyList<LinkStatusDto>>> Status([FromQuery] int profileId, CancellationToken ct)
    {
        if (!this.MayActFor(profileId)) return Forbid();
        if (_db is null) return Ok(Array.Empty<LinkStatusDto>());
        return Ok(new[]
        {
            new LinkStatusDto(
                Google,
                _google.IsConfigured,
                await _db.GoogleAccountLinks.AnyAsync(l => l.ProfileId == profileId, ct),
                RedirectUriFor(Google)!),
            new LinkStatusDto(
                Microsoft,
                _microsoft.IsConfigured,
                await _db.MicrosoftAccountLinks.AnyAsync(l => l.ProfileId == profileId, ct),
                RedirectUriFor(Microsoft)!),
        });
    }

    /// <summary>
    /// Start linking: returns the provider's consent URL for the panel to navigate to.
    /// </summary>
    /// <remarks>
    /// A URL rather than a redirect, so the caller decides how to travel — the kiosk replaces its own
    /// location, while a phone or laptop can open the same link in a tab.
    /// </remarks>
    [HttpPost("{provider}/start")]
    public ActionResult<LinkStartDto> Start(string provider, [FromQuery] int profileId, [FromQuery] string? returnPath)
    {
        // Self-or-admin. This mints the state the anonymous callback later redeems, so it is the
        // only place the profile a link gets stored against is chosen — which makes it the place
        // the check has to be.
        if (!this.MayActFor(profileId)) return Forbid();
        if (profileId <= 0) return BadRequest("A profile is required.");
        if (returnPath is not null && !IsSafeReturnPath(returnPath))
            return BadRequest("returnPath must be a relative path under /settings/.");

        var redirectUri = RedirectUriFor(provider);
        if (redirectUri is null) return BadRequest($"Unknown provider '{provider}'.");

        var (authorizeUrl, clientId, scope, configured) = provider switch
        {
            Google => (_google.AuthorizeUrl, _google.ClientId, _google.Scope, _google.IsConfigured),
            Microsoft => (_microsoft.AuthorizeUrl, _microsoft.ClientId, _microsoft.AuthorizeScope, _microsoft.IsConfigured),
            _ => (null!, null, null!, false),
        };
        if (!configured)
            return StatusCode(StatusCodes.Status501NotImplemented,
                $"{provider} is not configured on this panel — its client id and secret are missing.");

        var flow = _state.Create(provider, profileId, redirectUri, returnPath);

        // `offline` + `consent` are what actually produce a *refresh* token. Without the forced
        // prompt a re-link of an already-consented account returns an access token only, and the
        // stored link would still be the dead one.
        var query = new Dictionary<string, string?>
        {
            ["client_id"] = clientId,
            ["response_type"] = "code",
            ["redirect_uri"] = redirectUri,
            ["scope"] = scope,
            ["state"] = flow.State,
            ["access_type"] = "offline",
            ["prompt"] = "consent",
            // PKCE (AUDIT A3). Only the challenge goes out; its verifier stays in AccountLinkState
            // and is sent directly to the token endpoint at exchange, never through the browser.
            ["code_challenge"] = flow.CodeChallenge,
            ["code_challenge_method"] = "S256",
        };
        var url = QueryHelpers.AddQueryString(authorizeUrl, query);
        return Ok(new LinkStartDto(url, redirectUri));
    }

    /// <summary>Where the provider returns to. Exchanges the code and stores the link.</summary>
    /// <remarks>
    /// <b>Anonymous, necessarily, and safe because of the state.</b> Google and Microsoft redirect
    /// the browser here; they do not present a session cookie, and a <c>SameSite=Strict</c> cookie
    /// is withheld on a cross-site navigation anyway, so requiring auth would fail every real
    /// callback. What authorises this request is the <c>state</c> it carries: single-use, ten-minute,
    /// provider-bound, minted by an authenticated <c>start</c>, and — since AUDIT A3 — paired with a
    /// PKCE verifier the browser never sees. The profile the link is stored against comes out of
    /// that state, never out of the query string.
    /// </remarks>
    [AllowAnonymous]
    [HttpGet("{provider}/callback")]
    public async Task<IActionResult> Callback(
        string provider,
        [FromQuery] string? code,
        [FromQuery] string? state,
        [FromQuery] string? error,
        CancellationToken ct)
    {
        var pending = _state.Consume(provider, state);
        // An expired/unknown state carries no return path, so this one falls back to the default.
        if (pending is null) return Redirect(Done(provider, "expired", null));
        var back = pending.Value.ReturnPath;
        // The household declined, or the provider refused. Their word for it is not ours to keep.
        if (!string.IsNullOrEmpty(error) || string.IsNullOrEmpty(code))
            return Redirect(Done(provider, "denied", back));
        if (_db is null) return Redirect(Done(provider, "nodb", back));

        try
        {
            var refreshToken = await ExchangeAsync(
                provider, code, pending.Value.RedirectUri, pending.Value.CodeVerifier, ct);
            if (refreshToken is null)
            {
                // A consent that returns no refresh token leaves the panel able to read for an hour
                // and then silently stop — worse than not linking at all, so it is a failure.
                _logger.LogWarning("{Provider} returned no refresh token for profile {Profile}.", provider, pending.Value.ProfileId);
                return Redirect(Done(provider, "norefresh", back));
            }

            await SaveLinkAsync(provider, pending.Value.ProfileId, refreshToken, ct);
            return Redirect(Done(provider, "ok", back));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Linking {Provider} for profile {Profile} failed.", provider, pending.Value.ProfileId);
            return Redirect(Done(provider, "failed", back));
        }
    }

    /// <summary>Forget a link. The cached events stay until the next sync prunes them.</summary>
    /// <remarks>
    /// Self-or-admin (AUDIT A1.4). Unauthenticated, this let anything on the LAN disconnect any
    /// household member's real Google or Microsoft account — a denial of service that looks, to the
    /// person it happens to, like their account silently breaking.
    /// </remarks>
    [HttpDelete("{provider}")]
    public async Task<IActionResult> Unlink(string provider, [FromQuery] int profileId, CancellationToken ct)
    {
        if (!this.MayActFor(profileId)) return Forbid();
        if (_db is null) return NoContent();

        if (provider == Google)
        {
            var link = await _db.GoogleAccountLinks.FindAsync([profileId], ct);
            if (link is not null) _db.GoogleAccountLinks.Remove(link);
            GoogleCalendarProvider.ForgetToken(profileId);
        }
        else if (provider == Microsoft)
        {
            var link = await _db.MicrosoftAccountLinks.FindAsync([profileId], ct);
            if (link is not null) _db.MicrosoftAccountLinks.Remove(link);
            MicrosoftTodoProvider.ForgetToken(profileId);
        }
        else return BadRequest($"Unknown provider '{provider}'.");

        await _db.SaveChangesAsync(ct);
        return NoContent();
    }

    // ---- internals ----

    /// <summary>
    /// The callback address, from config or derived from this request.
    /// </summary>
    /// <remarks>
    /// Derived by default because the panel's kiosk browser and this API share a host: whatever
    /// address the panel is already using is the one the provider can return to. It must match the
    /// registered URI verbatim, so it is also handed back to the caller by <c>start</c> — the panel
    /// can show it when a provider rejects it.
    /// </remarks>
    private string? RedirectUriFor(string provider)
    {
        var configured = provider switch
        {
            Google => _google.RedirectUri,
            Microsoft => _microsoft.RedirectUri,
            _ => null,
        };
        if (provider is not (Google or Microsoft)) return null;
        if (!string.IsNullOrWhiteSpace(configured)) return configured;
        return $"{Request.Scheme}://{Request.Host}/api/link/{provider}/callback";
    }

    /// <summary>
    /// Where to land after consent, with the outcome attached so the panel can say what happened.
    /// <paramref name="returnPath"/> wins when the caller supplied one — linking a member other than
    /// the signed-in one starts from that member's page and has to report back there. Otherwise the
    /// per-provider default, which is the screen that owns that provider's settings.
    /// </summary>
    private static string Done(string provider, string result, string? returnPath)
    {
        var target = returnPath ?? $"/settings/{(provider == Google ? "calendars" : "lists")}";
        var separator = target.Contains('?') ? '&' : '?';
        return $"{target}{separator}link={provider}&result={result}";
    }

    /// <summary>
    /// Only same-origin paths under <c>/settings/</c>. The return path steers a redirect issued after
    /// a successful token exchange, so an unchecked value would be an open redirect that borrows the
    /// panel's credibility — and rejecting <c>//</c> matters because a protocol-relative URL starts
    /// with a slash and still leaves the origin.
    /// </summary>
    private static bool IsSafeReturnPath(string path) =>
        path.StartsWith("/settings/", StringComparison.Ordinal)
        && !path.Contains("//", StringComparison.Ordinal)
        && !path.Contains('\\', StringComparison.Ordinal)
        // `..` climbs back out: "/settings/../../etc" satisfies the prefix and still leaves the
        // section. Rejected outright rather than normalised, because there is no legitimate reason
        // for a return path to contain one.
        && !path.Contains("..", StringComparison.Ordinal);

    private async Task<string?> ExchangeAsync(
        string provider, string code, string redirectUri, string codeVerifier, CancellationToken ct)
    {
        var (tokenUrl, clientId, clientSecret, rule, client) = provider == Google
            ? (_google.TokenUrl, _google.ClientId, _google.ClientSecret,
               _google.Rule with { Setting = "Google:TokenUrl" }, GuardedClients.Google)
            : (_microsoft.TokenUrl, _microsoft.ClientId, _microsoft.ClientSecret,
               _microsoft.Rule with { Setting = "Microsoft:TokenUrl" }, GuardedClients.Microsoft);

        /*
         * The destination is checked here, and the client that carries it is a guarded one.
         *
         * <b>This exchange was missed when the providers were guarded, and it is the worst one to
         * miss.</b> The background providers send a bearer and household content; this sends the OAuth
         * client secret, the authorization code and the PKCE verifier — the whole of what it takes to
         * mint tokens for a member's account — in a single form POST. It was built on the unnamed
         * default `HttpClient`, which has no address screen and follows redirects, so a 307 from an
         * approved token endpoint would have re-posted that form to wherever it pointed.
         */
        if (EgressGuard.Refuse(tokenUrl, rule) is { } refusal)
        {
            _logger.LogError("{Provider} token exchange refused: {Refusal}", provider, refusal);
            return null;
        }

        var form = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["client_id"] = clientId!,
            ["client_secret"] = clientSecret!,
            ["code"] = code,
            ["grant_type"] = "authorization_code",
            ["redirect_uri"] = redirectUri,
            // The other half of the PKCE pair (AUDIT A3). This is a back-channel POST from the
            // server to the provider, so the verifier never travels anywhere the code did — which
            // is the entire mechanism: holding the code is no longer enough to redeem it.
            ["code_verifier"] = codeVerifier,
        });

        using var http = _http.CreateClient(client);
        using var res = await http.PostAsync(tokenUrl, form, ct);
        if (!res.IsSuccessStatusCode)
        {
            var body = await res.Content.ReadAsStringAsync(ct);
            if (body.Length > 500) body = body[..500];
            _logger.LogWarning("{Provider} token exchange failed: {Status} — {Body}", provider, (int)res.StatusCode, body);
            return null;
        }

        var token = await res.Content.ReadFromJsonAsync<TokenResponse>(ct);
        return string.IsNullOrWhiteSpace(token?.RefreshToken) ? null : token.RefreshToken;
    }

    private async Task SaveLinkAsync(string provider, int profileId, string refreshToken, CancellationToken ct)
    {
        if (provider == Google)
        {
            var link = await _db!.GoogleAccountLinks.FindAsync([profileId], ct);
            if (link is null)
                _db.GoogleAccountLinks.Add(new GoogleAccountLink { ProfileId = profileId, RefreshToken = refreshToken });
            // Re-linking replaces the token and keeps the member's calendar choices — they did not
            // ask to reset which calendars display, only to sign in again.
            else link.RefreshToken = refreshToken;
            GoogleCalendarProvider.ForgetToken(profileId);
        }
        else
        {
            var link = await _db!.MicrosoftAccountLinks.FindAsync([profileId], ct);
            if (link is null)
                _db.MicrosoftAccountLinks.Add(new MicrosoftAccountLink { ProfileId = profileId, RefreshToken = refreshToken });
            else link.RefreshToken = refreshToken;
            MicrosoftTodoProvider.ForgetToken(profileId);
        }

        await _db!.SaveChangesAsync(ct);
        _logger.LogInformation("Linked {Provider} for profile {Profile}.", provider, profileId);
    }

    private sealed record TokenResponse(
        [property: JsonPropertyName("refresh_token")] string? RefreshToken,
        [property: JsonPropertyName("access_token")] string? AccessToken);
}

/// <summary>
/// Whether a provider can be linked here, and whether this profile already is.
/// </summary>
/// <param name="RedirectUri">
/// The callback this panel will send. Reported before linking rather than after, because the way it
/// fails is a provider-side error page that never returns here — so the panel would otherwise have no
/// chance to say which string was rejected.
/// </param>
public sealed record LinkStatusDto(string Provider, bool Configured, bool Linked, string RedirectUri);

/// <summary>
/// Where to send the household to consent, and the callback that was used — returned so the panel
/// can show the exact string to register when a provider rejects it.
/// </summary>
public sealed record LinkStartDto(string Url, string RedirectUri);
