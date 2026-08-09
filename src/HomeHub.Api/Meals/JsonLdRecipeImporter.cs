namespace HomeHub.Api.Meals;

using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml;

/// <summary>How much of a recipe actually arrived (meals-planning.md D10).</summary>
public enum ImportConfidence
{
    /// <summary>No <c>Recipe</c> node at all. Nothing is written.</summary>
    Empty = 0,

    /// <summary>Parsed something, but missing a title, two ingredients, or a step.</summary>
    Partial = 1,

    /// <summary>Title, at least two ingredients, at least one step.</summary>
    Complete = 2,
}

/// <summary>The importer's verdict on one page.</summary>
public sealed record RecipeImportResult(
    ImportConfidence Confidence,
    RecipeInput? Recipe,
    string? ImageUrl,
    /// <summary>Exactly what is missing, in words, when <see cref="Confidence"/> is not Complete.</summary>
    string? Reason);

/// <summary>
/// Reads schema.org <c>Recipe</c> JSON-LD out of a fetched page (meals-planning.md D2).
/// <para>
/// One format, one parser, no seam and no chain — publishers embed this so Google can render rich
/// results, which is a commercial motive to keep it correct. Microdata, RDFa, HTML heuristics and
/// LLM reading are all deliberately out of scope: they are the maintenance tail this avoids.
/// </para>
/// <para>
/// <b>What is given up, plainly:</b> sites publishing recipes only as microdata, or as prose, will
/// report that the page has no recipe data. Manual entry is the answer for those.
/// </para>
/// </summary>
public static partial class JsonLdRecipeImporter
{
    /// <summary>Every `application/ld+json` block in the document, in order.</summary>
    [GeneratedRegex(
        """<script[^>]*type\s*=\s*["']application/ld\+json["'][^>]*>(.*?)</script>""",
        RegexOptions.IgnoreCase | RegexOptions.Singleline | RegexOptions.CultureInvariant)]
    private static partial Regex LdJsonBlocks();

    [GeneratedRegex("<[^>]+>", RegexOptions.CultureInvariant)]
    private static partial Regex HtmlTag();

    public static RecipeImportResult Parse(string html, string sourceUrl)
    {
        var recipe = FindRecipeNode(html);
        if (recipe is null)
        {
            return new RecipeImportResult(
                ImportConfidence.Empty, null, null,
                "That page doesn't publish recipe data the panel can read. You can still type it in.");
        }

        var node = recipe.Value;
        var title = Text(node, "name");
        var ingredients = Strings(node, "recipeIngredient").Concat(Strings(node, "ingredients")).ToList();
        var steps = ReadInstructions(node);

        var input = new RecipeInput(
            Title: title ?? "Untitled recipe",
            Description: Clean(Text(node, "description")),
            SourceUrl: sourceUrl,
            SourceName: PublisherName(node) ?? HostLabel(sourceUrl),
            Servings: ReadYield(node),
            YieldText: RawYieldText(node),
            PrepMinutes: Minutes(node, "prepTime"),
            CookMinutes: Minutes(node, "cookTime"),
            TotalMinutes: Minutes(node, "totalTime"),
            Ingredients: ingredients
                .Select(line =>
                {
                    // Parsed at import time, not read time (D3). Failure here is null fields, which
                    // the detail screen already renders honestly as AS WRITTEN.
                    var parsed = IngredientParser.Parse(line);
                    return new RecipeIngredientInput(line, parsed.Quantity, parsed.Unit, parsed.Name, parsed.Note);
                })
                .ToList(),
            Steps: steps.Select(s => new RecipeStepInput(s.Text, s.Section)).ToList(),
            Tags: ReadCuisineTags(node).ToList());

        // D10: a successful parse is not a complete recipe. NYT Cooking emits a valid Recipe node
        // and still truncates the body for unauthenticated fetches, so the shape has to be scored
        // rather than assumed. A whitelist cannot catch this — the offending site is legitimately
        // "supported".
        var missing = new List<string>();
        if (string.IsNullOrWhiteSpace(title)) missing.Add("a title");
        if (ingredients.Count < 2) missing.Add(ingredients.Count == 0 ? "any ingredients" : "more than one ingredient");
        if (steps.Count == 0) missing.Add("any steps");

        var confidence = missing.Count == 0 ? ImportConfidence.Complete : ImportConfidence.Partial;
        var reason = missing.Count == 0
            ? null
            : $"The page didn't give {Join(missing)} — often a paywall. Add the rest by hand.";

        return new RecipeImportResult(confidence, input, ReadImage(node), reason);
    }

    private static string Join(List<string> parts) =>
        parts.Count == 1 ? parts[0] : string.Join(", ", parts[..^1]) + " or " + parts[^1];

    // ---- Locating the node ----

    /// <summary>
    /// The first `Recipe` node in the page.
    /// </summary>
    /// <remarks>
    /// Has to look in three places, because publishers use all three: the node can be top-level, an
    /// element of a top-level array, or buried in an `@graph` (which Yoast and most WordPress SEO
    /// plugins emit). `@type` itself may be a string or an array — a page can legitimately declare
    /// `["Recipe","NewsArticle"]`.
    /// </remarks>
    private static JsonElement? FindRecipeNode(string html)
    {
        foreach (Match block in LdJsonBlocks().Matches(html))
        {
            var json = block.Groups[1].Value.Trim();
            if (json.Length == 0) continue;

            JsonDocument doc;
            // One malformed block must not lose the others — pages often carry several, and only
            // one of them is the recipe.
            try { doc = JsonDocument.Parse(json, new JsonDocumentOptions { AllowTrailingCommas = true }) ; }
            catch (JsonException) { continue; }

            if (Search(doc.RootElement) is { } hit) return hit;
        }
        return null;
    }

    private static JsonElement? Search(JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                if (IsRecipe(element)) return element.Clone();
                if (element.TryGetProperty("@graph", out var graph)) return Search(graph);
                return null;
            case JsonValueKind.Array:
                foreach (var item in element.EnumerateArray())
                    if (Search(item) is { } hit) return hit;
                return null;
            default:
                return null;
        }
    }

    private static bool IsRecipe(JsonElement node)
    {
        if (!node.TryGetProperty("@type", out var type)) return false;
        return type.ValueKind switch
        {
            JsonValueKind.String => Matches(type.GetString()),
            JsonValueKind.Array => type.EnumerateArray().Any(t => Matches(t.GetString())),
            _ => false,
        };
        static bool Matches(string? value) => string.Equals(value, "Recipe", StringComparison.OrdinalIgnoreCase);
    }

    // ---- Field readers, each absorbing its documented variance ----

    private static string? Text(JsonElement node, string property) =>
        node.TryGetProperty(property, out var v) && v.ValueKind == JsonValueKind.String
            ? Clean(v.GetString())
            : null;

    private static IEnumerable<string> Strings(JsonElement node, string property)
    {
        if (!node.TryGetProperty(property, out var v)) yield break;
        if (v.ValueKind == JsonValueKind.String)
        {
            var one = Clean(v.GetString());
            if (one is not null) yield return one;
            yield break;
        }
        if (v.ValueKind != JsonValueKind.Array) yield break;
        foreach (var item in v.EnumerateArray())
        {
            var text = item.ValueKind == JsonValueKind.String ? Clean(item.GetString()) : null;
            if (text is not null) yield return text;
        }
    }

    /// <summary>
    /// `recipeInstructions` in every shape the doc lists: a plain string (sometimes one paragraph,
    /// sometimes newline-separated), an array of strings, an array of `HowToStep`, or an array of
    /// `HowToSection` each wrapping its own steps — which is where section headings come from.
    /// </summary>
    private static List<(string Text, string? Section)> ReadInstructions(JsonElement node)
    {
        var steps = new List<(string, string?)>();
        if (!node.TryGetProperty("recipeInstructions", out var v)) return steps;
        Collect(v, null, steps);
        return steps;

        static void Collect(JsonElement element, string? section, List<(string, string?)> into)
        {
            switch (element.ValueKind)
            {
                case JsonValueKind.String:
                    // A single blob is usually the whole method. Split on newlines so cook mode has
                    // steps to walk rather than one wall of text; a blob with none stays one step.
                    foreach (var line in (Clean(element.GetString()) ?? string.Empty)
                                 .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                    {
                        into.Add((line, section));
                    }
                    return;
                case JsonValueKind.Array:
                    foreach (var item in element.EnumerateArray()) Collect(item, section, into);
                    return;
                case JsonValueKind.Object:
                    var type = element.TryGetProperty("@type", out var t) ? t.GetString() : null;
                    if (string.Equals(type, "HowToSection", StringComparison.OrdinalIgnoreCase))
                    {
                        var heading = element.TryGetProperty("name", out var n) ? Clean(n.GetString()) : null;
                        if (element.TryGetProperty("itemListElement", out var items)) Collect(items, heading, into);
                        return;
                    }
                    // HowToStep, or an untyped object that still carries the text.
                    var text = element.TryGetProperty("text", out var tx) ? Clean(tx.GetString())
                        : element.TryGetProperty("name", out var nm) ? Clean(nm.GetString())
                        : null;
                    if (!string.IsNullOrWhiteSpace(text)) into.Add((text!, section));
                    return;
            }
        }
    }

    /// <summary>`recipeYield` as a number, when one can be read out of it.</summary>
    private static int? ReadYield(JsonElement node)
    {
        if (!node.TryGetProperty("recipeYield", out var v)) return null;
        var raw = v.ValueKind switch
        {
            // Invariant: this goes straight back through a number parse below, so a culture that
            // formats with non-ASCII digits would make the round trip fail on its own output.
            JsonValueKind.Number => v.TryGetInt32(out var n) ? n.ToString(CultureInfo.InvariantCulture) : null,
            JsonValueKind.String => v.GetString(),
            // An array is usually ["4", "4 servings"] — the first entry is the terse one.
            JsonValueKind.Array => v.EnumerateArray().FirstOrDefault().ValueKind == JsonValueKind.String
                ? v.EnumerateArray().First().GetString()
                : null,
            _ => null,
        };
        if (raw is null) return null;
        // "4 servings" → 4. A yield with no digits ("A dozen cookies") stays null and lives on in
        // YieldText instead, which is exactly what that field is for.
        var digits = System.Text.RegularExpressions.Regex.Match(raw, @"\d+");
        return digits.Success && int.TryParse(digits.Value, out var parsed) && parsed is > 0 and < 1000
            ? parsed
            : null;
    }

    private static string? RawYieldText(JsonElement node)
    {
        if (!node.TryGetProperty("recipeYield", out var v)) return null;
        return v.ValueKind switch
        {
            JsonValueKind.String => Clean(v.GetString()),
            JsonValueKind.Array => Clean(v.EnumerateArray()
                .Where(e => e.ValueKind == JsonValueKind.String)
                .Select(e => e.GetString())
                .LastOrDefault()),
            _ => null,
        };
    }

    /// <summary>ISO-8601 durations (`PT1H15M`) — the format schema.org mandates for these.</summary>
    private static int? Minutes(JsonElement node, string property)
    {
        var raw = Text(node, property);
        if (string.IsNullOrWhiteSpace(raw)) return null;
        try
        {
            var span = XmlConvert.ToTimeSpan(raw);
            var minutes = (int)span.TotalMinutes;
            // A day-long "total time" is a brine or a cure expressed as a duration; it is not a
            // cook time and would make the start-by arithmetic nonsense.
            return minutes is > 0 and < 60 * 24 ? minutes : null;
        }
        catch (FormatException)
        {
            return null;
        }
    }

    /// <summary>`image` as a string, an array, or an `ImageObject` with a `url`.</summary>
    private static string? ReadImage(JsonElement node)
    {
        if (!node.TryGetProperty("image", out var v)) return null;
        return Pick(v);

        static string? Pick(JsonElement element) => element.ValueKind switch
        {
            JsonValueKind.String => element.GetString(),
            JsonValueKind.Array => element.EnumerateArray().Select(Pick).FirstOrDefault(u => u is not null),
            JsonValueKind.Object => element.TryGetProperty("url", out var u) && u.ValueKind == JsonValueKind.String
                ? u.GetString()
                : null,
            _ => null,
        };
    }

    /// <summary>`author` or `publisher`, either of which may be a string or an object with a name.</summary>
    private static string? PublisherName(JsonElement node)
    {
        foreach (var property in (string[])["publisher", "author"])
        {
            if (!node.TryGetProperty(property, out var v)) continue;
            var name = v.ValueKind switch
            {
                JsonValueKind.String => Clean(v.GetString()),
                JsonValueKind.Object => v.TryGetProperty("name", out var n) ? Clean(n.GetString()) : null,
                JsonValueKind.Array => v.EnumerateArray()
                    .Select(e => e.ValueKind == JsonValueKind.Object && e.TryGetProperty("name", out var n)
                        ? Clean(n.GetString())
                        : e.ValueKind == JsonValueKind.String ? Clean(e.GetString()) : null)
                    .FirstOrDefault(x => x is not null),
                _ => null,
            };
            if (!string.IsNullOrWhiteSpace(name)) return name;
        }
        return null;
    }

    /// <summary>
    /// `recipeCuisine` normalised into the reserved `cuisine:` tag namespace
    /// (MEALS_DATA_CONTRACT §2), so "Italy" and "italian" cannot become two folder groups.
    /// </summary>
    private static IEnumerable<string> ReadCuisineTags(JsonElement node)
    {
        // Through the same normaliser the household's own edit uses. Two producers spelling a
        // cuisine differently would put "Middle Eastern" typed by hand and "Middle Eastern" read off
        // a page into two folder groups — the exact failure the namespace exists to prevent.
        foreach (var value in Strings(node, "recipeCuisine"))
        {
            if (Cuisines.Tag(value) is { } tag) yield return tag;
        }
    }

    private static string? HostLabel(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri)
            ? uri.Host.StartsWith("www.", StringComparison.OrdinalIgnoreCase) ? uri.Host[4..] : uri.Host
            : null;

    /// <summary>
    /// Strip embedded markup and decode entities. Recipe sites routinely put `<p>` and `&amp;`
    /// inside JSON-LD string values, and those would otherwise be rendered literally on the panel.
    /// </summary>
    private static string? Clean(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        // Tags become a space rather than nothing, so "<b>hot</b>butter" doesn't weld into one word.
        var text = System.Net.WebUtility.HtmlDecode(HtmlTag().Replace(value, " "));
        text = System.Text.RegularExpressions.Regex.Replace(text, @"[ \t]+", " ");
        // ...which leaves a gap before punctuation that closed a tag: "Fry <b>hot</b>." → "Fry hot .".
        text = System.Text.RegularExpressions.Regex.Replace(text, @"\s+([.,;:!?)\]])", "$1").Trim();
        return text.Length == 0 ? null : text;
    }
}
