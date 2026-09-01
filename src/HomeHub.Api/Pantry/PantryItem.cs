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
    /// Where in that location, in the household's own words — "middle shelf", "behind the pasta".
    /// Null until somebody says, which is most rows.
    /// </summary>
    /// <remarks>
    /// <b>This reverses the note that used to sit on <see cref="PantryLocation"/></b>, which held that
    /// per-shelf precision is "a level nobody maintains past week two" and that the only thing the
    /// panel does with a location is group the list and word a sentence. Design overruled it on
    /// 2026-09-01 with the case the old note did not answer: the three locations tell you the thing is
    /// in the cupboard, and this is the difference between that and being able to *find* it.
    ///
    /// The old objection is still true about *fixed vocabularies*, and that is why this is free text
    /// rather than an enum. It is also why nothing requires it: an unmaintained value renders as the
    /// bare location, which is exactly what the row said before, so a household that stops bothering
    /// loses nothing and is never nagged.
    /// </remarks>
    public string? Shelf { get; set; }

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
    /// <summary>Who saved this row's pack-size mapping, for "pack size saved by Eleanor, 3 Aug".</summary>
    /// <remarks>
    /// §2 requires the mapping and its provenance to be stated wherever the arithmetic depends on
    /// it. A mapping the household cannot see is a mapping it cannot correct — and this one silently
    /// changes what every recipe wanting that ingredient concludes.
    /// </remarks>
    public int? PackSizeByProfileId { get; set; }

    /// <summary>When that mapping was saved.</summary>
    public DateTime? PackSizeAtUtc { get; set; }

    /// <summary>
    /// A date the packet actually states (ADD_TO_PANTRY §6).
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>The one sanctioned exception to the expiry ban</b>, and it is narrow on purpose.
    /// <c>PANTRY_DATA_CONTRACT</c> §5 rules out expiry dates because nobody enters them and nothing
    /// can infer them reliably — a wrong date being worse than none. This field survives that
    /// reasoning by refusing everything the ban was actually about:
    /// </para>
    /// <list type="bullet">
    /// <item>Optional, and never blocks a save.</item>
    /// <item><b>Typed only from what the packet says</b>, or carried in by a scan or an order line.
    /// Never inferred from a shelf-life table, never guessed.</item>
    /// <item>One date per entry — four tins bought together share one, rather than becoming four
    /// rows.</item>
    /// <item><b>Never the subject of a notification, badge or counter.</b> It sorts; it does not
    /// warn.</item>
    /// </list>
    /// <para>
    /// Shelf-life assumptions remain a separate mechanism and are still what drives <i>use it or
    /// lose it</i>. A typed date takes precedence for that entry; its absence changes nothing.
    /// </para>
    /// </remarks>
    public DateOnly? GoodUntil { get; set; }

    /// <summary>Where <see cref="GoodUntil"/> came from — the guard against an inferred date.</summary>
    public GoodUntilSource? GoodUntilSource { get; set; }

    /// <summary>
    /// When this was opened, if it has been (KITCHEN_LOOP_ADDENDUM §4).
    /// </summary>
    /// <remarks>
    /// <b>Never inferred.</b> Opening is one tap and nothing else sets it: a deduction that empties a
    /// counted item does not open anything, and marking opened never changes a quantity. It exists
    /// because it is the one thing about freshness the panel can actually observe — the section
    /// refuses to store expiry dates it would have to guess (§7), and ranks by how long something
    /// has been open instead.
    /// </remarks>
    public DateTime? OpenedAt { get; set; }

    /// <summary>Who opened it. Null when nobody has, or when it predates the field.</summary>
    public int? OpenedByProfileId { get; set; }

    /// <summary>
    /// The night that produced this, for leftovers created by cooking (§5).
    /// </summary>
    /// <remarks>
    /// Provenance, not a link the loop depends on: a leftovers item is an ordinary
    /// <see cref="TrackingClass.Counted"/> row measured in portions, and the plan claims it the same
    /// way it claims a tin. This is what lets the receipt's undo find and remove it again.
    /// </remarks>
    public int? ProducedByPlanEntryId { get; set; }

    public bool IsArchived { get; set; }

    public DateTime CreatedUtc { get; set; }
    public DateTime UpdatedUtc { get; set; }

    /// <summary>Optimistic-concurrency token, same <c>?baseVersion=</c> convention as Meals.</summary>
    public int Version { get; set; } = 1;

    public List<PantryEvent> Events { get; } = [];
}
