namespace HomeHub.Api.Accounts;

using System.Buffers.Text;
using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;

/// <summary>
/// Short-lived <c>state</c> values for the OAuth round trip.
/// </summary>
/// <remarks>
/// The <c>state</c> parameter has to do two jobs: carry which profile is linking, and prove the
/// callback belongs to a flow this panel actually started. Held in memory rather than signed,
/// because losing them on restart is the correct behaviour — a consent begun before a restart should
/// not complete after one, and a half-finished flow is retried by pressing the button again.
///
/// <para>Single-use and time-boxed: a state that has been consumed cannot be replayed, and one left
/// unfinished expires rather than lingering as a valid entry point.</para>
///
/// <para>
/// <b>It also holds the PKCE verifier</b> (AUDIT A3). This is a confidential client with a real
/// client secret, so PKCE is not covering the classic public-client hole — but the authorization
/// code travels back through the address bar of a browser on a <i>shared kiosk</i>, where it lands
/// in history and in anything watching the URL. Without a verifier, a code lifted from there is
/// redeemable by anyone who also has the client secret; with one, it is redeemable only by the flow
/// that started it. Both providers now recommend PKCE unconditionally, and the verifier costs one
/// field on a record that already exists.
/// </para>
/// <para>
/// Keeping it here, rather than in a cookie or the query string, is the point: the verifier is the
/// half of the pair that must never reach the browser. Only the S256 challenge does, and a challenge
/// cannot be turned back into its verifier.
/// </para>
/// </remarks>
public sealed class AccountLinkState
{
    /// <summary>Long enough to sign in and consent; short enough that an abandoned flow dies.</summary>
    private static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(10);

    private readonly ConcurrentDictionary<string, Pending> _pending = new(StringComparer.Ordinal);
    private readonly TimeProvider _time;

    public AccountLinkState(TimeProvider time) => _time = time;

    private sealed record Pending(
        string Provider,
        int ProfileId,
        string RedirectUri,
        string? ReturnPath,
        string CodeVerifier,
        DateTimeOffset ExpiresUtc);

    /// <summary>What a started flow needs to send to the provider.</summary>
    /// <param name="State">The opaque single-use value proving the callback belongs to this flow.</param>
    /// <param name="CodeChallenge">
    /// The S256 PKCE challenge (AUDIT A3). Its verifier stays here and never touches the browser.
    /// </param>
    public readonly record struct StartedFlow(string State, string CodeChallenge);

    /// <summary>Begin a flow and return what the consent URL needs.</summary>
    /// <param name="returnPath">
    /// Where the panel should land afterwards, when the caller cares. Linking a *different* member
    /// than the signed-in one is started from that member's page, and dumping the household back on
    /// the active profile's calendar list would report the result against the wrong person. Null
    /// keeps the original per-provider destination. Carried in the pending state rather than the
    /// query string so a caller cannot aim the post-consent redirect by editing a URL.
    /// </param>
    public StartedFlow Create(string provider, int profileId, string redirectUri, string? returnPath = null)
    {
        Prune();
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(16));

        // PKCE, RFC 7636 (AUDIT A3). 32 random bytes base64url-encode to 43 characters, which is the
        // spec's minimum verifier length and its recommended entropy in one step.
        var verifier = Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32));

        _pending[token] = new Pending(
            provider, profileId, redirectUri, returnPath, verifier, _time.GetUtcNow() + Lifetime);

        return new StartedFlow(token, Challenge(verifier));
    }

    /// <summary>The S256 code challenge for a verifier: BASE64URL(SHA256(ASCII(verifier))).</summary>
    /// <remarks>
    /// S256 rather than the <c>plain</c> method the RFC also allows. <c>plain</c> sends the verifier
    /// itself as the challenge, which means anything that can read the authorization request can
    /// replay it — the exact exposure PKCE exists to remove, so it buys nothing.
    /// </remarks>
    private static string Challenge(string verifier) =>
        Base64Url.EncodeToString(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));

    /// <summary>
    /// Redeem a state exactly once. Null when it is unknown, expired, already used, or belongs to a
    /// different provider than the callback that presented it.
    /// </summary>
    /// <remarks>
    /// Peeks before removing. Removing first would let a callback for the *wrong* provider destroy a
    /// live flow: a request to <c>/api/link/microsoft/callback</c> carrying a state minted for Google
    /// would be refused — correctly — but the Google flow would already be gone, so Google's real
    /// callback moments later would find nothing and the household would land on "expired" after
    /// having already consented. The state travels through the kiosk's address bar, so it is not a
    /// secret and this is reachable without any special access.
    /// </remarks>
    public (int ProfileId, string RedirectUri, string? ReturnPath, string CodeVerifier)? Consume(
        string provider, string? token)
    {
        Prune();
        if (string.IsNullOrWhiteSpace(token)) return null;
        if (!_pending.TryGetValue(token, out var pending)) return null;
        if (pending.Provider != provider) return null;
        if (pending.ExpiresUtc < _time.GetUtcNow()) return null;
        // Only now is it ours to spend — and TryRemove is what makes it single-use, so a second
        // caller racing the same valid state loses here rather than both being honoured.
        if (!_pending.TryRemove(token, out _)) return null;
        return (pending.ProfileId, pending.RedirectUri, pending.ReturnPath, pending.CodeVerifier);
    }

    private void Prune()
    {
        var now = _time.GetUtcNow();
        foreach (var (key, value) in _pending)
        {
            if (value.ExpiresUtc < now) _pending.TryRemove(key, out _);
        }
    }
}
