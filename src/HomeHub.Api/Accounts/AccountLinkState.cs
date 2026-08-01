namespace HomeHub.Api.Accounts;

using System.Collections.Concurrent;
using System.Security.Cryptography;

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
/// </remarks>
public sealed class AccountLinkState
{
    /// <summary>Long enough to sign in and consent; short enough that an abandoned flow dies.</summary>
    private static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(10);

    private readonly ConcurrentDictionary<string, Pending> _pending = new(StringComparer.Ordinal);
    private readonly TimeProvider _time;

    public AccountLinkState(TimeProvider time) => _time = time;

    private sealed record Pending(
        string Provider, int ProfileId, string RedirectUri, string? ReturnPath, DateTimeOffset ExpiresUtc);

    /// <summary>Begin a flow and return the opaque state to hand to the provider.</summary>
    /// <param name="returnPath">
    /// Where the panel should land afterwards, when the caller cares. Linking a *different* member
    /// than the signed-in one is started from that member's page, and dumping the household back on
    /// the active profile's calendar list would report the result against the wrong person. Null
    /// keeps the original per-provider destination. Carried in the pending state rather than the
    /// query string so a caller cannot aim the post-consent redirect by editing a URL.
    /// </param>
    public string Create(string provider, int profileId, string redirectUri, string? returnPath = null)
    {
        Prune();
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
        _pending[token] = new Pending(provider, profileId, redirectUri, returnPath, _time.GetUtcNow() + Lifetime);
        return token;
    }

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
    public (int ProfileId, string RedirectUri, string? ReturnPath)? Consume(string provider, string? token)
    {
        Prune();
        if (string.IsNullOrWhiteSpace(token)) return null;
        if (!_pending.TryGetValue(token, out var pending)) return null;
        if (pending.Provider != provider) return null;
        if (pending.ExpiresUtc < _time.GetUtcNow()) return null;
        // Only now is it ours to spend — and TryRemove is what makes it single-use, so a second
        // caller racing the same valid state loses here rather than both being honoured.
        if (!_pending.TryRemove(token, out _)) return null;
        return (pending.ProfileId, pending.RedirectUri, pending.ReturnPath);
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
