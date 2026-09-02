namespace HomeHub.Api.Net;

using System.Net;
using System.Net.Sockets;

/// <summary>
/// How far a configured destination is allowed to reach.
/// </summary>
public enum EgressReach
{
    /// <summary>A third-party service on the internet. Every resolved address must be public.</summary>
    Internet,

    /// <summary>A sidecar or gateway on this machine or this house. Every resolved address must not be.</summary>
    Local,
}

/// <summary>
/// The policy for one class of outbound destination.
/// </summary>
/// <param name="Setting">The configuration key, so a refusal names what to fix.</param>
/// <param name="Reach">Which side of the house/internet line this destination must be on.</param>
/// <param name="AllowedHosts">
/// Exact hosts permitted. Empty means the reach check is the whole rule — which is right for a LAN
/// sidecar whose address a household chooses, and wrong for a credentialed third party, where the
/// host is the thing being authorised.
/// </param>
public sealed record EgressRule(
    string Setting,
    EgressReach Reach,
    IReadOnlyCollection<string> AllowedHosts);

/// <summary>
/// Where HomeHub is permitted to send household data and the credentials that reach it.
/// </summary>
/// <remarks>
/// <para>
/// <b>Every outbound destination in this app was an unvalidated string.</b> Cloud speech-to-text,
/// local speech-to-text, Google's token and calendar endpoints, Microsoft's token and Graph
/// endpoints, and each Hermes gateway: all of them took whatever configuration said and posted
/// household audio, calendar and task content, refresh tokens, client secrets and agent bearers to
/// it. A single mistyped or edited value moved any of those somewhere nobody chose, over a transport
/// nobody chose. `Ai:OpenAiBaseUrl` was fixed on its own first, which left four more of the same
/// thing — so this is the rule rather than another instance of it.
/// </para>
/// <para>
/// <b>Two checks, because one cannot cover both halves.</b> {@link Refuse} is a shape check: it runs
/// at startup and again where a request is built, and it answers "is this destination one somebody
/// authorised". {@link CreateHandler} is a dial-time check on the addresses actually connected to,
/// and it answers "is that still true of the machine we are about to talk to". The second exists
/// because the first cannot survive DNS: a name that answers correctly to a validator and differently
/// to the connection has defeated any amount of string checking.
/// </para>
/// <para>
/// <b>The connect-callback reasoning is `Meals/RecipeFetcher`'s and is deliberately the same
/// shape.</b> That class screens outward — a household-supplied recipe URL must not reach the LAN —
/// and this screens both ways from one rule. Resolving inside the callback and dialling the resolved
/// <see cref="IPAddress"/> values rather than the name is the whole of it: there is no second
/// resolution left to race.
/// </para>
/// <para>
/// <b>Redirects are off everywhere this is used.</b> A 307 or 308 preserves the method and the body,
/// so an allowed origin answering with one would retransmit the same household audio or the same
/// bearer to a host that never passed any check. With automatic redirects disabled the 3xx arrives as
/// an ordinary unsuccessful response and the caller's `EnsureSuccessStatusCode` ends the exchange
/// before a second request exists.
/// </para>
/// </remarks>
public static class EgressGuard
{
    /// <summary>
    /// Raised from a connect callback when the destination resolved somewhere the rule forbids.
    /// </summary>
    /// <remarks>
    /// A distinct type for the reason `RecipeFetcher` gives: the callback's only channel back is an
    /// exception, and <c>HttpClient</c> wraps whatever it throws, so without something recognisable
    /// "that address is not where this is allowed to go" and "that host is down" arrive identically.
    /// </remarks>
    public sealed class BlockedAddressException(string reason) : Exception(reason);

    /// <summary>
    /// The reason this destination may not be used, or null when it may.
    /// </summary>
    /// <remarks>
    /// A sentence rather than an exception, so a caller decides whether it is fatal and so it can be
    /// logged and tested without a stack trace. <b>It names the setting and the host and never a
    /// credential</b> — several of these URLs sit beside secrets, and one that echoed its input into
    /// a startup log would put them in the journal.
    /// </remarks>
    public static string? Refuse(string? url, EgressRule rule)
    {
        if (string.IsNullOrWhiteSpace(url))
            return $"{rule.Setting} is empty; there is no destination to authorise.";

        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
            return $"{rule.Setting} must be an absolute URL.";

        var local = rule.Reach == EgressReach.Local;

        if (uri.Scheme != Uri.UriSchemeHttps && !(local && uri.Scheme == Uri.UriSchemeHttp))
        {
            return local
                ? $"{rule.Setting} must use http or https; '{uri.Scheme}' is not a transport this speaks."
                : $"{rule.Setting} must use https; '{uri.Scheme}' would send household data and any "
                  + "credential with it in the clear.";
        }

        // Userinfo is a credential in a place nothing here expects one, and it is the classic way to
        // make a URL *read* as one host while resolving at another.
        if (!string.IsNullOrEmpty(uri.UserInfo))
            return $"{rule.Setting} must not carry userinfo.";

        if (!string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment))
            return $"{rule.Setting} must not carry a query string or fragment.";

        if (rule.AllowedHosts.Count > 0
            && !rule.AllowedHosts.Any(h => string.Equals(h, uri.Host, StringComparison.OrdinalIgnoreCase)))
        {
            return $"{rule.Setting} points at '{uri.Host}', which is not an allowed destination. Use "
                + "the provider's own host, or name this one explicitly in the matching AllowedHosts setting.";
        }

        /*
         * A literal address is classified here; a name is not, and cannot be.
         *
         * Resolving a hostname at startup would be a check the connection is free to disagree with —
         * see the class note. So the shape check screens what it can see for certain, and the reach of
         * a named host is settled at dial time by the handler below, once, against the addresses
         * actually being connected to.
         */
        if (IPAddress.TryParse(uri.Host.Trim('[', ']'), out var literal) && IsPrivate(literal) != local)
        {
            return local
                ? $"{rule.Setting} points at the public address {literal}; this destination must be on "
                  + "this machine or this house's own network."
                : $"{rule.Setting} points at {literal}, which is on this machine or this network. A "
                  + "third-party service reached at a private address is not that service.";
        }

        return null;
    }

    /// <summary>Whether this destination may be used.</summary>
    public static bool IsPermitted(string? url, EgressRule rule) => Refuse(url, rule) is null;

    /// <summary>
    /// A primary handler that follows no redirects and screens every address before it is dialled.
    /// </summary>
    /// <remarks>
    /// Reached once per new connection with the endpoint actually being dialled — including
    /// connections this app never sees because they came from the pool or a proxy.
    /// <c>ConnectAsync(IPAddress[], port)</c> rather than <c>ConnectAsync(host, port)</c> is the
    /// point: the second overload would resolve the name again and discard the screening.
    /// </remarks>
    public static SocketsHttpHandler CreateHandler(Func<EgressRule> rule) => new()
    {
        AllowAutoRedirect = false,
        ConnectCallback = async (context, ct) =>
        {
            var current = rule();
            var host = context.DnsEndPoint.Host;

            if (current.AllowedHosts.Count > 0
                && !current.AllowedHosts.Any(h => string.Equals(h, host, StringComparison.OrdinalIgnoreCase)))
            {
                throw new BlockedAddressException(
                    $"{current.Setting}: '{host}' is not an allowed destination.");
            }

            IPAddress[] addresses;
            try
            {
                addresses = IPAddress.TryParse(host, out var literal)
                    ? [literal]
                    : await Dns.GetHostAddressesAsync(host, ct);
            }
            catch (SocketException)
            {
                throw new BlockedAddressException($"{current.Setting}: '{host}' could not be found.");
            }

            if (addresses.Length == 0)
                throw new BlockedAddressException($"{current.Setting}: '{host}' could not be found.");

            /*
             * Every resolved address has to satisfy the rule, not merely one of them.
             *
             * A name answering both a public and a private address would otherwise pass and then be
             * connected to whichever the stack happened to prefer — a coin flip an attacker gets to
             * weight. The same reasoning `RecipeFetcher` gives for the outward direction.
             */
            var wantPrivate = current.Reach == EgressReach.Local;
            if (addresses.Any(a => IsPrivate(a) != wantPrivate))
            {
                throw new BlockedAddressException(wantPrivate
                    ? $"{current.Setting}: '{host}' resolves off this house's network."
                    : $"{current.Setting}: '{host}' resolves onto this machine or this network.");
            }

            var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
            try
            {
                await socket.ConnectAsync(addresses, context.DnsEndPoint.Port, ct);
                return new NetworkStream(socket, ownsSocket: true);
            }
            catch
            {
                socket.Dispose();
                throw;
            }
        },
    };

    /// <summary>
    /// Whether this address is on this machine or a network the household controls.
    /// </summary>
    /// <remarks>
    /// Loopback, RFC1918, RFC6598 carrier-grade NAT, link-local, and the IPv6 equivalents — unique
    /// local addresses and link-local — plus anything mapped from an IPv4 address in those ranges,
    /// because <c>::ffff:127.0.0.1</c> is loopback however it is spelled.
    /// </remarks>
    public static bool IsPrivate(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        if (IPAddress.IsLoopback(address)) return true;

        if (address.AddressFamily == AddressFamily.InterNetwork)
        {
            var b = address.GetAddressBytes();
            return b[0] switch
            {
                10 => true,
                127 => true,
                169 when b[1] == 254 => true,          // link-local
                172 when b[1] >= 16 && b[1] <= 31 => true,
                192 when b[1] == 168 => true,
                100 when b[1] >= 64 && b[1] <= 127 => true, // carrier-grade NAT
                0 => true,                              // "this network"
                _ => false,
            };
        }

        if (address.AddressFamily == AddressFamily.InterNetworkV6)
        {
            if (address.IsIPv6LinkLocal || address.IsIPv6SiteLocal) return true;
            // fc00::/7 — unique local addresses.
            return (address.GetAddressBytes()[0] & 0xFE) == 0xFC;
        }

        return false;
    }
}
