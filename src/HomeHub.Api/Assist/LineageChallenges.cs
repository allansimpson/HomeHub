namespace HomeHub.Api.Assist;

using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;

/// <summary>
/// The opaque, expiring token that says an administrator read a particular lineage report.
/// </summary>
/// <remarks>
/// <para>
/// <b>Protected rather than stored, and opaque rather than reconstructible.</b> The previous
/// confirmation was the list of unresolved session ids, which a caller could produce without ever
/// having read anything — and which is *empty* when the agent cannot be read, so the case with the
/// most to accept was the one that proved the least. A challenge cannot be constructed by a caller: it
/// is a Data Protection payload, so it carries its own integrity, and its contents are a digest of the
/// exact report it was issued from.
/// </para>
/// <para>
/// No table, because there is nothing to look up — the token carries what it asserts and the signature
/// is what makes that trustworthy. What <i>is</i> stored is the acceptance
/// (<see cref="LineageRiskAcceptance"/>), keyed by the nonce, which is how single use is enforced: a
/// replayed challenge finds its own nonce already spent.
/// </para>
/// <para>
/// <b>Short-lived on purpose.</b> The window is the time between reading a report and acting on it —
/// minutes, by hand, at a panel. Anything longer starts to mean "somebody read a report at some point",
/// which is the property that failed the first time.
/// </para>
/// </remarks>
public sealed class LineageChallenges
{
    /// <summary>How long a challenge may be presented for. Long enough to read and decide.</summary>
    public static readonly TimeSpan ChallengeLifetime = TimeSpan.FromMinutes(15);

    /// <summary>
    /// How long an acceptance may then authorise a deletion for.
    /// </summary>
    /// <remarks>
    /// Deliberately short and separate from the challenge's own life: this is the gap between
    /// authorising and deleting, not between reading and authorising. An authorisation nobody used is
    /// not one that keeps — the report it was granted against goes stale whether or not anybody acts.
    /// </remarks>
    public static readonly TimeSpan AcceptanceLifetime = TimeSpan.FromMinutes(15);

    private readonly IDataProtector _protector;

    public LineageChallenges(IDataProtectionProvider provider) =>
        _protector = provider.CreateProtector("HomeHub.Assist.LineageChallenge.v1");

    /// <summary>Issue a challenge for this report fingerprint.</summary>
    public string Issue(string digest)
    {
        var payload = new Payload(
            digest,
            Convert.ToHexString(RandomNumberGenerator.GetBytes(16)),
            DateTime.UtcNow.Add(ChallengeLifetime));

        return _protector.Protect(JsonSerializer.Serialize(payload));
    }

    /// <summary>Read a challenge back, or null when it is not one this panel issued.</summary>
    /// <remarks>
    /// Null covers forged, corrupted, truncated and foreign-keyring tokens alike, because the caller's
    /// response to all of them is the same and telling them apart would only describe the failure to
    /// whoever produced it.
    /// </remarks>
    public Payload? Open(string challenge)
    {
        try
        {
            return JsonSerializer.Deserialize<Payload>(_protector.Unprotect(challenge));
        }
        catch
        {
            return null;
        }
    }

    /// <param name="Digest">The report fingerprint this was issued against.</param>
    /// <param name="Nonce">Unique per issue; what makes an acceptance single-use.</param>
    /// <param name="ExpiresAtUtc">When it stops being presentable.</param>
    public sealed record Payload(string Digest, string Nonce, DateTime ExpiresAtUtc);
}
