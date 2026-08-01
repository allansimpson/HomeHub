namespace HomeHub.Api.Pantry;

/// <summary>
/// One thing the household names — <b>not one package</b> (PANTRY_DATA_CONTRACT §1).
/// </summary>
/// <remarks>
/// Buying a second bag of flour increments <see cref="Quantity"/> or resets
/// <see cref="EstimateState"/>; it does not create a row. A row per package would make the list
/// unreadable within a month and would still not answer the only question anyone asks it — "have we
/// got any?"
/// <para>
/// <b>There is no <c>LastSeenAt</c> column here</b>, though the contract's field list has one. It is
/// derived from <see cref="PantryEvent"/> instead, because Stage 0's acceptance is that
/// <c>lastSeenAt</c> is "read from the ledger, never written directly", and PANTRY_BEHAVIOURS §3
/// requires it to revert to the *previous* event's timestamp after an undo rather than to now. A
/// stored column would have to be recomputed from the ledger on every undo to stay honest — at
/// which point it is a cache of a query that costs nothing at household scale. See
/// <c>PantryLedger.LastSeenAsync</c>.
/// </para>
/// </remarks>
public class PantryItem
{
    public int Id { get; set; }

    /// <summary>Display name in the household's own words. "Butter, unsalted", not "BTR UNSLT 1LB".</summary>
    public string Name { get; set; } = string.Empty;

    public PantryLocation Location { get; set; } = PantryLocation.Cupboard;

    /// <summary>
    /// Chosen at creation (defaulted by the catalogue, editable) and drives everything: what the row
    /// shows, whether a deduction does arithmetic, and whether a shortfall can even be claimed.
    /// </summary>
    public TrackingClass Tracking { get; set; } = TrackingClass.Counted;

    /// <summary><see cref="TrackingClass.Counted"/> only. Null for the other two classes.</summary>
    public decimal? Quantity { get; set; }

    /// <summary>Display unit. Never used as a maths unit — see <see cref="UnitConversion"/> for the
    /// small, deliberate table that does convert.</summary>
    public string? Unit { get; set; }

    /// <summary><see cref="TrackingClass.Estimated"/> only.</summary>
    public EstimateState? EstimateState { get; set; }

    /// <summary>The barcode that resolved to this item, when one did. Not a key — two packs of the
    /// same thing are one row, and only the most recent barcode is remembered.</summary>
    public string? CatalogueRef { get; set; }

    /// <summary>Archived rather than deleted: the ledger references it (§2).</summary>
    public bool IsArchived { get; set; }

    public DateTime CreatedUtc { get; set; }
    public DateTime UpdatedUtc { get; set; }

    /// <summary>Optimistic-concurrency token, same <c>?baseVersion=</c> convention as Meals.</summary>
    public int Version { get; set; } = 1;

    public List<PantryEvent> Events { get; } = [];
}
