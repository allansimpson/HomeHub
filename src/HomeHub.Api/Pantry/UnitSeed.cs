namespace HomeHub.Api.Pantry;

/// <summary>
/// The predefined units, and the spellings each one answers to.
/// </summary>
/// <remarks>
/// <b>Merging is limited to inflections, abbreviations and spellings of the same word.</b>
/// "ounces", "ounce", "oz" and "Oz." are one word written four ways, so they collapse. "tin" and
/// "can" are two words for one object and stay apart: the pantry stores the household's own words
/// (PANTRY_DATA_CONTRACT §1), and a row that reads <c>3 can</c> when somebody typed <c>tins</c> is
/// the panel correcting their English rather than tidying their data.
/// <para>
/// The one deliberate exception is the count family — <c>ea · each · ct · count · pc · pieces</c> —
/// which all collapse to <c>ea</c>. None of those is anybody's word for anything; they are all
/// notation for "one of these", and <see cref="UnitConversion"/> already treats them as identical,
/// so keeping six spellings apart would fragment the list without ever changing an answer.
/// </para>
/// <para>
/// Ordered by how often a kitchen reaches for them, not alphabetically. The picker shows the first
/// few before anything is typed, and "ea, tsp, tbsp, cup" is a better opening hand than
/// "bag, bottle, box, bunch".
/// </para>
/// </remarks>
public static class UnitSeed
{
    /// <summary>
    /// Fixed so the seed is deterministic. EF compares <c>HasData</c> against the last migration by
    /// value, and <c>DateTime.UtcNow</c> here would make every <c>dotnet ef</c> run produce a
    /// migration that updates thirty-one rows to say nothing new.
    /// </summary>
    public static readonly DateTime SeededUtc = new(2026, 8, 6, 0, 0, 0, DateTimeKind.Utc);

    /// <summary>Canonical form, the word in full, and every folded spelling it answers to.</summary>
    private static readonly (string Canonical, string Display, string[] Aliases)[] Table =
    [
        ("ea", "each", ["ea", "each", "ct", "cnt", "count", "pc", "pcs", "piece", "pieces"]),
        ("tsp", "teaspoons", ["tsp", "tsps", "teaspoon", "teaspoons"]),
        ("tbsp", "tablespoons", ["tbsp", "tbsps", "tbs", "tablespoon", "tablespoons"]),
        ("cup", "cups", ["cup", "cups"]),
        ("fl oz", "fluid ounces", ["fl oz", "floz", "fluid ounce", "fluid ounces"]),
        ("pint", "pints", ["pint", "pints", "pt", "pts"]),
        ("quart", "quarts", ["quart", "quarts", "qt", "qts"]),
        ("gallon", "gallons", ["gallon", "gallons", "gal", "gals"]),
        ("mL", "millilitres", ["ml", "mls", "milliliter", "milliliters", "millilitre", "millilitres", "cc"]),
        ("L", "litres", ["l", "ls", "liter", "liters", "litre", "litres"]),
        ("oz", "ounces", ["oz", "ozs", "ounce", "ounces"]),
        ("lb", "pounds", ["lb", "lbs", "pound", "pounds"]),
        ("g", "grams", ["g", "gs", "gram", "grams", "gm", "gms"]),
        ("kg", "kilograms", ["kg", "kgs", "kilogram", "kilograms", "kilo", "kilos"]),
        ("clove", "cloves", ["clove", "cloves"]),
        ("slice", "slices", ["slice", "slices"]),
        ("stick", "sticks", ["stick", "sticks"]),
        ("sprig", "sprigs", ["sprig", "sprigs"]),
        ("bunch", "bunches", ["bunch", "bunches"]),
        ("head", "heads", ["head", "heads"]),
        ("pinch", "pinches", ["pinch", "pinches"]),
        ("dash", "dashes", ["dash", "dashes"]),
        ("can", "cans", ["can", "cans"]),
        ("tin", "tins", ["tin", "tins"]),
        ("jar", "jars", ["jar", "jars"]),
        ("bottle", "bottles", ["bottle", "bottles"]),
        ("box", "boxes", ["box", "boxes"]),
        ("bag", "bags", ["bag", "bags"]),
        ("pack", "packs", ["pack", "packs", "pk", "pks", "pkg", "pkgs"]),
        ("packet", "packets", ["packet", "packets"]),
        ("loaf", "loaves", ["loaf", "loaves"]),
    ];

    /// <summary>
    /// The seeded unit rows, ids 1..n in table order.
    /// </summary>
    /// <remarks>
    /// Ids are positional rather than declared one by one because <c>HasData</c> turns a changed
    /// value into an <c>UpdateData</c> against a live row — so the rule is that entries may be
    /// <i>appended</i> and their aliases extended, but never reordered or removed. Reordering would
    /// rename thirty rows on every existing database.
    /// </remarks>
    public static IReadOnlyList<MeasurementUnit> Units { get; } = Table
        .Select((u, i) => new MeasurementUnit
        {
            Id = i + 1,
            Canonical = u.Canonical,
            DisplayName = u.Display,
            IsSeeded = true,
            SortOrder = i,
            CreatedUtc = SeededUtc,
        })
        .ToList();

    /// <summary>Every accepted spelling, including each canonical form's own.</summary>
    public static IReadOnlyList<MeasurementUnitAlias> Aliases { get; } = Table
        .SelectMany((u, i) => u.Aliases.Select(a => (UnitId: i + 1, Alias: a)))
        .Select((a, i) => new MeasurementUnitAlias { Id = i + 1, UnitId = a.UnitId, Alias = a.Alias })
        .ToList();
}
