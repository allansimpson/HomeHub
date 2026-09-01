namespace HomeHub.Api.Pantry;

/// <summary>
/// Column lengths for the Pantry tables, in one place for the same reason as
/// <see cref="Meals.MealFieldLimits"/>: the DbContext configures the columns and the controllers
/// reject overlong input against the same numbers. Duplicating them is how a 400 becomes a 500.
/// </summary>
public static class PantryFieldLimits
{
    /// <summary>"Cento whole peeled tomatoes" — the household's own words, not a catalogue title.</summary>
    public const int ItemName = 200;

    /// <summary>"ea", "tins", "boxes", "lb". Display, not maths.</summary>
    /// <remarks>
    /// Shared with <see cref="MeasurementUnit.Canonical"/> and <see cref="MeasurementUnitAlias.Alias"/>
    /// on purpose: a unit that fits an item's column but not the lookup table's could be stored and
    /// never named again.
    /// </remarks>
    public const int Unit = 40;

    /// <summary>"fluid ounces", "tablespoons" — the unit said in full, for the picker's second line.</summary>
    public const int UnitDisplayName = 60;

    /// <summary>UPC/EAN normalised to 13 digits; the column has room for a checksum-suffixed variant.</summary>
    public const int Barcode = 32;

    /// <summary>A normalised ingredient name: lowercased, singularised, notes stripped.</summary>
    public const int Alias = 200;

    /// <summary>A grocery line as typed, or as it arrived from To Do.</summary>
    public const int GroceryText = 300;

    /// <summary>"Walmart", "Kroger" — a label on the import, never a code path (DECISIONS P4).</summary>
    public const int VendorLabel = 120;

    /// <summary>
    /// One line of an order exactly as it arrived — `GV HVY WHP CRM 32Z`. Kept forever and always
    /// displayed; it is how a wrong interpretation gets caught (§1).
    /// </summary>
    public const int RawText = 400;

    /// <summary>The whole forwarded email body / share payload, retained for re-parsing.</summary>
    public const int RawPayload = 200_000;

    /// <summary>Graph task id for the mirror.</summary>
    public const int TodoTaskId = 200;

    /// <summary>
    /// "middle shelf", "behind the pasta", "the bit above the microwave" — where in a location a
    /// thing actually is.
    /// </summary>
    /// <remarks>
    /// Free text, and short on purpose. Design set ~24 characters because it renders on one line
    /// after the location — `Cupboard · middle shelf` — and a phrase that wraps stops being a
    /// glanceable answer to "where exactly". Deliberately not a fixed vocabulary: the first real
    /// kitchen produces "behind the pasta" and "the bit above the microwave", which no enum was ever
    /// going to hold.
    /// </remarks>
    public const int Shelf = 24;

    /// <summary>"Produce", "Chilled" — the household's own word for a part of a shop.</summary>
    public const int AisleName = 80;

    /// <summary>"Tesco", "Butcher". A label the household types, not a vendor code.</summary>
    public const int StoreName = 80;

    public const int TodoListName = 200;
}
