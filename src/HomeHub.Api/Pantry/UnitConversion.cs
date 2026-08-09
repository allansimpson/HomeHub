namespace HomeHub.Api.Pantry;

/// <summary>
/// The small, hand-written table that says which recipe units can be compared to which pack units
/// (BUILD_ORDER, "still open" #4 — the design assumes this is small and hand-written, not inferred).
/// </summary>
/// <remarks>
/// <b>Almost nothing converts, and that is the point.</b> "4 tbsp" out of "a jar of capers" is not
/// arithmetic anyone can do, and the section's whole premise is refusing to pretend otherwise. This
/// table therefore covers exactly two honest cases:
/// <list type="bullet">
/// <item>Same dimension, fixed ratio — tsp/tbsp/cup, oz/lb, g/kg, ml/l. Real maths.</item>
/// <item>Countable things — "2 lemons" against "4 ea". A count is a count.</item>
/// </list>
/// Volume↔weight is deliberately absent: it depends on what the substance *is* (a cup of flour and
/// a cup of honey differ by more than double), and a density table is exactly the kind of confident
/// wrongness DECISIONS P9 forbids. A line this cannot convert degrades to a one-step estimate and
/// says so on the receipt, which is the documented behaviour rather than a shortfall.
/// <para>
/// Spellings here are the canonical ones <see cref="UnitSeed"/> stores, and every seeded unit that
/// <i>can</i> honestly be compared appears below. The two tables are separate on purpose — naming a
/// unit is not claiming it converts — but a seeded unit missing from here would degrade every line
/// that used it, silently, so they are kept in step.
/// </para>
/// </remarks>
public static class UnitConversion
{
    /// <summary>Units that mean "one of these", where the pack unit and the recipe unit are both counts.</summary>
    private static readonly HashSet<string> Countable = new(StringComparer.OrdinalIgnoreCase)
    {
        "ea", "each", "", "whole", "clove", "cloves", "slice", "slices", "stick", "sticks",
        "can", "cans", "tin", "tins", "box", "boxes", "jar", "jars", "bag", "bags",
        "packet", "packets", "pack", "packs", "bunch", "bunches", "head", "heads", "sprig", "sprigs",
        "bottle", "bottles", "loaf", "loaves",
    };

    /// <summary>
    /// Everything expressible against a base unit within its own dimension. Values are how many of
    /// the base unit one of these is.
    /// </summary>
    private static readonly Dictionary<string, (string Dimension, decimal InBase)> Scales =
        new(StringComparer.OrdinalIgnoreCase)
        {
            // Volume, base = ml. US customary — the household this was designed for shops in lb/oz.
            ["tsp"] = ("volume", 4.92892m),
            ["tbsp"] = ("volume", 14.7868m),
            ["fl oz"] = ("volume", 29.5735m),
            ["cup"] = ("volume", 236.588m),
            ["pint"] = ("volume", 473.176m),
            ["quart"] = ("volume", 946.353m),
            ["gallon"] = ("volume", 3785.41m),
            ["ml"] = ("volume", 1m),
            ["l"] = ("volume", 1000m),

            // Weight, base = g.
            ["g"] = ("weight", 1m),
            ["kg"] = ("weight", 1000m),
            ["oz"] = ("weight", 28.3495m),
            ["lb"] = ("weight", 453.592m),
        };

    /// <summary>
    /// How much of <paramref name="stockUnit"/> the recipe's <paramref name="quantity"/>
    /// <paramref name="recipeUnit"/> comes to, or null when the two cannot honestly be compared.
    /// </summary>
    /// <remarks>
    /// Null is a normal, frequent answer and callers must have a real behaviour for it — never a
    /// fallback that assumes 1:1. Treating "4 tbsp" as "4 jars" is how the pantry would report the
    /// capers gone after one dinner.
    /// </remarks>
    public static decimal? Convert(decimal quantity, string? recipeUnit, string? stockUnit)
    {
        var from = (recipeUnit ?? string.Empty).Trim();
        var to = (stockUnit ?? string.Empty).Trim();

        // Two counts: the units are labels, and one lemon is one lemon whatever the row calls them.
        if (Countable.Contains(from) && Countable.Contains(to)) return quantity;

        if (!Scales.TryGetValue(from, out var a) || !Scales.TryGetValue(to, out var b)) return null;
        if (a.Dimension != b.Dimension) return null;

        return quantity * a.InBase / b.InBase;
    }

    /// <summary>Whether a recipe line is expressed in something a count of packs could ever answer.</summary>
    public static bool IsCountable(string? unit) => Countable.Contains((unit ?? string.Empty).Trim());
}
