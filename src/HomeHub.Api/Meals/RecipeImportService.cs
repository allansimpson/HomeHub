namespace HomeHub.Api.Meals;

using System.Security.Cryptography;
using Microsoft.Extensions.Options;

/// <summary>What the import screen is told, whether or not a recipe was written.</summary>
public sealed record RecipeImportResponse(
    /// <summary>`Complete`, `Partial`, or `Empty`. Empty means nothing was saved.</summary>
    string Confidence,
    /// <summary>The saved recipe, or null when the page published no recipe data.</summary>
    RecipeDto? Recipe,
    /// <summary>Exactly what is missing or why nothing was saved. Null on a clean import.</summary>
    string? Reason);

/// <summary>
/// Fetch a URL, read its schema.org <c>Recipe</c>, and persist what came back.
/// <para>
/// The three stages are deliberately separate types: <see cref="RecipeFetcher"/> owns the security
/// boundary (D4), <see cref="JsonLdRecipeImporter"/> owns the format (D2), and this owns the
/// decision about what is worth writing (D10). Only the last of those touches the database.
/// </para>
/// </summary>
public sealed class RecipeImportService
{
    private readonly RecipeFetcher _fetcher;
    private readonly MealsOptions _options;
    private readonly IHostEnvironment _environment;
    private readonly ILogger<RecipeImportService> _logger;

    public RecipeImportService(
        RecipeFetcher fetcher,
        IOptions<MealsOptions> options,
        IHostEnvironment environment,
        ILogger<RecipeImportService> logger)
    {
        _fetcher = fetcher;
        _options = options.Value;
        _environment = environment;
        _logger = logger;
    }

    /// <summary>
    /// Import a page. Returns the parse verdict plus the recipe input to persist, or a reason.
    /// </summary>
    /// <remarks>
    /// Does not itself write to the database — the controller does, so that all recipe persistence
    /// (validation, tag normalisation, length guards) keeps going through the one code path in
    /// <c>RecipesController</c> rather than acquiring a second, subtly different one here.
    /// <para>
    /// <b>Two readings of one fetch.</b> Structured data first, because a page that publishes
    /// schema.org <c>Recipe</c> has already done the parsing for us and does it better. When there
    /// is none, the same bytes are flattened to text and read by
    /// <see cref="PastedRecipeImporter"/> — the parser the paste box uses. That covers the large
    /// class of sites that serve a perfectly good page with no markup on it: personal blogs, older
    /// sites, anything not built on a recipe plugin. Those used to dead-end on "publishes no recipe
    /// data" while the recipe sat in the response we already held.
    /// </para>
    /// <para>
    /// <b>This does not reach a page the publisher refused.</b> A blocked site never gets here —
    /// <see cref="RecipeFetcher"/> returns the refusal and this exits at the first line. There is
    /// nothing to fall back to in that case and the fallback is not a way around it: allrecipes'
    /// 402 body is six hundred bytes of licensing notice, not a recipe. The way in there is a person
    /// reading the page in their own browser and pasting it.
    /// </para>
    /// </remarks>
    public async Task<(ImportConfidence Confidence, RecipeInput? Input, string? ImageUrl, string? Reason)>
        ReadAsync(string url, CancellationToken ct)
    {
        var page = await _fetcher.GetPageAsync(url, ct);
        if (!page.Ok) return (ImportConfidence.Empty, null, null, page.Error);

        // A JSON or image URL will never carry recipe JSON-LD; say so plainly rather than reporting
        // "no recipe data", which sounds like the site's fault.
        if (page.ContentType is { } type && !type.Contains("html", StringComparison.OrdinalIgnoreCase))
            return (ImportConfidence.Empty, null, null, "That address isn't a web page.");

        var html = page.Content ?? string.Empty;
        var result = JsonLdRecipeImporter.Parse(html, url);
        if (result.Confidence != ImportConfidence.Empty && result.Recipe is not null)
            return (result.Confidence, result.Recipe, result.ImageUrl, result.Reason);

        // No usable structured data. Read the page as text instead.
        var flattened = HtmlToText.Flatten(html);
        if (flattened is null) return (result.Confidence, result.Recipe, result.ImageUrl, result.Reason);

        var fromText = PastedRecipeImporter.Parse(flattened, url);
        if (fromText.Confidence == ImportConfidence.Empty || fromText.Recipe is null)
        {
            // Neither reading found one. The JSON-LD reason is the more specific of the two — it can
            // say "the page has a Recipe node with nothing in it", which a paywall produces and
            // which the text reading has no way to know.
            _logger.LogInformation("Neither JSON-LD nor text found a recipe at {Url}.", url);
            return (result.Confidence, result.Recipe, result.ImageUrl, result.Reason);
        }

        _logger.LogInformation("Read {Url} as text — no usable JSON-LD on the page.", url);
        return (
            fromText.Confidence,
            fromText.Recipe,
            // The hero image comes from the structured data, which is exactly what was missing. A
            // text reading has no reliable way to tell a recipe photo from an author headshot, and
            // guessing wrong puts a stranger's face on the recipe card.
            null,
            fromText.Reason);
    }

    /// <summary>
    /// Download and cache the hero image, returning the stored filename.
    /// </summary>
    /// <remarks>
    /// Written to <see cref="MealsOptions.ImagePath"/>, never <c>wwwroot</c> (D5): that directory is
    /// the SPA build output and is replaced wholesale on every deploy, so a cache there is destroyed
    /// by the next publish.
    /// <para>
    /// The filename is a content hash and the extension comes from the <b>sniffed</b> content type,
    /// never from the source URL — a URL ending <c>.jpg</c> is an assertion by a stranger, and
    /// letting it choose a path component is how a fetcher starts writing <c>.aspx</c> files.
    /// </para>
    /// A failure here is logged and swallowed: no recipe is worth losing because its photo 404'd.
    /// </remarks>
    public async Task<string?> CacheImageAsync(string imageUrl, CancellationToken ct)
    {
        try
        {
            var fetched = await _fetcher.GetBytesAsync(imageUrl, ct);
            if (!fetched.Ok || fetched.Bytes is null || fetched.Bytes.Length == 0) return null;

            var extension = ExtensionFor(fetched.ContentType);
            // Non-image responses are discarded — a consent wall answering HTML to an <img> URL is
            // the common case, and caching it would leave a "photo" that renders as garbage.
            if (extension is null) return null;

            var directory = ImageDirectory();
            Directory.CreateDirectory(directory);

            var hash = Convert.ToHexString(SHA256.HashData(fetched.Bytes))[..32].ToLowerInvariant();
            var fileName = hash + extension;
            var path = Path.Combine(directory, fileName);
            // Content-addressed, so the same image imported twice is written once.
            if (!File.Exists(path)) await File.WriteAllBytesAsync(path, fetched.Bytes, ct);
            return fileName;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning(ex, "Could not cache recipe image from {Url}.", imageUrl);
            return null;
        }
    }

    /// <summary>Absolute path of a cached image, or null if it is missing or the name is not one of ours.</summary>
    public string? ResolveImagePath(string fileName)
    {
        // The stored name is ours, but it still round-trips through the database, so it is treated
        // as untrusted: anything with a separator or a parent segment is refused rather than
        // combined into a path that could escape the cache directory.
        if (string.IsNullOrWhiteSpace(fileName)
            || fileName.Contains('/') || fileName.Contains('\\') || fileName.Contains(".."))
        {
            return null;
        }
        var path = Path.Combine(ImageDirectory(), fileName);
        return File.Exists(path) ? path : null;
    }

    /// <summary>
    /// Remove a cached image. Best-effort: a file that is already gone, locked, or unreadable is not
    /// worth failing a delete the user asked for — the recipe row is what they wanted removed, and a
    /// stranded image is a wasted block, not a broken panel.
    /// </summary>
    /// <remarks>
    /// The caller is responsible for checking no other recipe still references this file. Names are
    /// content hashes, so sharing is real rather than theoretical.
    /// </remarks>
    public void DeleteCachedImage(string fileName)
    {
        // Goes through ResolveImagePath so the same traversal guard applies — this method takes a
        // filename from the database and turns it into a path it then deletes, which is exactly the
        // shape that must never accept "..".
        var path = ResolveImagePath(fileName);
        if (path is null) return;
        try
        {
            File.Delete(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning(ex, "Could not remove cached recipe image {File}.", fileName);
        }
    }

    public static string? ContentTypeFor(string fileName) => Path.GetExtension(fileName).ToLowerInvariant() switch
    {
        ".jpg" => "image/jpeg",
        ".png" => "image/png",
        ".webp" => "image/webp",
        ".gif" => "image/gif",
        _ => null,
    };

    private string ImageDirectory() =>
        string.IsNullOrWhiteSpace(_options.ImagePath)
            ? Path.Combine(_environment.ContentRootPath, "recipe-images")
            : _options.ImagePath;

    /// <summary>The extension for a sniffed media type, or null when the response is not an image.</summary>
    private static string? ExtensionFor(string? contentType) => contentType?.ToLowerInvariant() switch
    {
        "image/jpeg" or "image/jpg" => ".jpg",
        "image/png" => ".png",
        "image/webp" => ".webp",
        "image/gif" => ".gif",
        _ => null,
    };
}
