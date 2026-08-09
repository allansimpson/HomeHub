namespace HomeHub.Api.Pantry;

/// <summary>
/// A barcode the panel knows how to name (PANTRY_DATA_CONTRACT §1).
/// </summary>
/// <remarks>
/// <b>There is no bundled global catalogue and no third-party lookup.</b> The section ships with
/// this table empty, which is not a gap — DECISIONS PG4 makes an unmatched barcode a *first-class
/// row* rather than an error, and `NAME IT` writing a <see cref="CatalogueScope.Household"/> entry
/// is "the entire learning mechanism, and it is enough". A household names a tin once and every
/// later tin of the same thing resolves. <see cref="CatalogueScope.Global"/> exists so a seeded set
/// could be dropped in later without a migration; nothing writes it today.
/// </remarks>
public class ProductCatalogueEntry
{
    public int Id { get; set; }

    /// <summary>UPC-A / UPC-E / EAN-8 / EAN-13, normalised to 13 digits by <see cref="Barcodes"/>.</summary>
    public string Barcode { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public string? DefaultUnit { get; set; }

    public PantryLocation DefaultLocation { get; set; } = PantryLocation.Cupboard;

    /// <summary>Tracking class to default a newly-created item to. Named by whoever first named the pack.</summary>
    public TrackingClass DefaultTracking { get; set; } = TrackingClass.Counted;

    /// <summary>Pack weight in pounds, when the pack is sold by weight. Feeds the `about 6` guess.</summary>
    public decimal? PackSize { get; set; }

    /// <summary>Household entries win over global ones.</summary>
    public CatalogueScope Scope { get; set; } = CatalogueScope.Household;

    public DateTime CreatedUtc { get; set; }
}

/// <summary>
/// The join that makes 9b and 9f possible: a normalised recipe-ingredient name against a pantry item
/// (PANTRY_DATA_CONTRACT §1, DECISIONS PG6).
/// </summary>
/// <remarks>
/// Recipe lines say "2 boneless skinless chicken breasts"; the pantry says "Chicken breasts".
/// <see cref="IngredientNormaliser"/> reduces both to <c>chicken breast</c> and this table remembers
/// the answer. An ingredient with no alias resolves <see cref="StockStatus.NoMatch"/> — <b>never</b>
/// <see cref="StockStatus.Fine"/>. Silence about a line you cannot resolve is how the check starts
/// lying.
/// </remarks>
public class IngredientAlias
{
    public int Id { get; set; }

    /// <summary>Lowercased, singularised, notes stripped. See <see cref="IngredientNormaliser"/>.</summary>
    public string Alias { get; set; } = string.Empty;

    public int PantryItemId { get; set; }
    public PantryItem? Item { get; set; }

    /// <summary>Promoted to <see cref="AliasConfidence.Confirmed"/> when a human accepts or corrects it.</summary>
    public AliasConfidence Confidence { get; set; } = AliasConfidence.Seeded;

    public DateTime CreatedUtc { get; set; }
}
