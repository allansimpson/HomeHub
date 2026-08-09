namespace HomeHub.Api.Pantry;

using System.Globalization;
using System.Text.RegularExpressions;

/// <summary>One line of an order, as read off the payload before anything is matched.</summary>
public readonly record struct ParsedOrderLine(
    string RawText,
    string? Name,
    decimal? Quantity,
    string? Unit,
    decimal? PoundsPerPack,
    bool Unreadable);

/// <summary>
/// Turns a forwarded order email, a share payload or a receipt transcription into reviewable lines
/// (9d).
/// </summary>
/// <remarks>
/// <b>Vendor-agnostic on purpose</b> (DECISIONS P4). All three routes produce the same thing — a
/// list of abbreviated strings — so there is one parser and no vendor client anywhere in the
/// section. The vendor is a label on the import.
/// <para>
/// The governing rule is <see cref="Meals.IngredientParser"/>'s: <b>failure is an unreadable line,
/// not a wrong one</b>. Nothing here is written to the pantry until somebody presses `PUT n AWAY`
/// with the raw string in front of them, which is the whole reason <see cref="ParsedOrderLine.RawText"/>
/// is retained and always displayed.
/// </para>
/// <para>
/// <b>Photo receipts are accepted but not transcribed here.</b> OCR is a service this app does not
/// have; a photo import arrives with whatever text the caller supplies and, if that is empty, lands
/// on the documented unparseable state — tally `0 / 0 / n`, one action, no stack trace.
/// </para>
/// </remarks>
public static partial class OrderImportParser
{
    /// <summary>
    /// Store-brand prefixes worth dropping. Short, and only entries that are unambiguously a brand:
    /// dropping a word that turns out to be part of the product name is worse than leaving it, since
    /// the raw string is on screen either way.
    /// </summary>
    private static readonly HashSet<string> BrandPrefixes = new(StringComparer.OrdinalIgnoreCase)
    {
        "GV", "MM", "MRKTSD", "MARKETSIDE", "EQ", "SAMS", "KRO", "KROGER", "PC", "SB", "HEB",
        "365", "AH", "TJ", "WF",
    };

    /// <summary>
    /// Abbreviations grocers actually print. Hand-written and deliberately small — an expansion that
    /// guesses would produce a plausible wrong name, and a plausible wrong name is what gets tapped
    /// past without being read.
    /// </summary>
    private static readonly Dictionary<string, string> Expansions = new(StringComparer.OrdinalIgnoreCase)
    {
        ["HVY"] = "heavy", ["WHP"] = "whipping", ["CRM"] = "cream", ["CHKN"] = "chicken",
        ["BRST"] = "breast", ["BRSTS"] = "breasts", ["GRND"] = "ground", ["BF"] = "beef",
        ["BNLS"] = "boneless", ["SKNLS"] = "skinless",
        ["UNSLT"] = "unsalted", ["SLTD"] = "salted", ["BTR"] = "butter", ["MLK"] = "milk",
        ["CHZ"] = "cheese", ["CHDR"] = "cheddar", ["PARM"] = "parmesan", ["MOZZ"] = "mozzarella",
        ["YGRT"] = "yogurt", ["TOM"] = "tomato", ["TOMS"] = "tomatoes", ["POT"] = "potato",
        ["ONN"] = "onion", ["GRLC"] = "garlic", ["LMN"] = "lemon", ["LME"] = "lime",
        ["SPGHT"] = "spaghetti", ["SPAG"] = "spaghetti", ["PSTA"] = "pasta", ["FLR"] = "flour",
        ["SGR"] = "sugar", ["OL"] = "oil", ["OLV"] = "olive", ["VEG"] = "vegetable",
        ["WHT"] = "white", ["WHL"] = "whole", ["SLC"] = "sliced", ["SHRD"] = "shredded",
        ["FRZ"] = "frozen", ["FRSH"] = "fresh", ["ORG"] = "organic", ["LG"] = "large",
        ["SM"] = "small", ["MED"] = "medium", ["BNS"] = "beans", ["RCE"] = "rice",
        ["SLMN"] = "salmon", ["FLT"] = "fillet", ["FLTS"] = "fillets", ["EGGS"] = "eggs",
        ["BRD"] = "bread", ["CRML"] = "caramel", ["CHOC"] = "chocolate", ["VNLA"] = "vanilla",
        ["STK"] = "stock", ["BRTH"] = "broth", ["CPRS"] = "capers", ["PPR"] = "pepper",
    };

    /// <summary>
    /// Pure packaging notation, dropped entirely rather than expanded.
    /// </summary>
    /// <remarks>
    /// Expanding <c>PK</c> to "pack" made `MM CHKN BRST 2.5LB PK` come out as "Chicken breast pack",
    /// which is both a worse name and — because <see cref="PerPound"/> is keyed on the normalised
    /// product — enough to miss the weight-to-count lookup entirely, so the row silently reported
    /// 2.5 lb where it should have offered "about 6". None of these words ever forms part of a
    /// product's name, which is what makes dropping them safe.
    /// </remarks>
    private static readonly HashSet<string> PackNoise = new(StringComparer.OrdinalIgnoreCase)
    {
        "PK", "PKG", "PKGS", "CT", "CNT", "COUNT", "EA", "EACH",
    };

    /// <summary>
    /// Roughly how many of a thing come in a pound, for the `about 6` guess. Only entries a
    /// household would recognise as a count; everything else is left as a weight.
    /// </summary>
    /// <remarks>
    /// <b>This is the most likely source of wrong data in the section</b> (DECISIONS PG5), so every
    /// number it produces is marked <see cref="ImportLineConfidence.WeightGuess"/>, rendered in
    /// brass rather than body colour, and shown beside the sentence that says where it came from.
    /// It is never allowed to look like a fact.
    /// </remarks>
    private static readonly Dictionary<string, decimal> PerPound = new(StringComparer.OrdinalIgnoreCase)
    {
        ["chicken breast"] = 2.4m,
        ["chicken thigh"] = 4m,
        ["salmon fillet"] = 3m,
        ["pork chop"] = 2.5m,
        ["lemon"] = 4m,
        ["lime"] = 6m,
        ["onion"] = 3m,
        ["potato"] = 3m,
        ["tomato"] = 3m,
        ["apple"] = 3m,
    };

    /// <summary>Split a payload into lines and read each one.</summary>
    public static IReadOnlyList<ParsedOrderLine> Parse(string? payload)
    {
        if (string.IsNullOrWhiteSpace(payload)) return [];

        return payload
            .Split(['\n', '\r'], StringSplitOptions.RemoveEmptyEntries)
            .Select(l => l.Trim())
            .Where(IsProductish)
            .Select(ParseLine)
            .ToList();
    }

    /// <summary>
    /// Whether a line from an email body is plausibly a product rather than chrome.
    /// </summary>
    /// <remarks>
    /// Order emails are mostly not the order: greetings, totals, delivery windows, legal footers.
    /// Filtering here rather than showing everything keeps the review screen a review rather than a
    /// haystack — and a product line wrongly filtered still shows up as a shortfall later, where a
    /// footer wrongly kept becomes a pantry item called "Unsubscribe".
    /// </remarks>
    private static bool IsProductish(string line)
    {
        if (line.Length < 3 || line.Length > PantryFieldLimits.RawText) return false;
        if (!line.Any(char.IsLetter)) return false;
        return !Chrome().IsMatch(line);
    }

    private static ParsedOrderLine ParseLine(string raw)
    {
        var text = raw;

        // A leading "2x" / "2 x" / "Qty 2" is a count of packs, not part of the name.
        decimal? packs = null;
        var qty = LeadingCount().Match(text);
        if (qty.Success)
        {
            packs = decimal.Parse(qty.Groups["n"].Value, CultureInfo.InvariantCulture);
            text = text[qty.Length..];
        }

        // A trailing price is noise on a receipt line.
        text = TrailingPrice().Replace(text, " ");

        // Pack size: `32Z`, `32 OZ`, `2.5LB`, `1 LB`, `500G`.
        decimal? pounds = null;
        decimal? size = null;
        string? sizeUnit = null;
        var pack = PackSize().Match(text);
        if (pack.Success)
        {
            size = decimal.Parse(pack.Groups["n"].Value, CultureInfo.InvariantCulture);
            sizeUnit = pack.Groups["u"].Value.ToUpperInvariant() switch
            {
                "Z" or "OZ" => "oz",
                "LB" or "LBS" or "#" => "lb",
                "G" => "g",
                "KG" => "kg",
                "ML" => "ml",
                "L" => "l",
                _ => null,
            };
            pounds = sizeUnit switch
            {
                "lb" => size,
                "oz" => size / 16m,
                "g" => size / 453.592m,
                "kg" => size * 1000m / 453.592m,
                _ => null,
            };
            text = text.Remove(pack.Index, pack.Length);
        }

        var words = text
            .Split([' ', '\t', '-', '/'], StringSplitOptions.RemoveEmptyEntries)
            .Where(w => w.Any(char.IsLetter))
            .ToList();

        // Drop a leading store brand, but never the only word — `GV` alone is unreadable, not a
        // product called nothing.
        if (words.Count > 1 && BrandPrefixes.Contains(words[0])) words.RemoveAt(0);

        var expanded = words
            .Where(w => !PackNoise.Contains(w))
            .Select(w => Expansions.TryGetValue(w, out var full) ? full : w.ToLowerInvariant())
            .Where(w => w.Length > 1)
            .ToList();

        if (expanded.Count == 0) return new ParsedOrderLine(raw, null, null, null, null, Unreadable: true);

        // A line whose words are all still cryptic — no expansion hit, nothing over four letters —
        // is honestly unreadable. Better a `NAME IT` row than a pantry item called "hvy whp".
        var recognisable = expanded.Any(w => w.Length >= 5) || expanded.Any(Expansions.ContainsValue);
        if (!recognisable) return new ParsedOrderLine(raw, null, null, null, null, Unreadable: true);

        var name = Capitalise(string.Join(' ', expanded));

        // Sold by weight, and countable: offer a guess, clearly labelled as one upstream.
        var key = IngredientNormaliser.Normalise(name);
        if (pounds is { } lb && PerPound.TryGetValue(key, out var each))
        {
            var guess = Math.Max(1, Math.Round(lb * each, MidpointRounding.AwayFromZero));
            return new ParsedOrderLine(raw, name, guess * (packs ?? 1), "ea", lb, Unreadable: false);
        }

        if (size is { } s && sizeUnit is not null)
            return new ParsedOrderLine(raw, name, s * (packs ?? 1), sizeUnit, null, Unreadable: false);

        return new ParsedOrderLine(raw, name, packs ?? 1, "ea", null, Unreadable: false);
    }

    private static string Capitalise(string text) =>
        text.Length == 0 ? text : char.ToUpperInvariant(text[0]) + text[1..];

    /// <summary>Order-email furniture: totals, addresses, times, legal.</summary>
    [GeneratedRegex(
        @"^(subtotal|total|tax|tip|fee|delivery|order\s|thank|your order|questions|unsubscribe|" +
        @"view\s|track\s|https?:|www\.|\d{1,2}:\d{2}|.*@.*\..*|receipt|store\s|cashier|change due|" +
        @"payment|card ending|savings|you saved)",
        RegexOptions.IgnoreCase)]
    private static partial Regex Chrome();

    [GeneratedRegex(@"^\s*(?:qty\s*:?\s*)?(?<n>\d+(?:\.\d+)?)\s*(?:x\b|×)\s*", RegexOptions.IgnoreCase)]
    private static partial Regex LeadingCount();

    [GeneratedRegex(@"\s*[$£€]\s*\d+(?:[.,]\d{2})?\s*$")]
    private static partial Regex TrailingPrice();

    [GeneratedRegex(@"\b(?<n>\d+(?:\.\d+)?)\s*(?<u>Z|OZ|LBS?|KG|G|ML|L|#)\b", RegexOptions.IgnoreCase)]
    private static partial Regex PackSize();
}
