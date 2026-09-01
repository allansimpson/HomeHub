namespace HomeHub.Api.Pantry;

/// <summary>Which of the three places a thing lives in — PANTRY_DATA_CONTRACT §1.</summary>
/// <remarks>
/// <b>This used to say the panel would never go finer, and it does now.</b> The old note held that
/// "top shelf of the door" is a level of precision nobody maintains past week two, and that the only
/// thing the panel does with a location is group the list and word a sentence. Design overruled that
/// on 2026-09-01: knowing a thing is in the cupboard is not the same as being able to find it.
///
/// What survives is the objection to a *fixed vocabulary*, which was the sound half — so the finer
/// place is free text on <see cref="PantryItem.Shelf"/>, never an enum. This type stays exactly three
/// values, because it is what the shelf switch, the grouping and "put 1 lb in the fridge" are built
/// on, and those genuinely do not want a fourth.
/// </remarks>
public enum PantryLocation
{
    Cupboard = 0,
    Fridge = 1,
    Freezer = 2,
}

/// <summary>
/// How much the panel claims to know about an item — the idea the whole section is arranged around
/// (README, "units do not reconcile").
/// </summary>
/// <remarks>
/// The pantry holds what you bought: a 2.5 lb pack, a jar, a bag. Recipes ask in cups and
/// tablespoons. No amount of parsing fixes that, so this enum is the design refusing to pretend it
/// has: each class states exactly how much arithmetic is honest for that item.
/// </remarks>
public enum TrackingClass
{
    /// <summary>Whole units visible at a glance — tins, boxes, chicken breasts. Exact arithmetic.</summary>
    Counted = 0,

    /// <summary>A container with an unknowable amount left. Moves one step: plenty → low → none.</summary>
    Estimated = 1,

    /// <summary>
    /// Staples nobody will ever keep accurate — oil, salt, pepper. Never deducted, never reported
    /// missing. Getting this confused with <see cref="EstimateState.None"/> is what would make the
    /// shortfall list ask you to buy salt (DECISIONS PG2).
    /// </summary>
    NotCounted = 2,
}

/// <summary>How much is left of an <see cref="TrackingClass.Estimated"/> item.</summary>
public enum EstimateState
{
    Plenty = 0,
    Low = 1,
    None = 2,
}

/// <summary>
/// What happened to an item. Every row in the ledger is one of these; nothing changes a
/// <see cref="PantryItem"/> without writing one.
/// </summary>
public enum PantryEventKind
{
    /// <summary>A barcode was scanned on a phone (9c).</summary>
    Scanned = 0,

    /// <summary>An order import was applied (9d).</summary>
    Imported = 1,

    /// <summary>Typed in on the panel (9a).</summary>
    TypedIn = 2,

    /// <summary>Ticked off the grocery list — the return trip (9e).</summary>
    CheckedOff = 3,

    /// <summary>Taken out by cooking a night confirmed eaten (9f).</summary>
    Deducted = 4,

    /// <summary>"We've got these — the panel's wrong" (9b), or an edit on the row sheet.</summary>
    Corrected = 5,

    MarkedLow = 6,
    MarkedOut = 7,

    /// <summary>
    /// A compensating event that reverses another. Undo never mutates history — see
    /// <see cref="PantryEvent.UndoneByEventId"/> for why that matters to <c>lastSeenAt</c>.
    /// </summary>
    Undone = 8,

    // New kinds take the next free values. These are persisted as integers, so an existing member's
    // number can never be reused or shifted — every stored row would silently change meaning.

    /// <summary>Cooking produced stock — leftovers going into the fridge (§5).</summary>
    Produced = 9,

    /// <summary>Opened, by one deliberate tap. Never inferred, and never changes a quantity (§4).</summary>
    MarkedOpened = 10,

    /// <summary>An opened thing finished, closing the window <see cref="MarkedOpened"/> began.</summary>
    MarkedFinished = 11,

    /// <summary>
    /// Put somewhere else — a different location, a different shelf, or both. Never changes a
    /// quantity.
    /// </summary>
    /// <remarks>
    /// Its own kind rather than a <see cref="Corrected"/> with a location on it, because the item
    /// sheet's `since 3 Aug` is "when did this last move", and a ledger that files a move as a
    /// correction cannot answer that without guessing which corrections happened to change a place.
    /// </remarks>
    Moved = 12,
}

/// <summary>What caused an event, so a receipt or a run list can be reversed as a unit.</summary>
public enum PantryEventSource
{
    PlanEntry = 0,
    OrderImport = 1,
    GroceryLine = 2,
    ScanRun = 3,
}

/// <summary>
/// The verdict on one recipe ingredient line at assign time (PANTRY_DATA_CONTRACT §2).
/// </summary>
/// <remarks>
/// Six values rather than a bool, because "we don't know" is the honest answer far more often than
/// either yes or no — and collapsing it into "fine" is precisely how the check would start lying
/// (DECISIONS PG6). 9b lists <see cref="Short"/>, <see cref="Gone"/>, <see cref="Unknown"/> and
/// <see cref="NoMatch"/>; <see cref="NotCounted"/> is named only in the tail line.
/// </remarks>
public enum StockStatus
{
    /// <summary>Enough of it, as far as the panel was told.</summary>
    Fine = 0,

    /// <summary>Counted, and the last count was below what the recipe asks.</summary>
    Short = 1,

    /// <summary>Believed gone — zero, or an estimate of <see cref="EstimateState.None"/>.</summary>
    Gone = 2,

    /// <summary>Matched an item, but the amount left cannot be compared to what's needed.</summary>
    Unknown = 3,

    /// <summary>A staple. Never a problem, never listed as one.</summary>
    NotCounted = 4,

    /// <summary>No pantry item answers to this ingredient at all. Listed, never silently "fine".</summary>
    NoMatch = 5,

    /// <summary>
    /// Wanted, present, and already spoken for by an earlier night (KITCHEN_LOOP_ADDENDUM §1).
    /// </summary>
    /// <remarks>
    /// Distinct from <see cref="Short"/> on purpose. "You have none" and "you have one and Saturday
    /// is having it" call for different answers — buy some, or move the night — and collapsing them
    /// into one word would hide the only fact that tells you which.
    /// </remarks>
    ClaimedAway = 6,
}

/// <summary>Why a line is on the grocery list — drives its section and its provenance line.</summary>
public enum GroceryLineSource
{
    /// <summary>Added from a night's shortfall. Carries the recipe and the date.</summary>
    Meal = 0,

    /// <summary>Typed on the panel or added in To Do.</summary>
    Hand = 1,

    /// <summary>Added because the pantry believes the item is low or gone.</summary>
    LowStock = 2,
}

/// <summary>How an order reached the panel. All three land on the same review screen (9d).</summary>
public enum OrderImportSource
{
    /// <summary>A forwarded order-confirmation email body.</summary>
    Email = 0,

    /// <summary>The store app's share sheet.</summary>
    Share = 1,

    /// <summary>A photo of a receipt. Needs OCR upstream — see <c>OrderImportParser</c>.</summary>
    Photo = 2,
}

public enum OrderImportStatus
{
    Pending = 0,
    Applied = 1,
    Discarded = 2,
}

/// <summary>How well one imported line was understood. Drives the three-cell tally on 9d.</summary>
public enum ImportLineConfidence
{
    /// <summary>Resolved to an item already in the pantry.</summary>
    Matched = 0,

    /// <summary>Understood, but nothing in the pantry answers to it yet.</summary>
    New = 1,

    /// <summary>
    /// A count derived from a pack weight — "about 6 chicken breasts" from `2.5LB PK`. The single
    /// most likely source of wrong data in the section, so it is marked in brass and says it is a
    /// guess in the same sentence (DECISIONS PG5).
    /// </summary>
    WeightGuess = 2,

    /// <summary>The raw string meant nothing. A first-class row, not an error.</summary>
    Unreadable = 3,
}

/// <summary>Whether a catalogue entry ships with the app or was named by this household.</summary>
public enum CatalogueScope
{
    Global = 0,

    /// <summary>Written by `NAME IT`. Wins over a global entry — this is the entire learning mechanism.</summary>
    Household = 1,
}

/// <summary>How confident the ingredient→pantry join is.</summary>
public enum AliasConfidence
{
    /// <summary>Guessed by the normaliser on first plausible match.</summary>
    Seeded = 0,

    /// <summary>A human accepted or corrected it.</summary>
    Confirmed = 1,
}

/// <summary>
/// How the household came to know one name means another (MATCHING_AND_ALIASES §5).
/// </summary>
/// <remarks>
/// Kept because M3 shows it: coverage attributed by source is what tells the household the thing is
/// being taught by shopping rather than by configuring — "most of it was earned by shopping, which
/// is the point". A bare percentage would not.
/// </remarks>
public enum AliasSource
{
    /// <summary>Shipped in the seeded dictionary — the ~1,200 names the app knows on day one.</summary>
    Seed = 0,

    /// <summary>Learned from a barcode somebody scanned.</summary>
    Scan = 1,

    /// <summary>Learned from a delivery line that was matched.</summary>
    OrderLine = 2,

    /// <summary>Learned from a substitution accepted with `SAME THING`.</summary>
    Substitution = 3,

    /// <summary>Sorted out by hand, one line at a time (M2).</summary>
    Manual = 4,
}

/// <summary>
/// Where a <see cref="PantryItem.GoodUntil"/> date came from (ADD_TO_PANTRY §6).
/// </summary>
/// <remarks>
/// Recorded rather than assumed because the whole exception rests on provenance: a date somebody
/// read off a packet is worth having, and one the app worked out for itself is exactly what the
/// expiry ban exists to prevent. There is deliberately no <c>Inferred</c> member — the type makes
/// the thing unrepresentable rather than merely discouraged.
/// </remarks>
public enum GoodUntilSource
{
    /// <summary>Read off the packet by a person.</summary>
    Typed = 0,

    /// <summary>Carried in by a barcode scan that happened to know it.</summary>
    Scanned = 1,

    /// <summary>Carried in on an order line.</summary>
    OrderLine = 2,
}
