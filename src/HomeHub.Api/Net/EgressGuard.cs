namespace HomeHub.Api.Net;

using System.Net;
using System.Net.Sockets;

/// <summary>
/// How far a configured destination is allowed to reach.
/// </summary>
public enum EgressReach
{
    /// <summary>A third-party service on the internet. Every resolved address must be publicly routable.</summary>
    Internet,

    /// <summary>
    /// A device on the network this household controls.
    /// </summary>
    /// <remarks>
    /// <b>Narrower than "not public", and the difference is the point.</b> This used to admit anything
    /// that was not obviously internet-facing, which swept in carrier-grade NAT (100.64.0.0/10) and
    /// <c>0.0.0.0/8</c> — ranges a household does not control and an ISP or a hostile neighbour on the
    /// same carrier network may. "Not public" and "ours" are different claims and only the second is
    /// the one being made.
    /// </remarks>
    HouseholdLan,

    /// <summary>
    /// This machine, and nothing else.
    /// </summary>
    /// <remarks>
    /// For destinations whose credential has no route-level scoping — the Hermes gateways and the
    /// image extractor both say so in as many words. An RFC1918 address is not a qualification for
    /// receiving one of those: a typo reaching another box on the LAN, or a compromised device on it,
    /// would satisfy a reach test and should not.
    /// </remarks>
    Loopback,
}

/// <summary>
/// The policy for one class of outbound destination.
/// </summary>
/// <param name="Setting">The configuration key, so a refusal names what to fix.</param>
/// <param name="Reach">Which side of the house/internet line this destination must be on.</param>
/// <param name="AllowedHosts">
/// Exact hosts permitted. Empty means the reach check is the whole rule — which is right for a LAN
/// device whose address a household chooses, and wrong for a credentialed third party, where the
/// host is the thing being authorised.
/// </param>
/// <param name="AllowedOrigins">
/// Exact origins — scheme, host <i>and</i> port — permitted, overriding both of the above.
/// <para>
/// <b>The strictest form, for destinations that hold a privileged credential.</b> A host allowlist
/// still admits every port on that host, and a reach test admits every machine on the network; for
/// something receiving a per-agent key and the household's conversations, neither is a small enough
/// target. When this is non-empty it is the whole authorisation: the origin either matches one of
/// these exactly or the destination is refused.
/// </para>
/// </param>
public sealed record EgressRule(
    string Setting,
    EgressReach Reach,
    IReadOnlyCollection<string> AllowedHosts,
    IReadOnlyCollection<string> AllowedOrigins)
{
    /// <summary>A named third-party service on the internet, reachable only at its own hosts.</summary>
    public static EgressRule Internet(string setting, IReadOnlyCollection<string> allowedHosts) =>
        new(setting, EgressReach.Internet, allowedHosts, []);

    /// <summary>A device on the household's own network, at an address they choose.</summary>
    public static EgressRule HouseholdLan(string setting) =>
        new(setting, EgressReach.HouseholdLan, [], []);

    /// <summary>Something on this machine holding a credential with no route-level scoping.</summary>
    public static EgressRule Loopback(string setting) =>
        new(setting, EgressReach.Loopback, [], []);

    /// <summary>Exactly these origins and nothing else — the narrowest form. See the parameter note.</summary>
    public static EgressRule Origins(string setting, IReadOnlyCollection<string> approved) =>
        new(setting, EgressReach.Loopback, [], approved);
}

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

        if (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp)
            return $"{rule.Setting} must use http or https; '{uri.Scheme}' is not a transport this speaks.";

        // Userinfo is a credential in a place nothing here expects one, and it is the classic way to
        // make a URL *read* as one host while resolving at another.
        if (!string.IsNullOrEmpty(uri.UserInfo))
            return $"{rule.Setting} must not carry userinfo.";

        if (!string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment))
            return $"{rule.Setting} must not carry a query string or fragment.";

        /*
         * An exact origin is the whole authorisation when one is given.
         *
         * Neither the reach nor the host list is consulted, because both are broader than what was
         * approved and the point of naming an origin is to be narrower than either. A deployment that
         * lists `http://127.0.0.1:8642` has authorised that listener and not port 8643 beside it.
         */
        if (rule.AllowedOrigins.Count > 0)
        {
            var origin = Origin(uri);
            return rule.AllowedOrigins.Any(o => MatchesOrigin(o, origin))
                ? null
                : $"{rule.Setting} points at '{origin}', which is not one of the approved origins for "
                  + "this destination.";
        }

        if (rule.Reach != EgressReach.Internet && uri.Scheme == Uri.UriSchemeHttp)
        {
            // Cleartext is allowed on the household's own network and nowhere else: the traffic never
            // leaves it, and requiring TLS from a sidecar somebody runs on a Pi would mean nobody runs one.
        }
        else if (uri.Scheme != Uri.UriSchemeHttps)
        {
            return $"{rule.Setting} must use https; '{uri.Scheme}' would send household data and any "
                + "credential with it in the clear.";
        }

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
        if (IPAddress.TryParse(uri.Host.Trim('[', ']'), out var literal))
            return RefuseAddress(literal, rule, uri.Host);

        return null;
    }

    /// <summary>Whether one resolved address satisfies the rule's reach, and why not when it does not.</summary>
    private static string? RefuseAddress(IPAddress address, EgressRule rule, string host) => rule.Reach switch
    {
        EgressReach.Loopback when !IPAddress.IsLoopback(Normalise(address)) =>
            $"{rule.Setting}: '{host}' is not on this machine. This destination holds a credential with "
            + "no route-level scoping, so it may only be reached over loopback.",
        EgressReach.HouseholdLan when !IsHouseholdLan(address) =>
            $"{rule.Setting}: '{host}' is not on this house's own network.",
        EgressReach.Internet when !IsPubliclyRoutable(address) =>
            $"{rule.Setting}: '{host}' is not a publicly routable address. A third-party service "
            + "reached at one is not that service.",
        _ => null,
    };

    /// <summary>Scheme, host and port, with the default port made explicit so two spellings compare equal.</summary>
    private static string Origin(Uri uri) =>
        $"{uri.Scheme.ToLowerInvariant()}://{uri.Host.ToLowerInvariant()}:{uri.Port}";

    private static bool MatchesOrigin(string approved, string origin) =>
        Uri.TryCreate(approved, UriKind.Absolute, out var uri)
        && string.Equals(Origin(uri), origin, StringComparison.Ordinal);

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
        /*
         * <b>No proxy, and this is not tidiness.</b> A proxy defeats the callback below completely:
         * the connection is made to the proxy, so the addresses screened are the proxy's, and the
         * destination is reached by asking it to go there. Every check in this class would pass while
         * household audio went somewhere else entirely. `HttpClient` picks proxies up from the
         * environment by default, so leaving this unset means an `HTTP_PROXY` variable — set for a
         * package manager, inherited from a shell, planted in a unit file — silently reroutes the lot.
         */
        UseProxy = false,
        ConnectCallback = async (context, ct) =>
        {
            var current = rule();
            var host = context.DnsEndPoint.Host;

            if (current.AllowedOrigins.Count > 0
                && !current.AllowedOrigins.Any(o => MatchesHostAndPort(o, host, context.DnsEndPoint.Port)))
            {
                throw new BlockedAddressException(
                    $"{current.Setting}: '{host}:{context.DnsEndPoint.Port}' is not an approved origin.");
            }

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
            foreach (var address in addresses)
            {
                if (RefuseAddress(address, current, host) is { } refusal)
                    throw new BlockedAddressException(refusal);
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
    /// A handler that refuses every connection, for a registration that exists so the unnamed default
    /// does not.
    /// </summary>
    /// <remarks>
    /// `AddHttpClient()` registers the factory <i>and</i> an unnamed default client configured with
    /// nothing — which is what the account-link token exchange picked up, posting an OAuth client
    /// secret through a handler that follows redirects and screens no address. The factory is still
    /// needed by injection, so it is registered under a name, and that name gets this: a client that
    /// cannot reach anything, so a caller reaching for it fails loudly rather than working unguarded.
    /// </remarks>
    public static SocketsHttpHandler CreateBlockingHandler() => new()
    {
        AllowAutoRedirect = false,
        UseProxy = false,
        ConnectCallback = (context, _) => throw new BlockedAddressException(
            $"'{context.DnsEndPoint.Host}' was reached through an unconfigured HTTP client. Every "
            + "outbound destination needs a named, guarded registration — see EgressGuard."),
    };

    /// <summary>
    /// The connect callback sees a host and a port rather than a URL, so origins are matched on those.
    /// </summary>
    /// <remarks>
    /// The scheme is not compared here and does not need to be: the shape check has already refused
    /// any origin whose scheme was wrong, and a connection cannot change the scheme of the request
    /// that opened it.
    /// </remarks>
    private static bool MatchesHostAndPort(string approved, string host, int port) =>
        Uri.TryCreate(approved, UriKind.Absolute, out var uri)
        && uri.Port == port
        && string.Equals(uri.Host, host, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Whether this address is on the network the household actually controls.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Loopback, RFC1918, link-local, and the IPv6 equivalents — unique local addresses and
    /// link-local — plus anything mapped from an IPv4 address in those ranges, because
    /// <c>::ffff:127.0.0.1</c> is loopback however it is spelled.
    /// </para>
    /// <para>
    /// <b>Carrier-grade NAT (100.64.0.0/10) and <c>0.0.0.0/8</c> are deliberately absent.</b> They are
    /// not publicly routable, which is what an earlier version of this tested for, and they are not
    /// the household's either: CGNAT space is the ISP's, shared with every other subscriber behind the
    /// same equipment. "Not public" was the wrong question — a sidecar holding household audio should
    /// be on a network this house owns, not merely on one the internet cannot reach directly.
    /// </para>
    /// </remarks>
    public static bool IsHouseholdLan(IPAddress address)
    {
        address = Normalise(address);
        if (IPAddress.IsLoopback(address)) return true;

        if (address.AddressFamily == AddressFamily.InterNetwork)
        {
            var b = address.GetAddressBytes();
            return b[0] switch
            {
                10 => true,
                172 when b[1] >= 16 && b[1] <= 31 => true,
                192 when b[1] == 168 => true,
                169 when b[1] == 254 => true, // link-local, which is this link and so this house
                _ => false,
            };
        }

        if (address.AddressFamily == AddressFamily.InterNetworkV6)
        {
            if (address.IsIPv6LinkLocal || address.IsIPv6SiteLocal) return true;
            return (address.GetAddressBytes()[0] & 0xFE) == 0xFC; // fc00::/7, unique local
        }

        return false;
    }

    /// <summary>
    /// Whether this address is one a third-party service can legitimately answer at.
    /// </summary>
    /// <remarks>
    /// The complement is deliberately not <see cref="IsHouseholdLan"/>: the ranges that are neither —
    /// carrier-grade NAT, multicast, reserved space, the broadcast address — are refused by both, which
    /// is the right answer for both. A destination that is neither ours nor the internet's is one
    /// nothing here should be talking to.
    /// </remarks>
    public static bool IsPubliclyRoutable(IPAddress address)
    {
        address = Normalise(address);
        if (IPAddress.IsLoopback(address) || IsHouseholdLan(address)) return false;

        if (address.AddressFamily == AddressFamily.InterNetwork)
        {
            var b = address.GetAddressBytes();
            if (b[0] == 0) return false;                                   // "this network"
            if (b[0] == 100 && b[1] >= 64 && b[1] <= 127) return false;    // carrier-grade NAT
            if (b[0] >= 224) return false;                                 // multicast, reserved, broadcast
            return true;
        }

        if (address.AddressFamily == AddressFamily.InterNetworkV6)
        {
            if (address.IsIPv6Multicast) return false;
            if (address.Equals(IPAddress.IPv6Any) || address.Equals(IPAddress.IPv6None)) return false;
            return true;
        }

        return false;
    }

    /// <summary>An IPv4-mapped IPv6 address is the IPv4 address it maps, however it is written.</summary>
    private static IPAddress Normalise(IPAddress address) =>
        address.IsIPv4MappedToIPv6 ? address.MapToIPv4() : address;
}
