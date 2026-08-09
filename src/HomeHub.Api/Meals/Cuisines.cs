namespace HomeHub.Api.Meals;

/// <summary>
/// The reserved <c>cuisine:</c> tag namespace (MEALS_DATA_CONTRACT §2).
/// </summary>
/// <remarks>
/// Cuisine is a tag rather than a column because the folder groups by it exactly as it groups by
/// every other tag, and a column would have meant two grouping mechanisms that had to agree. What
/// the namespace buys instead is that one tag per recipe is special: it is the one the folder's
/// CUISINE sort reads, and the one the TAG sort has to exclude so that axis is not cuisines again.
/// <para>
/// <b>Two producers, one spelling.</b> The importer reads <c>recipeCuisine</c> off a page and the
/// household overrules it from the recipe screen; if those two normalised differently, "Middle
/// Eastern" typed by hand and "Middle Eastern" read off a page would be two groups in the folder,
/// which is the precise failure the namespace exists to prevent. The client normalises the same way
/// (<c>mealsPrefs.cuisineTag</c>) so the chip it renders and the tag the server stores agree.
/// </para>
/// </remarks>
public static class Cuisines
{
    public const string Prefix = "cuisine:";

    /// <summary>
    /// The storage form: lowercase, whitespace collapsed to single hyphens, prefixed.
    /// </summary>
    /// <returns>Null when there is nothing to store, or when the result would not fit the column.</returns>
    /// <remarks>
    /// Runs of whitespace collapse rather than mapping one-to-one — <c>middle  eastern</c> and
    /// <c>middle eastern</c> are the same cuisine typed with a stray key, and
    /// <c>cuisine:middle--eastern</c> would be a folder group of one for ever.
    /// </remarks>
    public static string? Tag(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return null;

        var slug = string.Join('-', name.Trim().ToLowerInvariant()
            .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

        if (slug.Length == 0 || slug.Length > MealFieldLimits.Tag - Prefix.Length) return null;
        return Prefix + slug;
    }

    /// <summary>Whether a tag is in the reserved namespace, however it was cased when written.</summary>
    public static bool IsCuisine(string tag) =>
        tag.StartsWith(Prefix, StringComparison.OrdinalIgnoreCase);
}
