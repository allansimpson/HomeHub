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

    /// <summary>
    /// <see cref="TrackingClass.Counted"/> only. Null for the other two classes.
    /// </summary>
    /// <remarks>
    /// <b>What this counts depends on <see cref="PackSize"/>.</b> With a pack size it is a count of
    /// packages — five yogurt containers — and with none it is an amount in <see cref="Unit"/>, as it
    /// always was. <see cref="PantryAmounts"/> is the only thing that should ever read the two
    /// together, because getting the pairing wrong is how "five containers" becomes "five ounces".
    /// </remarks>
    public decimal? Quantity { get; set; }

    /// <summary>Display unit. Never used as a maths unit — see <see cref="UnitConversion"/> for the
    /// small, deliberate table that does convert.</summary>
    public string? Unit { get; set; }

    /// <summary>
    /// How much is in one package, when the household buys this thing by the package.
    /// </summary>
    /// <remarks>
    /// <b>The distinction this exists for is "3 oz" versus "five of them".</b> Without it the two
    /// facts had to share one number: a 3 oz yogurt pot scanned five times either became "15 oz",
    /// which nobody can look at a shelf and check, or five rows saying 3 oz, which is the same shelf
    /// listed five times. Held apart, the row says <c>3 oz ×5</c> — the size is part of what the
    /// thing *is*, and the count is how many are there.
    /// <para>
    /// Null is the ordinary case and means the item is not packaged into anything: loose lemons, a
    /// bag of flour measured in grams. Then <see cref="Quantity"/> is an amount in
    /// <see cref="Unit"/> and nothing here applies.
    /// </para>
    /// <para>
    /// It is also <b>part of the row's identity</b>. Two sizes of the same product are two things to
    /// buy, two things to run out of, and two rows — which is why the scan path matches on it and
    /// not on the name alone.
    /// </para>
    /// </remarks>
    public decimal? PackSize { get; set; }

    /// <summary>What <see cref="PackSize"/> is measured in — the <c>oz</c> in "3 oz". Canonical.</summary>
    /// <remarks>
    /// This, not <see cref="Unit"/>, is the unit a recipe line is compared against on a packed item:
    /// <see cref="Unit"/> there names the container ("container", "tin"), and comparing "4 oz" to a
    /// count of tins is the arithmetic <see cref="UnitConversion"/> refuses to do.
    /// </remarks>
    public string? PackUnit { get; set; }

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
