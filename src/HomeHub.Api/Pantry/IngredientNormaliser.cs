namespace HomeHub.Api.Pantry;

using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

/// <summary>
/// Reduces an ingredient name or a pantry item name to the key both sides of the
/// <see cref="IngredientAlias"/> join agree on (DECISIONS PG6).
/// </summary>
/// <remarks>
/// Recipe lines say "2 boneless, skinless chicken breasts, cut into cutlets"; the shelf says
/// "Chicken breasts". Both have to reduce to <c>chicken breast</c> or the stock check is useless.
/// <para>
/// <b>Conservative on purpose</b>, the same rule <see cref="Meals.IngredientParser"/> follows: this
/// only ever *removes* material it is confident is noise. It does not stem, does not consult a
/// dictionary, and does not try to relate "scallion" to "spring onion" — a wrong join produces a
/// confident false claim about stock, which DECISIONS P9 rules out entirely. Anything it cannot
/// reduce to a known alias resolves <see cref="StockStatus.NoMatch"/>, which the UI words as a
/// question rather than a warning.
/// </para>
/// </remarks>
public static partial class IngredientNormaliser
{
    /// <summary>
    /// Words that describe how something was prepared or presented rather than what it is. Dropped
    /// so "freshly grated parmesan" and "parmesan" are the same shelf.
    /// </summary>
    /// <remarks>
    /// A fixed list, not a heuristic. Every entry here is a word that can be removed from any
    /// ingredient without changing which thing is meant — which is why "smoked" is absent (smoked
    /// paprika is not paprika) and so are "sweet", "hot", "dark" and "light".
    /// </remarks>
    private static readonly HashSet<string> Descriptors = new(StringComparer.OrdinalIgnoreCase)
    {
        "fresh", "freshly", "frozen", "chilled", "cold", "warm", "room", "temperature",
        "chopped", "minced", "diced", "sliced", "grated", "shredded", "crushed", "ground",
        "melted", "softened", "beaten", "whisked", "peeled", "seeded", "cored", "trimmed",
        "boneless", "skinless", "bone-in", "skin-on", "thinly", "roughly", "finely", "coarsely",
        "large", "medium", "small", "extra", "jumbo",
        "divided", "optional", "packed", "heaping", "level", "plus", "more", "taste",
        "good", "quality", "best", "organic", "free-range", "grass-fed",
        "cut", "into", "for", "serving", "garnish", "needed", "about", "approximately",
    };

    /// <summary>
    /// Irregular plurals worth knowing, because the suffix rules below get them wrong. Short and
    /// hand-written — a full inflection library is not worth a dependency for a join whose failure
    /// mode is a polite "the pantry doesn't know about this yet".
    /// </summary>
    private static readonly Dictionary<string, string> IrregularSingulars = new(StringComparer.OrdinalIgnoreCase)
    {
        ["leaves"] = "leaf", ["loaves"] = "loaf", ["halves"] = "half", ["knives"] = "knife",
        ["potatoes"] = "potato", ["tomatoes"] = "tomato", ["mangoes"] = "mango",
        ["anchovies"] = "anchovy", ["berries"] = "berry", ["cherries"] = "cherry",
        ["chilies"] = "chili", ["chillies"] = "chilli",
        ["molasses"] = "molasses", ["asparagus"] = "asparagus", ["couscous"] = "couscous",
        ["hummus"] = "hummus", ["swiss"] = "swiss", ["watercress"] = "watercress",
    };

    /// <summary>
    /// Normalise a name to its alias key. Returns an empty string when nothing recognisable is left,
    /// which callers must treat as "no match" rather than as a key.
    /// </summary>
    public static string Normalise(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return string.Empty;

        var text = raw.ToLowerInvariant();

        // Parentheticals are almost always pack sizes or asides — "(14 oz)", "(about 2 cups)".
        text = Parenthetical().Replace(text, " ");

        // Strip accents so "jalapeño" and "jalapeno" are one shelf.
        text = StripDiacritics(text);

        // Commas separate identity from preparation — "chicken breasts, cut into cutlets" — but not
        // always at the *first* one: "2 boneless, skinless chicken breasts, cut into cutlets" puts
        // two adjectives ahead of the thing itself. So each segment is reduced in turn and the first
        // that leaves anything standing wins.
        //
        // Cutting at the first comma instead reduced that line to nothing at all, and an empty key
        // reads downstream as "the pantry has never heard of chicken" — a total, silent failure of
        // the join, on one of the commonest ways a recipe writes its main ingredient.
        foreach (var segment in text.Split(','))
        {
            var reduced = ReduceSegment(segment);
            if (reduced.Length > 0) return reduced;
        }
        return string.Empty;
    }

    /// <summary>One comma-separated segment, reduced to its content words.</summary>
    private static string ReduceSegment(string segment)
    {
        // Anything that isn't a letter, a digit or an internal hyphen is a separator. Hyphens are
        // kept because "half-and-half" and "bone-in" are single words to a shopper.
        var text = NonWord().Replace(segment, " ");

        var words = text.Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .Where(w => !Descriptors.Contains(w))
            // A bare number left over from "2 chicken breasts" carries nothing once the quantity is
            // parsed separately.
            .Where(w => !w.All(char.IsDigit))
            .Select(Singularise)
            .Where(w => w.Length > 0)
            .ToList();

        return string.Join(' ', words).Trim();
    }

    /// <summary>
    /// Crude, deliberate singularisation: enough for "tomatoes"/"tomato" and "breasts"/"breast",
    /// and no more.
    /// </summary>
    internal static string Singularise(string word)
    {
        if (IrregularSingulars.TryGetValue(word, out var known)) return known;

        // Words of three letters or fewer are left alone — "eggs" is worth singularising, "oats"
        // and "peas" are not words anyone writes in the singular, and "gas"/"has" would be mangled.
        if (word.Length <= 3) return word;

        // "-ss" is never a plural ending (glass, cress, couscous). Guarded before the "-s" rule.
        if (word.EndsWith("ss", StringComparison.Ordinal)) return word;
        if (word.EndsWith("ies", StringComparison.Ordinal) && word.Length > 4) return word[..^3] + "y";
        if (word.EndsWith("ches", StringComparison.Ordinal) || word.EndsWith("shes", StringComparison.Ordinal))
            return word[..^2];
        if (word.EndsWith("oes", StringComparison.Ordinal)) return word[..^2];
        if (word.EndsWith('s') && !word.EndsWith("us", StringComparison.Ordinal))
            return word[..^1];
        return word;
    }

    private static string StripDiacritics(string text)
    {
        var decomposed = text.Normalize(NormalizationForm.FormD);
        var builder = new StringBuilder(decomposed.Length);
        foreach (var ch in decomposed)
        {
            if (CharUnicodeInfo.GetUnicodeCategory(ch) != UnicodeCategory.NonSpacingMark) builder.Append(ch);
        }
        return builder.ToString().Normalize(NormalizationForm.FormC);
    }

    [GeneratedRegex(@"\([^)]*\)")]
    private static partial Regex Parenthetical();

    [GeneratedRegex(@"[^a-z0-9\-]+")]
    private static partial Regex NonWord();
}
