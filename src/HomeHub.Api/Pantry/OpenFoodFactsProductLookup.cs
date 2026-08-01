namespace HomeHub.Api.Pantry;

using System.Collections.Concurrent;
using System.Globalization;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;

/// <summary>
/// Looks a barcode up in Open Food Facts — an open, ODbL-licensed food database with no API key.
/// </summary>
/// <remarks>
/// Chosen over the commercial catalogues because it needs no account, it is food-first (which is
/// what a pantry holds), and it offers an <i>exact</i> barcode endpoint rather than a fuzzy search.
/// <para>
/// <b>Its weak spot is US private label.</b> Store brands — Great Value, Marketside, the very
/// abbreviations the order parser has examples for — are the least likely to resolve. So this
/// reduces typing rather than removing it, and `NAME IT` stays the mechanism that actually teaches
/// the household catalogue.
/// </para>
/// <para>
/// Every failure path returns null. A barcode that is unknown, a request that times out, a service
/// that is down and a malformed payload are all the same thing to the caller: no suggestion, and
/// the unmatched row that the design specified in the first place.
/// </para>
/// </remarks>
public sealed class OpenFoodFactsProductLookup : IProductLookup
{
    /// <summary>
    /// Only the fields a pantry row needs. Open Food Facts returns an enormous document by default
    /// — nutrition, images, per-country scores — and narrowing it is both faster and politer to a
    /// volunteer-run service.
    /// </summary>
    private const string Fields = "product_name,generic_name,brands,quantity,product_quantity,product_quantity_unit";

    private readonly HttpClient _http;
    private readonly OpenFoodFactsOptions _options;
    private readonly TimeProvider _clock;
    private readonly ILogger<OpenFoodFactsProductLookup> _logger;

    /// <summary>Answers and non-answers alike — see <see cref="OpenFoodFactsOptions.CacheHours"/>.</summary>
    private static readonly ConcurrentDictionary<string, (ProductInfo? Info, DateTimeOffset At)> Cache = new();

    public OpenFoodFactsProductLookup(
        HttpClient http,
        IOptions<OpenFoodFactsOptions> options,
        TimeProvider clock,
        ILogger<OpenFoodFactsProductLookup> logger)
    {
        _http = http;
        _options = options.Value;
        _clock = clock;
        _logger = logger;

        _http.Timeout = TimeSpan.FromSeconds(Math.Clamp(_options.TimeoutSeconds, 1, 20));
        if (!_http.DefaultRequestHeaders.Contains("User-Agent"))
        {
            _http.DefaultRequestHeaders.Add("User-Agent", _options.UserAgent);
        }
    }

    public string Source => "Open Food Facts";

    public async Task<ProductInfo?> LookupAsync(string barcode, CancellationToken ct)
    {
        // The barcode reaches a URL path, so it is checked rather than trusted. `Barcodes.Normalise`
        // already guarantees 13 digits upstream; this is the cheap second lock on the door, and it
        // is what makes the interpolation below safe to read.
        if (string.IsNullOrEmpty(barcode) || !barcode.All(char.IsAsciiDigit)) return null;

        var now = _clock.GetUtcNow();
        if (Cache.TryGetValue(barcode, out var cached)
            && now - cached.At < TimeSpan.FromHours(Math.Clamp(_options.CacheHours, 1, 24 * 30)))
        {
            return cached.Info;
        }

        ProductInfo? result = null;
        try
        {
            var url = $"{_options.BaseUrl.TrimEnd('/')}/api/v2/product/{barcode}.json?fields={Fields}";
            var response = await _http.GetAsync(url, ct);

            // 404 is the documented "no such product" and is not worth logging as a fault.
            if (response.IsSuccessStatusCode)
            {
                var payload = await response.Content.ReadFromJsonAsync<OffResponse>(ct);
                result = ToProductInfo(payload);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            // Never surfaced. The scan falls back to the unmatched row, which is a designed state
            // rather than an error, and the household carries on naming the pack by hand.
            _logger.LogDebug(ex, "Open Food Facts lookup failed for {Barcode}", barcode);
        }

        // Cached either way, including the null: an unknown barcode stays unknown for the window,
        // and the camera re-reading the same pack costs nothing.
        Cache[barcode] = (result, now);
        return result;
    }

    /// <summary>Reduce the payload to the few fields a pantry row can use, or null if there is nothing usable.</summary>
    internal static ProductInfo? ToProductInfo(OffResponse? payload)
    {
        // `status` is 1 for found, 0 for not found. A 200 with status 0 is the normal "unknown
        // barcode" answer, not a failure.
        if (payload?.Status != 1 || payload.Product is null) return null;

        var product = payload.Product;

        // product_name is usually the fullest. generic_name is a decent fallback ("cola"); brands
        // alone is a last resort and better than nothing to type over.
        var name = FirstNonBlank(product.ProductName, product.GenericName, product.Brands);
        if (name is null) return null;

        // Brands is a comma-separated list; the first is the one anyone would say out loud.
        var brand = product.Brands?.Split(',').Select(b => b.Trim()).FirstOrDefault(b => b.Length > 0);

        var unit = Blank(product.ProductQuantityUnit);
        var size = ReadNumber(product.ProductQuantity);

        // `quantity` is free text ("355 ml", "6 x 33 cl"). Used only when the structured pair is
        // absent, and then only as the unit label — parsing prose into a number is exactly the kind
        // of confident guess this section refuses to make.
        if (unit is null && size is null) unit = Blank(product.Quantity);

        return new ProductInfo(
            Truncate(name, PantryFieldLimits.ItemName),
            brand is null ? null : Truncate(brand, PantryFieldLimits.ItemName),
            unit is null ? null : Truncate(unit, PantryFieldLimits.Unit),
            Tidy(size),
            "Open Food Facts");
    }

    /// <summary>
    /// Round a pack size to something a person would write down.
    /// </summary>
    /// <remarks>
    /// An 8 oz bag of walnuts arrives from Open Food Facts as <c>226.796185</c> g, because the
    /// database stores a converted imperial figure at full float precision. That number goes into
    /// a field the household is asked to confirm, and then into every future scan of that pack —
    /// six decimal places of false precision on a bag of nuts.
    /// <para>
    /// Rounding loses nothing real: the conversion was already lossy, and no pantry needs a
    /// milligram. Ten is the hinge — below it the decimals are the whole value ("1.5 l"), above it
    /// they are noise ("227 g").
    /// </para>
    /// </remarks>
    internal static decimal? Tidy(decimal? size) => size switch
    {
        null => null,
        >= 10 => decimal.Round(size.Value, 0, MidpointRounding.AwayFromZero),
        _ => decimal.Round(size.Value, 2, MidpointRounding.AwayFromZero),
    };

    private static string? FirstNonBlank(params string?[] values) =>
        values.Select(Blank).FirstOrDefault(v => v is not null);

    private static string? Blank(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    /// <summary>
    /// Read a value that Open Food Facts may send as a number, a quoted number, or an empty string.
    /// </summary>
    /// <remarks>
    /// The database is community-entered and this field is genuinely all three shapes across
    /// records. Binding it to a <c>decimal</c> would throw on two of them, and because the exception
    /// is swallowed upstream the symptom would be silent: perfectly good products resolving as
    /// "not in the catalogue" for no visible reason.
    /// </remarks>
    private static decimal? ReadNumber(JsonElement? value) => value?.ValueKind switch
    {
        JsonValueKind.Number when value.Value.TryGetDecimal(out var number) && number > 0 => number,
        JsonValueKind.String when decimal.TryParse(
            value.Value.GetString(), NumberStyles.Number, CultureInfo.InvariantCulture, out var parsed)
            && parsed > 0 => parsed,
        _ => null,
    };

    private static string Truncate(string value, int max) =>
        value.Length <= max ? value : value[..max];

    /// <summary>The narrowed Open Food Facts v2 response.</summary>
    internal sealed record OffResponse(
        [property: JsonPropertyName("status")] int Status,
        [property: JsonPropertyName("product")] OffProduct? Product);

    internal sealed record OffProduct(
        [property: JsonPropertyName("product_name")] string? ProductName,
        [property: JsonPropertyName("generic_name")] string? GenericName,
        [property: JsonPropertyName("brands")] string? Brands,
        [property: JsonPropertyName("quantity")] string? Quantity,
        // Left as a raw element: see ReadNumber for why this field cannot be bound to a decimal.
        [property: JsonPropertyName("product_quantity")] JsonElement? ProductQuantity,
        [property: JsonPropertyName("product_quantity_unit")] string? ProductQuantityUnit);
}
