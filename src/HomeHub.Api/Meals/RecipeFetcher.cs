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
/// </summary>
public sealed class RecipeFetcher
{
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
                    return FetchResult.Fail(response.StatusCode == HttpStatusCode.NotFound
                        ? "That page does not exist."
                        : $"The site answered {(int)response.StatusCode}.");
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

    private static bool IsRedirect(HttpStatusCode status) =>
        status is HttpStatusCode.Moved or HttpStatusCode.Found or HttpStatusCode.SeeOther
            or HttpStatusCode.TemporaryRedirect or HttpStatusCode.PermanentRedirect;

    /// <summary>The reason this URI is refused, or null when it is allowed.</summary>
    private string? Validate(Uri uri)
    {
        if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
            return "Only http and https addresses can be imported.";

        if (_options.AllowPrivateAddresses) return null;

        // `.local` is mDNS and never resolves to anything public — refused by name because
        // resolution may not even be available for it.
        if (uri.Host.EndsWith(".local", StringComparison.OrdinalIgnoreCase))
            return "That address is on the local network.";

        IPAddress[] addresses;
        try
        {
            // A literal IP short-circuits DNS; a name is resolved so the *destination* is what gets
            // checked. `evil.test A 192.168.1.10` is the attack this defeats.
            addresses = IPAddress.TryParse(uri.Host, out var literal)
                ? [literal]
                : Dns.GetHostAddresses(uri.Host);
        }
        catch (SocketException)
        {
            return "Could not find that site.";
        }

        if (addresses.Length == 0) return "Could not find that site.";
        // Every resolved address must be public. A name answering both a public and a private
        // address would otherwise be allowed through and then connected to whichever the stack
        // picked — so the strict form is the only safe one.
        if (addresses.Any(IsPrivate)) return "That address is on the local network.";

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
