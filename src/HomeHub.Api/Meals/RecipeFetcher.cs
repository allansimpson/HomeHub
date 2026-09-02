namespace HomeHub.Api.Meals;

using System.Net;
using System.Net.Sockets;
using Microsoft.Extensions.Options;

/// <summary>What came back from a guarded fetch, or why nothing did.</summary>
public sealed record FetchResult(bool Ok, string? Content, string? ContentType, byte[]? Bytes, string? Error)
{
    public static FetchResult Fail(string error) => new(false, null, null, null, error);
}

/// <summary>
/// Fetches a user-supplied URL with the SSRF guard meals-planning.md D4 requires.
/// <para>
/// This class is the security boundary of the import feature, and it is not optional hardening.
/// The API has <b>no authentication anywhere</b> (D6), so <c>POST /api/recipes/import</c> is
/// reachable by anything on the LAN — and that LAN also hosts Home Assistant with a long-lived
/// token, SQL Server, and the router's admin page. An unguarded server-side fetcher is a request
/// forgery primitive aimed at exactly those.
/// </para>
/// <para>
/// The guard checks the <b>resolved IP</b>, not the hostname, and re-checks after <b>every</b>
/// redirect. Both matter: <c>evil.test</c> can resolve straight to <c>192.168.1.10</c>, and a
/// perfectly public host can answer 302 with a private <c>Location</c>. Checking the name, or
/// checking only the first hop, defeats the whole exercise.
/// </para>
/// <para>
/// <b>The check happens at connect time, in <see cref="CreateGuardedHandler"/>, not before the
/// send.</b> This is the difference between checking an address and checking <i>the</i> address.
/// A guard that resolves the name itself and then hands the name to <c>HttpClient</c> has told the
/// stack to resolve it a second time, independently — and a hostile name with a zero-second TTL can
/// answer public to the check and private to the connect. The window is small and entirely under
/// the attacker's control, which is the worst combination. Inside <c>ConnectCallback</c> there is
/// no second resolution to race: the callback resolves once, screens what it got, and dials
/// <i>those</i> <see cref="IPAddress"/> values rather than the name. Nothing between the check and
/// the socket can change what is dialled.
/// </para>
/// </summary>
public sealed class RecipeFetcher
{
    /// <summary>
    /// Raised from the connect callback when the destination resolved into a range the panel has
    /// no business reaching.
    /// </summary>
    /// <remarks>
    /// A distinct type because the callback's only channel back to the caller is an exception, and
    /// <c>HttpClient</c> wraps whatever it throws in an <see cref="HttpRequestException"/>. Without
    /// something to recognise, "that address is on your own network" and "that site is down" arrive
    /// as the same generic failure — and the first is the one worth wording carefully, since the
    /// household member who typed a NAS URL by mistake should be told what actually happened.
    /// </remarks>
    private sealed class BlockedAddressException(string reason) : Exception(reason);

    /// <summary>
    /// The primary handler for the fetcher's typed client: no automatic redirects, and every TCP
    /// connection screened before it is made.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Redirects stay manual.</b> <see cref="GetAsync"/> walks them by hand so each hop is
    /// re-validated; letting the handler follow them would take hops 2..n straight to the network.
    /// Both halves of the guard have to agree on this or neither works.
    /// </para>
    /// <para>
    /// <b>The connect callback is the guard.</b> It is reached once per new connection, for every
    /// hop, with the endpoint actually being dialled — including hops this class never sees because
    /// they came from a pooled connection or a proxy. <c>ConnectAsync(IPAddress[], port)</c> rather
    /// than <c>ConnectAsync(host, port)</c> is the whole point: the second overload would resolve
    /// the name again and discard the screening.
    /// </para>
    /// </remarks>
    public static SocketsHttpHandler CreateGuardedHandler(MealsOptions options) => new()
    {
        AllowAutoRedirect = false,
        // A proxy would make the connect callback screen the proxy's address instead of the site's,
        // so every check below would pass while the fetch went wherever it was told. See `EgressGuard`,
        // which carries the longer note; this handler predates it and had the same gap.
        UseProxy = false,
        ConnectCallback = async (context, ct) =>
        {
            var host = context.DnsEndPoint.Host;

            IPAddress[] addresses;
            try
            {
                // A literal IP short-circuits DNS; a name is resolved here, once, and the addresses
                // that come back are both what gets screened and what gets dialled.
                addresses = IPAddress.TryParse(host, out var literal)
                    ? [literal]
                    : await Dns.GetHostAddressesAsync(host, ct);
            }
            catch (SocketException)
            {
                throw new BlockedAddressException("Could not find that site.");
            }

            if (addresses.Length == 0) throw new BlockedAddressException("Could not find that site.");

            // Every resolved address must be public — not merely one of them. A name answering both
            // a public and a private address would otherwise pass and then be connected to whichever
            // the stack happened to prefer, which is a coin flip an attacker gets to weight.
            if (!options.AllowPrivateAddresses && addresses.Any(IsPrivate))
                throw new BlockedAddressException("That address is on the local network.");

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

    private readonly HttpClient _http;
    private readonly MealsOptions _options;
    private readonly ILogger<RecipeFetcher> _logger;

    public RecipeFetcher(HttpClient http, IOptions<MealsOptions> options, ILogger<RecipeFetcher> logger)
    {
        _options = options.Value;
        _logger = logger;
        _http = http;
        _http.Timeout = TimeSpan.FromSeconds(_options.TimeoutSeconds);
        if (!_http.DefaultRequestHeaders.Contains("User-Agent"))
            _http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", _options.UserAgent);
    }

    /// <summary>Fetch a recipe page as text. Redirects are followed by hand so each hop is re-checked.</summary>
    public Task<FetchResult> GetPageAsync(string url, CancellationToken ct) => GetAsync(url, asText: true, ct);

    /// <summary>Fetch a hero image as bytes. Same guard, same redirect handling.</summary>
    public Task<FetchResult> GetBytesAsync(string url, CancellationToken ct) => GetAsync(url, asText: false, ct);

    private async Task<FetchResult> GetAsync(string url, bool asText, CancellationToken ct)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return FetchResult.Fail("That is not a web address.");

        for (var hop = 0; hop <= _options.MaxRedirects; hop++)
        {
            if (Validate(uri) is { } rejection) return FetchResult.Fail(rejection);

            using var request = new HttpRequestMessage(HttpMethod.Get, uri);
            HttpResponseMessage response;
            try
            {
                // ResponseHeadersRead so an oversized body can be abandoned before it is buffered —
                // the size cap is worthless if the whole response is already in memory by the time
                // it is checked.
                response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            }
            catch (TaskCanceledException) when (!ct.IsCancellationRequested)
            {
                return FetchResult.Fail("The site took too long to answer.");
            }
            // The connect callback refused this destination. Its message is already the one to show,
            // and it arrives here wrapped because that is the only way out of a ConnectCallback.
            catch (HttpRequestException ex) when (ex.InnerException is BlockedAddressException blocked)
            {
                _logger.LogInformation("Recipe fetch blocked for {Host}: {Reason}", uri.Host, blocked.Message);
                return FetchResult.Fail(blocked.Message);
            }
            catch (HttpRequestException ex)
            {
                _logger.LogInformation(ex, "Recipe fetch failed for {Host}.", uri.Host);
                return FetchResult.Fail("Could not reach that site.");
            }

            using (response)
            {
                if (IsRedirect(response.StatusCode))
                {
                    var location = response.Headers.Location;
                    if (location is null) return FetchResult.Fail("The site redirected to nowhere.");
                    // Relative Locations are legal and common; resolve against the current hop so the
                    // next loop validates a real absolute destination.
                    uri = location.IsAbsoluteUri ? location : new Uri(uri, location);
                    continue;
                }

                if (!response.IsSuccessStatusCode)
                {
                    _logger.LogInformation(
                        "Recipe fetch refused by {Host}: {Status}.", uri.Host, (int)response.StatusCode);
                    return FetchResult.Fail(RefusalFor(response.StatusCode));
                }

                if (response.Content.Headers.ContentLength is { } declared && declared > _options.MaxResponseBytes)
                    return FetchResult.Fail("That page is too big to read.");

                var contentType = response.Content.Headers.ContentType?.MediaType;
                var bytes = await ReadCappedAsync(response, ct);
                if (bytes is null) return FetchResult.Fail("That page is too big to read.");

                return asText
                    ? new FetchResult(true, System.Text.Encoding.UTF8.GetString(bytes), contentType, bytes, null)
                    : new FetchResult(true, null, contentType, bytes, null);
            }
        }

        return FetchResult.Fail("That address redirected too many times.");
    }

    /// <summary>
    /// Read at most <see cref="MealsOptions.MaxResponseBytes"/>, or null if the body exceeds it.
    /// </summary>
    /// <remarks>
    /// Counted while streaming rather than trusted from <c>Content-Length</c>: that header is
    /// optional, and a chunked response omits it entirely — which is precisely the shape something
    /// trying to exhaust memory would use.
    /// </remarks>
    private async Task<byte[]?> ReadCappedAsync(HttpResponseMessage response, CancellationToken ct)
    {
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var buffer = new MemoryStream();
        var chunk = new byte[81920];
        int read;
        while ((read = await stream.ReadAsync(chunk, ct)) > 0)
        {
            if (buffer.Length + read > _options.MaxResponseBytes) return null;
            buffer.Write(chunk, 0, read);
        }
        return buffer.ToArray();
    }

    /// <summary>
    /// What to tell the household when a page came back unusable.
    /// </summary>
    /// <remarks>
    /// A bare <c>The site answered 402</c> is accurate and useless: it reads as a fault in the panel,
    /// so the household retries the same link. The statuses below mean quite different things and
    /// only one of them is worth retrying.
    /// <para>
    /// <b>The blocked group is the common one.</b> Several large recipe publishers refuse automated
    /// reads outright — allrecipes.com answers <c>402</c> from Cloudflare to every client, browser
    /// user-agent included, with a body directing the reader to their content-licensing address.
    /// That is a deliberate access decision by the rights holder, not an obstacle to work around, so
    /// the honest thing is to say the site will not allow it and point at the path that still works:
    /// typing the recipe in. The panel already offers that on the same screen.
    /// </para>
    /// </remarks>
    internal static string RefusalFor(HttpStatusCode status) => (int)status switch
    {
        404 or 410 => "That page does not exist.",
        // 402 is the odd one in this group and the reason it exists: publishers use it for
        // "licensed content", alongside the more usual 401/403 and the legal-block 451.
        401 or 402 or 403 or 451 =>
            "That site does not allow the panel to read its recipes. Copy the page and paste it below.",
        429 => "That site is asking the panel to slow down. Try again in a few minutes.",
        >= 500 and < 600 => "That site is having trouble right now. Try again later.",
        var code => $"The site answered {code}.",
    };

    private static bool IsRedirect(HttpStatusCode status) =>
        status is HttpStatusCode.Moved or HttpStatusCode.Found or HttpStatusCode.SeeOther
            or HttpStatusCode.TemporaryRedirect or HttpStatusCode.PermanentRedirect;

    /// <summary>The reason this URI is refused, or null when it is allowed.</summary>
    /// <remarks>
    /// <b>This is not the SSRF check.</b> That lives in the connect callback in
    /// <see cref="CreateGuardedHandler"/>, where the address being screened is the address being
    /// dialled. What is left here is the part that can be decided from the URI alone, and it stays
    /// because it is worth deciding early: a bad scheme or an mDNS name is refused without opening
    /// a socket, and a literal private IP gets the plainly-worded refusal rather than arriving as a
    /// connect failure. Nothing here is load-bearing — delete it all and the guard still holds.
    /// </remarks>
    private string? Validate(Uri uri)
    {
        if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
            return "Only http and https addresses can be imported.";

        if (_options.AllowPrivateAddresses) return null;

        // `.local` is mDNS and never resolves to anything public — refused by name because
        // resolution may not even be available for it.
        if (uri.Host.EndsWith(".local", StringComparison.OrdinalIgnoreCase))
            return "That address is on the local network.";

        // A literal IP has no DNS step, so there is no race to worry about and no reason to make
        // the household wait for a connection attempt to be told the obvious.
        if (IPAddress.TryParse(uri.Host, out var literal) && IsPrivate(literal))
            return "That address is on the local network.";

        return null;
    }

    /// <summary>
    /// Is this an address the panel has no business fetching from? Covers every range D4 lists.
    /// </summary>
    internal static bool IsPrivate(IPAddress address)
    {
        if (IPAddress.IsLoopback(address)) return true;

        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();

        if (address.AddressFamily == AddressFamily.InterNetwork)
        {
            var b = address.GetAddressBytes();
            return b[0] switch
            {
                0 => true,                                  // "this network"
                10 => true,                                 // RFC1918
                127 => true,                                // loopback
                169 when b[1] == 254 => true,               // link-local
                172 when b[1] >= 16 && b[1] <= 31 => true,  // RFC1918
                192 when b[1] == 168 => true,               // RFC1918
                100 when b[1] >= 64 && b[1] <= 127 => true, // CGNAT
                >= 224 => true,                             // multicast + reserved
                _ => false,
            };
        }

        if (address.AddressFamily == AddressFamily.InterNetworkV6)
        {
            if (address.IsIPv6LinkLocal || address.IsIPv6SiteLocal || address.IsIPv6Multicast) return true;
            // fc00::/7 — unique local addresses, the IPv6 analogue of RFC1918.
            var b = address.GetAddressBytes();
            if ((b[0] & 0xFE) == 0xFC) return true;
            if (address.Equals(IPAddress.IPv6Any)) return true;
        }

        return false;
    }
}
