namespace HomeHub.Api.Meals;

using System.Globalization;
using System.Text.RegularExpressions;

/// <summary>The parsed shape of one ingredient line. All-null means "could not read it".</summary>
public readonly record struct ParsedIngredient(decimal? Quantity, string? Unit, string? Name, string? Note);

/// <summary>
/// Best-effort parser for free-form ingredient lines (meals-planning.md D3).
/// <para>
/// schema.org gives ingredients as unstructured strings — <c>"2 tbsp olive oil, divided"</c> — so
/// scaling needs this. But <b>display never touches these fields</b>: the panel always renders
/// <c>RawText</c>. That is what makes a conservative parser the right call.
/// </para>
/// <para>
/// <b>The governing rule is that failure is null fields, not wrong fields.</b> A line this cannot
/// read cleanly comes back entirely null and is simply excluded from scaling — the UI already has
/// an honest state for that (<c>AS WRITTEN</c>). A guess would silently produce a wrong amount in
/// a scaled recipe, which is far worse than an unscaled line the cook can do in their head.
/// </para>
/// <para>Runs at import time, not read time, so it costs nothing per view and is inspectable in the database.</para>
/// </summary>
public static partial class IngredientParser
{
    /// <summary>
    /// Units worth recognising, mapped to a canonical short form. Deliberately a fixed vocabulary:
    /// anything not on this list leaves the unit null rather than treating the next word as one,
    /// which would turn "2 large eggs" into a quantity of 2 "large".
    /// </summary>
    private static readonly Dictionary<string, string> Units = new(StringComparer.OrdinalIgnoreCase)
    {
        ["tsp"] = "tsp", ["tsps"] = "tsp", ["teaspoon"] = "tsp", ["teaspoons"] = "tsp",
        ["tbsp"] = "tbsp", ["tbsps"] = "tbsp", ["tbs"] = "tbsp", ["tablespoon"] = "tbsp", ["tablespoons"] = "tbsp",
        ["cup"] = "cup", ["cups"] = "cup",
        ["oz"] = "oz", ["ounce"] = "oz", ["ounces"] = "oz",
        ["lb"] = "lb", ["lbs"] = "lb", ["pound"] = "lb", ["pounds"] = "lb",
        ["g"] = "g", ["gram"] = "g", ["grams"] = "g",
        ["kg"] = "kg", ["kilogram"] = "kg", ["kilograms"] = "kg",
        ["ml"] = "ml", ["milliliter"] = "ml", ["milliliters"] = "ml", ["millilitre"] = "ml", ["millilitres"] = "ml",
        ["l"] = "l", ["liter"] = "l", ["liters"] = "l", ["litre"] = "l", ["litres"] = "l",
        ["clove"] = "clove", ["cloves"] = "clove",
        ["can"] = "can", ["cans"] = "can",
        ["pinch"] = "pinch", ["pinches"] = "pinch",
        ["slice"] = "slice", ["slices"] = "slice",
        ["sprig"] = "sprig", ["sprigs"] = "sprig",
        ["stick"] = "stick", ["sticks"] = "stick",
        ["bunch"] = "bunch", ["bunches"] = "bunch",
        ["quart"] = "quart", ["quarts"] = "quart", ["qt"] = "quart",
        ["pint"] = "pint", ["pints"] = "pint",
    };

    /// <summary>Unicode vulgar fractions, which recipe sites emit far more often than "1/2".</summary>
    private static readonly Dictionary<char, decimal> Vulgar = new()
    {
        ['¼'] = 0.25m, ['½'] = 0.5m, ['¾'] = 0.75m,
        ['⅐'] = 1m / 7, ['⅑'] = 1m / 9, ['⅒'] = 0.1m,
        ['⅓'] = 1m / 3, ['⅔'] = 2m / 3,
        ['⅕'] = 0.2m, ['⅖'] = 0.4m, ['⅗'] = 0.6m, ['⅘'] = 0.8m,
        ['⅙'] = 1m / 6, ['⅚'] = 5m / 6,
        ['⅛'] = 0.125m, ['⅜'] = 0.375m, ['⅝'] = 0.625m, ['⅞'] = 0.875m,
    };

    /// <summary>
    /// The leading amount: `1 1/2`, `1½`, `½`, `1/2`, `2-3`, `2`.
    /// <para>
    /// Spelled as an ordered alternation rather than two optional groups. With optional groups the
    /// whole-number part matches greedily, so <c>1/2</c> is read as a whole <c>1</c> and the
    /// <c>/2</c> is left stranded — a half-cup silently becoming a cup, which is exactly the class
    /// of wrong-not-null failure D3 forbids. Longest form first so <c>1 1/2</c> cannot be taken as
    /// a bare <c>1</c>.
    /// </para>
    /// <para>
    /// A range takes the low value (D3) — "2–3 cloves" scales from 2 — and because `RawText` stays
    /// authoritative the cook still sees the range they were given.
    /// </para>
    /// </summary>
    [GeneratedRegex(
        """
        ^\s*(?:
            (?<whole>\d+)\s+(?<frac>\d+\s*/\s*\d+)
          | (?<frac>\d+\s*/\s*\d+)
          | (?<whole>\d+)\s*(?<frac>[¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])
          | (?<frac>[¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])
          | (?<whole>\d+)
        )\s*(?:[-–—]\s*(?:\d+(?:\.\d+)?|[¼½¾⅓⅔⅛⅜⅝⅞])\s*)?
        """,
        RegexOptions.CultureInvariant | RegexOptions.IgnorePatternWhitespace)]
    private static partial Regex LeadingAmount();

    [GeneratedRegex(@"^\s*(?<dec>\d+\.\d+)", RegexOptions.CultureInvariant)]
    private static partial Regex LeadingDecimal();

    /// <summary>
    /// Parse one line. Returns all-null when the line has no leading quantity or nothing usable
    /// after it — never a guess.
    /// </summary>
    public static ParsedIngredient Parse(string rawText)
    {
        if (string.IsNullOrWhiteSpace(rawText)) return default;
        var text = rawText.Trim();

        var (quantity, rest) = ReadQuantity(text);
        // No leading amount is the single clearest signal that this line is not the shape we handle
        // ("Salt and pepper to taste", "A handful of parsley"). Bail cleanly.
        if (quantity is null) return default;

        // Parenthetical container sizes — "1 (14 oz) can diced tomatoes" — are dropped *before* the
        // unit is read, not after. Read after, the parser sees "(14" where the unit should be, gives
        // up on the unit, and then hands "can diced tomatoes" back as the name: the real unit lost
        // and a stray word gained. RawText still shows the parenthetical, so nothing is hidden.
        var (unit, afterUnit) = ReadUnit(StripLeadingParenthetical(rest));

        var body = afterUnit.Trim();
        if (body.Length == 0) return default;

        var (name, note) = SplitNote(body);
        if (string.IsNullOrWhiteSpace(name)) return default;

        return new ParsedIngredient(quantity, unit, name, note);
    }

    // `Remainder`, not `Rest` — ValueTuple reserves that name for its own overflow field.
    private static (decimal? Quantity, string Remainder) ReadQuantity(string text)
    {
        // Decimals first: "0.5 cup" would otherwise have "0" taken as a whole number and ".5" left
        // stranded at the front of the name.
        var dec = LeadingDecimal().Match(text);
        if (dec.Success && decimal.TryParse(dec.Groups["dec"].Value, NumberStyles.Number, CultureInfo.InvariantCulture, out var d))
            return (d, text[dec.Length..]);

        var m = LeadingAmount().Match(text);
        if (!m.Success || (!m.Groups["whole"].Success && !m.Groups["frac"].Success)) return (null, text);

        decimal total = 0;
        if (m.Groups["whole"].Success) total += decimal.Parse(m.Groups["whole"].Value, CultureInfo.InvariantCulture);
        if (m.Groups["frac"].Success)
        {
            var frac = m.Groups["frac"].Value.Trim();
            if (frac.Length == 1 && Vulgar.TryGetValue(frac[0], out var v)) total += v;
            else
            {
                var parts = frac.Split('/');
                if (parts.Length == 2
                    && decimal.TryParse(parts[0].Trim(), out var num)
                    && decimal.TryParse(parts[1].Trim(), out var den)
                    && den != 0)
                {
                    total += num / den;
                }
                else return (null, text);
            }
        }

        return total > 0 ? (total, text[m.Length..]) : (null, text);
    }

    private static (string? Unit, string Remainder) ReadUnit(string text)
    {
        var trimmed = text.TrimStart();
        // A trailing period covers "tsp." and friends without adding entries to the vocabulary.
        var space = trimmed.IndexOfAny([' ', '\t']);
        var word = (space < 0 ? trimmed : trimmed[..space]).TrimEnd('.', ',');
        if (word.Length > 0 && Units.TryGetValue(word, out var canonical))
            return (canonical, space < 0 ? string.Empty : trimmed[space..]);

        // Not a unit we know — the whole remainder is the name. "2 large eggs" keeps "large eggs"
        // rather than inventing a unit called "large".
        return (null, trimmed);
    }

    private static string StripLeadingParenthetical(string text)
    {
        var trimmed = text.TrimStart();
        if (!trimmed.StartsWith('(')) return trimmed;
        var close = trimmed.IndexOf(')');
        return close < 0 ? trimmed : trimmed[(close + 1)..];
    }

    /// <summary>
    /// "olive oil, divided" → name "olive oil", note "divided". Splits on the first comma only:
    /// later commas belong to the note's own prose.
    /// </summary>
    private static (string Name, string? Note) SplitNote(string body)
    {
        var comma = body.IndexOf(',');
        if (comma < 0) return (body.Trim(), null);
        var name = body[..comma].Trim();
        var note = body[(comma + 1)..].Trim();
        return (name, note.Length == 0 ? null : note);
    }
}
