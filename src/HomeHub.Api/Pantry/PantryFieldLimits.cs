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
    public const int Unit = 40;

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

    public const int TodoListName = 200;
}
