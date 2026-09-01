namespace HomeHub.Api.Pantry;

/// <summary>
/// Wire shapes for the Pantry. Enums cross as names, and every quantity that crosses is paired with
/// the date it was last observed — PANTRY_BEHAVIOURS §9 makes that a rule with teeth: <b>any string
/// that asserts a quantity without a date is a bug</b>, so the contract makes it awkward to write
/// one by never shipping the number on its own.
/// </summary>
public record PantryItemDto(
    int Id,
    string Name,
    string Location,
    string Tracking,
    /// <summary>A count of packages when <see cref="PackSize"/> is set; an amount otherwise.</summary>
    decimal? Quantity,
    string? Unit,
    string? EstimateState,
    /// <summary>How much is in one package — the `3 oz` in `3 oz ×5`. Null on a loose item.</summary>
    decimal? PackSize,
    /// <summary>What the pack size is measured in. Canonical, same table as every other unit.</summary>
    string? PackUnit,
    /// <summary>Null means never seen. The row says so rather than guessing from CreatedUtc.</summary>
    DateTime? LastSeenAtUtc,
    string? LastSeenByName,
    string? CatalogueRef,
    bool IsArchived,
    int Version,
    /// <summary>
    /// When it was opened, if it has been — the `OPEN 5 D` label (KITCHEN_LOOP_ADDENDUM §4).
    /// </summary>
    /// <remarks>
    /// Null is the ordinary case and means "not opened", not "unknown". Nothing infers it: this is
    /// the observable fact the section ranks freshness by, precisely because it refuses to store
    /// expiry dates it would have to guess.
    /// </remarks>
    DateTime? OpenedAtUtc = null,
    /// <summary>A date the packet stated, if one did. Sorts; never warns (ADD_TO_PANTRY §6).</summary>
    DateOnly? GoodUntil = null,
    /// <summary>Where in the location — "middle shelf". Null on most rows, and that is not a gap.</summary>
    string? Shelf = null,
    /// <summary>
    /// When it was last put where it is. The item sheet's `since 3 Aug`.
    /// </summary>
    /// <remarks>
    /// The last <see cref="PantryEventKind.Moved"/>, or the day it was added when it has never moved.
    /// Design chose that fallback over an empty line because the sentence reads the same either way
    /// and stays true: a thing that arrived in the cupboard in June has been there since June.
    /// </remarks>
    DateTime? InPlaceSinceUtc = null,
    /// <summary>
    /// How many of the last four sightings found it where it is now, and how many there were.
    /// </summary>
    /// <remarks>
    /// The `4 of the last 4` under `Usually kept here`. Null — not zero, and not `1 of 1` — when
    /// there is only one sighting: the line is a confidence signal, and a single look is not
    /// confidence. Sightings rather than moves, because a jar that has never moved is exactly the one
    /// you are most certain about, and counting moves would leave it blank.
    /// </remarks>
    int? KeptHereCount = null,
    int? KeptHereOf = null);

/// <summary>
/// Everything 9a renders in one response: the list, the hedged tally, and who last touched it.
/// </summary>
public record PantryListDto(
    IReadOnlyList<PantryItemDto> Items,
    /// <summary>Non-archived count. The tally's first clause.</summary>
    int Total,
    /// <summary>Counted-low plus estimated-low. "4 PROBABLY LOW" — never "4 low".</summary>
    int ProbablyLow,
    /// <summary>Zero counts and `None` estimates. Omitted from the tally at zero.</summary>
    int ProbablyOut,
    /// <summary>Who last wrote anything, for "Last touched Tuesday by Eleanor". Null on an empty pantry.</summary>
    string? LastTouchedByName,
    DateTime? LastTouchedAtUtc,
    /// <summary>Imports left <c>Pending</c> — the waiting-order row above the list (9d).</summary>
    IReadOnlyList<PendingImportDto> PendingImports);

public record PendingImportDto(int Id, string? VendorLabel, DateTime? DeliveredAtUtc, int LineCount);

// ---- units ----

/// <summary>
/// One unit, with every spelling it answers to.
/// </summary>
/// <remarks>
/// The aliases cross the wire on purpose. The panel's unit field has to say "ounces" resolves to
/// <c>oz</c> <i>while somebody is typing it</i>, and a round trip per keystroke to answer a question
/// about a thirty-row table is a field that lags behind the thumb. The whole list is a few hundred
/// bytes, fetched once.
/// </remarks>
public record MeasurementUnitDto(
    string Canonical,
    /// <summary>The word in full, for the picker's second line. Null on units the household typed.</summary>
    string? DisplayName,
    IReadOnlyList<string> Aliases,
    /// <summary>False for anything somebody introduced by typing it — those sort after the rest.</summary>
    bool IsSeeded);

/// <summary>Create or amend an item by hand. Quantity is applied through the ledger, never assigned.</summary>
public record PantryItemInput(
    string Name,
    string Location,
    string Tracking,
    decimal? Quantity,
    string? Unit,
    string? EstimateState,
    int? ProfileId,
    /// <summary>
    /// How much is in one package — "5 containers of 3 oz each".
    /// </summary>
    /// <remarks>
    /// Optional and trailing because most of a pantry is not packaged: loose lemons and a bag of
    /// flour measured in grams have no pack size, and <see cref="Quantity"/> is then an amount in
    /// <see cref="Unit"/> exactly as it always was. Supplying it switches the row over — the count
    /// becomes a count of packages and the row reads `3 oz ×5`.
    /// <para>
    /// Null and zero both mean "not packaged". Zero arrives from a stepper that can be wound down
    /// past one, and a pack of nothing is not a distinct state worth having.
    /// </para>
    /// </remarks>
    decimal? PackSize = null,
    string? PackUnit = null,
    /// <summary>
    /// The pack's barcode, when one is in hand.
    /// </summary>
    /// <remarks>
    /// <b>A barcode sticks to the product wherever it is supplied.</b> The scan screen is not the
    /// only place one turns up: a pack whose barcode the outside lookup could not name gets typed
    /// in by hand, and the code the phone read is the most valuable thing about that entry — it is
    /// what makes the *second* pack resolve without asking. Supplying it here writes both
    /// <see cref="PantryItem.CatalogueRef"/> and a household <see cref="ProductCatalogueEntry"/>,
    /// which is the same learning gesture <c>NAME IT</c> performs.
    /// <para>Optional and trailing: most hand entries are loose produce with no barcode at all.</para>
    /// </remarks>
    string? Barcode = null,
    /// <summary>The symbology, for the ambiguous 8-digit case. Same meaning as on a scan.</summary>
    string? BarcodeFormat = null,
    /// <summary>
    /// A date the packet states (ADD_TO_PANTRY §6). Optional, never inferred, never notified.
    /// </summary>
    DateOnly? GoodUntil = null,
    /// <summary>
    /// Where in the location, in the household's own words. Free text, ≤24 characters.
    /// </summary>
    /// <remarks>
    /// <b>Optional and trailing</b>, for the same reason <see cref="PackSize"/> is: most writers of
    /// this shape have no opinion about shelves. A scan and a delivery line PATCH the same record,
    /// and an omitted value therefore leaves the stored one alone — treating absence as "clear it"
    /// would have the pantry quietly forget where things are on every restock. An explicit empty
    /// string clears it, the same shape as <c>Barcode</c>.
    /// </remarks>
    string? Shelf = null);

/// <summary>One row of an item's history, for the row sheet and the run list.</summary>
public record PantryEventDto(
    int Id,
    int PantryItemId,
    string Kind,
    decimal? Delta,
    decimal? ResultingQuantity,
    string? ResultingState,
    DateTime AtUtc,
    string? ByName,
    bool Undone,
    /// <summary>
    /// What caused it, named — the dish a deduction cooked, the vendor a delivery came from.
    /// </summary>
    /// <remarks>
    /// The item sheet reads `One used — Piccata` and `Tesco order` off this (PANTRY_SHELVES §2).
    /// It is the difference between a history that says a tin left the shelf and one that says why:
    /// "one used" invites the question the row exists to answer, and `SourceKind`/`SourceId` have
    /// always known it. Null wherever the event had no cause worth naming — a hand correction is
    /// caused by the person, who is already in <see cref="ByName"/>.
    /// </remarks>
    string? SourceLabel = null);

// ---- 9c · scan ----

/// <summary>
/// One scan. Idempotent on <see cref="ScanRunId"/> + <see cref="Sequence"/> so two phones unpacking
/// the same delivery both add, and a retried request does not (DECISIONS PG7).
/// </summary>
public record ScanInput(
    string Barcode,
    /// <summary>The symbology the browser's BarcodeDetector reported, for the ambiguous 8-digit case.</summary>
    string? Format,
    decimal Delta,
    string? Location,
    Guid ScanRunId,
    int Sequence,
    int? ProfileId);

/// <summary>
/// The answer to a scan. An unmatched barcode is <b>not an error</b> — <see cref="Matched"/> false
/// with a null item is the first-class "not in the catalogue" row (DECISIONS PG4).
/// </summary>
public record ScanResultDto(
    bool Matched,
    string Barcode,
    PantryItemDto? Item,
    int? EventId,
    /// <summary>
    /// What an outside catalogue thinks this is, when one was asked and answered. Present only
    /// alongside <see cref="Matched"/> false: it pre-fills `NAME IT`, and nothing more. Null
    /// whenever the lookup is off, the barcode is unknown, or the service could not be reached —
    /// all of which leave the screen exactly as the handoff specified.
    /// </summary>
    ProductSuggestionDto? Suggestion = null);

/// <summary>
/// A suggested identity for an unknown barcode.
/// </summary>
/// <remarks>
/// <see cref="Source"/> is not decoration. The pantry stores the household's own words, and a name
/// that came from a stranger's database has to say so while somebody decides whether to keep it —
/// the same hedging discipline as every dated quantity in this section.
/// </remarks>
public record ProductSuggestionDto(
    string Name,
    string? Brand,
    string? Unit,
    decimal? PackSize,
    string Source);

/// <summary>`NAME IT` — writes a household catalogue entry so the next identical pack resolves.</summary>
public record CatalogueInput(
    string Barcode,
    string? Format,
    string Name,
    string? Unit,
    string Location,
    string Tracking,
    decimal? PackSize,
    int? ProfileId);

// ---- 9b · the stock check ----

/// <summary>
/// The verdict on a night, computed server-side because the aliases live there
/// (PANTRY_DATA_CONTRACT §2).
/// </summary>
public record StockCheckDto(
    int RecipeId,
    string RecipeTitle,
    int Servings,
    IReadOnlyList<StockCheckLineDto> Lines,
    /// <summary>`3 OF 9 LINES` — flagged over total ingredient lines.</summary>
    int FlaggedCount,
    int TotalLines,
    /// <summary>Staples named in the tail line ("two of them — oil, salt — aren't counted at all").</summary>
    IReadOnlyList<string> NotCountedNames,
    /// <summary>
    /// The weekday deliveries usually land on, for "the delivery lands Thursday". Null with fewer
    /// than three imports on record — §3 says omit the clause entirely rather than guess.
    /// </summary>
    string? UsualDeliveryWeekday);

public record StockCheckLineDto(
    int IngredientId,
    string Name,
    /// <summary>What the recipe asks for at the chosen servings, as written — `4 tbsp`, `6`.</summary>
    string? Needed,
    string Status,
    int? PantryItemId,
    decimal? LastSeenQuantity,
    string? LastSeenUnit,
    string? LastSeenState,
    DateTime? LastSeenAtUtc,
    /// <summary>
    /// The earlier night that already spoke for this item, when one has (KITCHEN_LOOP_ADDENDUM §1).
    /// Null when nothing earlier wants it. Names the first claimant so the row can say which night.
    /// </summary>
    int? ClaimedByEntryId = null,
    /// <summary>How much the earlier nights hold, in the item's own measure unit.</summary>
    decimal? ClaimedQuantity = null);

/// <summary>"We've got these — the panel's wrong": mark every listed item seen today.</summary>
public record CorrectStockInput(IReadOnlyList<CorrectStockLine> Lines, int? ProfileId);

public record CorrectStockLine(int PantryItemId, decimal? AtLeast);

// ---- 9f · the receipt ----

/// <summary>
/// What came off the shelves, already applied. <b>The ticks on 9f are undo, not consent</b> — the
/// deduction happened when the night was confirmed, and this screen is the receipt.
/// </summary>
public record DeductionReceiptDto(
    int PlanEntryId,
    string DishName,
    int Servings,
    DateOnly Date,
    IReadOnlyList<ReceiptLineDto> Counted,
    IReadOnlyList<ReceiptLineDto> Estimated,
    /// <summary>Staples, named but untouched. `LEFT ALONE`.</summary>
    IReadOnlyList<string> LeftAlone,
    /// <summary>Items this deduction took to zero — the footer's offer to add them to the list.</summary>
    IReadOnlyList<int> HitNone,
    /// <summary>
    /// What the night left over, when it left anything (KITCHEN_LOOP_ADDENDUM §5). Null when
    /// everyone ate, which is the common case and needs no card.
    /// </summary>
    ProducedSuggestionDto? Produced = null,
    /// <summary>
    /// Who confirmed the night, and when — C3's `Written by Aiden · just now`.
    /// </summary>
    /// <remarks>
    /// PANTRY_SHELVES §2 makes naming who and how a rule for every event, and this is the one
    /// operation that moves the most stock at once. A wrong number is arguable when somebody's name
    /// is on it and merely annoying when it is not. Null before anyone is signed in.
    /// </remarks>
    string? WrittenByName = null,
    DateTime? WrittenAtUtc = null);

/// <summary>
/// The leftovers a night produced, offered rather than assumed (C3's `AND WHAT'S LEFT OVER`).
/// </summary>
/// <remarks>
/// <see cref="SuggestedPortions"/> is <b>a guess and is labelled one</b> on the panel. Three answers
/// and no keypad: the number is inferred from how many sat down, which nobody promised was exact.
/// </remarks>
public record ProducedSuggestionDto(
    /// <summary>"Leftover Piccata" — the dish, said the way the fridge will need to read it.</summary>
    string SuggestedName,
    /// <summary>Servings cooked minus portions eaten.</summary>
    int SuggestedPortions,
    /// <summary>Where it would go by default. Fridge; the freezer is the other button.</summary>
    string Location);

/// <summary>
/// What the household chose to do with the leftovers — <c>Fridge</c>, <c>Freezer</c> or
/// <c>None</c>.
/// </summary>
public record ProducedDecisionInput(string Decision, int? Portions = null, int? ProfileId = null);

public record ReceiptLineDto(
    int EventId,
    int PantryItemId,
    string Name,
    /// <summary>The count before, for the `6 → none` arithmetic. Null for an estimated line.</summary>
    decimal? From,
    decimal? To,
    string? ResultingState,
    /// <summary>"4 tbsp out of a jar — marked low", or the note explaining a degraded deduction.</summary>
    string? Note,
    bool Undone);

// ---- 9e · grocery ----

public record GroceryLineDto(
    int Id,
    string Text,
    decimal? Quantity,
    string? Unit,
    int? PantryItemId,
    string SourceKind,
    IReadOnlyList<GroceryProvenanceDto> Provenance,
    DateTime? CheckedAtUtc,
    /// <summary>"Put 1 lb in the fridge" — the return trip, shown in place of provenance once ticked.</summary>
    string? ReturnTrip,
    int Version,
    /// <summary>Aisle, for grouping in the shop. Null sorts last under ELSEWHERE.</summary>
    string? Aisle = null,
    /// <summary>Shop, when the line is meant for a particular one.</summary>
    string? Store = null);

public record GroceryProvenanceDto(string Label, DateOnly? ForDate);

public record GroceryInput(
    string Text,
    decimal? Quantity,
    string? Unit,
    int? PantryItemId,
    string? SourceKind,
    int? SourceRecipeId,
    string? SourceRecipeTitle,
    DateOnly? SourceDate,
    int? ProfileId,
    /// <summary>Which aisle it falls in, for the shop's grouping (KITCHEN_LOOP_ADDENDUM §6).</summary>
    string? Aisle = null,
    /// <summary>Which shop it is meant for. Null means "whoever is out" — the common case.</summary>
    string? Store = null);

/// <summary>A batch, for 9b's `ADD THE THREE TO THE GROCERY LIST`. Merges per §1.</summary>
public record GroceryBatchInput(IReadOnlyList<GroceryInput> Lines);

public record GroceryListDto(
    IReadOnlyList<GroceryLineDto> Lines,
    int OpenCount,
    MirrorStatusDto Mirror);

/// <summary>
/// The permanent strip on 9e. <b>Never a toast</b> (DECISIONS PG8) — direction and age, always,
/// because a mirror nobody can see is a mirror nobody trusts.
/// </summary>
public record MirrorStatusDto(
    /// <summary>Off · Healthy · Failing · SignInExpired. Four states, all of them supported.</summary>
    string State,
    string? ListName,
    string? OwnerName,
    DateTime? LastSyncedUtc,
    DateTime? LastAttemptUtc,
    /// <summary>How many local changes are waiting. "3 changes will go up when it's back."</summary>
    int QueuedCount,
    string? Message);

public record MirrorSettingsInput(string? TodoListId, string? TodoListName, int? OwnerProfileId);

// ---- 9d · imports ----

/// <summary>
/// A payload that arrived. All three sources land here (DECISIONS P4) — there is no vendor client.
/// </summary>
public record OrderImportInput(string Source, string? VendorLabel, string RawPayload, DateTime? DeliveredAtUtc);

public record OrderImportDto(
    int Id,
    string Source,
    string? VendorLabel,
    DateTime? DeliveredAtUtc,
    string Status,
    IReadOnlyList<OrderImportLineDto> Lines,
    int MatchedCount,
    int NewCount,
    int UnreadableCount,
    /// <summary>Set on a 409: who already put it away, so the second person is told rather than blocked.</summary>
    string? AppliedByName,
    DateTime? AppliedAtUtc);

public record OrderImportLineDto(
    int Id,
    string RawText,
    string? ProposedName,
    decimal? ProposedQuantity,
    string? ProposedUnit,
    string ProposedLocation,
    string ProposedTracking,
    int? MatchedPantryItemId,
    string Confidence,
    decimal? GuessFromPounds,
    int Position);

/// <summary>A correction made before applying. Nothing is written to the pantry until `PUT n AWAY`.</summary>
public record ImportLineInput(
    string? ProposedName,
    decimal? ProposedQuantity,
    string? ProposedUnit,
    string? ProposedLocation,
    string? ProposedTracking,
    int? MatchedPantryItemId);

public record ApplyImportInput(int? ProfileId);

/// <summary>
/// A recipe worth cooking soon, and what it would use up (KITCHEN_LOOP_ADDENDUM §4).
/// </summary>
/// <remarks>
/// <see cref="Uses"/> is named rather than counted because the lead card says which things are
/// turning — "Spinach, cream, open tomatoes" — and a bare number would leave the household to open
/// the recipe to find out whether it is worth it.
/// </remarks>
public record DueRecipeDto(int RecipeId, string Title, int Score, IReadOnlyList<string> Uses);

/// <summary>
/// Save what one pack holds — "a tin is 400 g" (KITCHEN_LOOP_ADDENDUM §2, panel `1d`).
/// </summary>
/// <remarks>
/// Said in the direction the household speaks: how much is in <b>one</b> of them. The panel never
/// asks for a conversion factor, and never shows one.
/// </remarks>
public record PackSizeInput(
    /// <summary>How much one pack holds. Null or zero clears the mapping back to a loose row.</summary>
    decimal? PackSize,
    /// <summary>What that amount is measured in — the `g` in "400 g".</summary>
    string? PackUnit,
    int? ProfileId = null);

/// <summary>
/// The answer to saving a pack size: the row as it now stands, and the check that was blocked on
/// it, re-run.
/// </summary>
/// <remarks>
/// Returned together because the mapping exists to unblock something. §2 requires saving one to
/// "re-run any pending check or grocery calculation that was blocked on it" — handing back a bare
/// item would leave the caller to work out what changed and ask again.
/// </remarks>
public record PackSizeResultDto(PantryItemDto Item, StockCheckDto? Recheck);

// ---- Matching (MATCHING_AND_ALIASES) ----

/// <summary>M3 in one response: where matching stands, how it got there, and what to do next.</summary>
public record MatchingCoverageDto(
    /// <summary>`83%` — recipe lines that resolve to something on the shelves.</summary>
    int Percent,
    int MatchedLines,
    int TotalLines,
    /// <summary>`HOW IT GOT LEARNED` — counts by <see cref="AliasSource"/>.</summary>
    IReadOnlyDictionary<string, int> BySource,
    /// <summary>`WORTH SORTING`, ordered by how many recipes each one unblocks.</summary>
    IReadOnlyList<MatchingGapDto> WorthSorting,
    /// <summary>`WHAT WE GET WRONG` — pairings the household undid, never suggested again.</summary>
    int Undone);

public record MatchingGapDto(string Name, int RecipesBlocked);

/// <summary>`YES · REMEMBER IT` — teach one match, household-wide and reversible.</summary>
public record TeachMatchInput(string Ingredient, int PantryItemId, int? ProfileId = null);

/// <summary>
/// `NONE OF THESE`, or undoing a match that was wrong.
/// </summary>
/// <remarks>
/// Suppresses that <b>pair</b> permanently — the ingredient stays matchable against everything else.
/// Without it the same wrong suggestion returns every time the question comes round, and the
/// household learns that saying no achieves nothing.
/// </remarks>
public record RefuseMatchInput(string Ingredient, int PantryItemId, int? ProfileId = null);

/// <summary>
/// Where one recipe stands against the shelves — the folder's band (RECIPES §1).
/// </summary>
/// <remarks>
/// <see cref="Band"/> is <c>Ready</c>, <c>Short</c> or <c>CantSay</c>. The third is the honest one
/// and is never folded into the other two: a recipe listed as ready that turns out to be missing
/// two things at seven in the evening costs more than one that admitted it did not know.
/// </remarks>
public record CookabilityDto(int RecipeId, string Band, int ShortCount, int UnmatchedCount);

/// <summary>
/// What a barcode turns out to be — identification only, writing nothing
/// (ADD_TO_PANTRY §2).
/// </summary>
/// <remarks>
/// <b>Distinct from <see cref="ScanResultDto"/> on purpose.</b> That one is the phone's tally path:
/// it moves stock and writes a ledger row per pack. The add form is doing the opposite job —
/// "scanning is identification, not tallying. One scan names the thing and fills its size; it never
/// increments a count" — so it needs an answer with no side effect at all. Reusing the scan endpoint
/// with a zero delta would have written a zero-delta event for every frame that decoded.
/// </remarks>
public record BarcodeLookupDto(
    /// <summary>The normalised 13-digit form, which is what a later `NAME IT` must teach against.</summary>
    string Barcode,
    /// <summary>Whether the household or global catalogue already knows this pack.</summary>
    bool Known,
    string? Name,
    string? Unit,
    decimal? PackSize,
    string? PackUnit,
    string? Location,
    string? Tracking,
    /// <summary>
    /// What an outside catalogue thinks it is, when the household's own does not know.
    /// </summary>
    /// <remarks>
    /// Pre-fills the form and nothing more. Confirming it is what teaches the household entry —
    /// the same gesture as typing the name, which is what keeps the household's words authoritative
    /// over a stranger's database (DECISIONS PG4).
    /// </remarks>
    ProductSuggestionDto? Suggestion);

/// <summary>
/// A recipe that consumes this item, and how much of it the recipe asks for
/// (PANTRY_SHELVES §2, <c>USED BY</c>).
/// </summary>
/// <remarks>
/// <para>
/// <b>Recipes, not nights.</b> <see cref="ItemClaimDto"/> answers "what is this tin promised to";
/// this answers "what is this tin <i>for</i>". The sheet needs the second question to be useful
/// before the week is planned at all — a household looking at four tins wants to know what they
/// cook, and a list that only appears once something is scheduled is empty exactly when somebody is
/// deciding what to schedule.
/// </para>
/// <para>
/// Ordered by title. A claim does not promote a row — see the ordering note on the action.
/// </para>
/// <para>
/// <see cref="Packs"/> is the recipe's amount restated in the item's own containers, and it is null
/// far more often than not: it needs both a pack size on the shelf and a unit conversion that
/// <see cref="UnitConversion"/> is willing to make. Null means the sheet says <c>30 oz</c> and stops
/// rather than guessing how many tins that is — the same rule the stock check follows.
/// </para>
/// </remarks>
public record ItemUsageDto(
    int RecipeId,
    string Title,
    /// <summary>What the line asks for, as the recipe wrote it. Null on a line the parser could not read.</summary>
    decimal? Quantity,
    string? Unit,
    /// <summary>That amount in the item's own packs, when the two units can be compared at all.</summary>
    decimal? Packs,
    /// <summary>The container word the packs are counted in — <c>cans</c>, <c>pots</c>.</summary>
    string? PackUnit,
    /// <summary>The night holding this recipe's claim, when one does — the amber <c>claimed for Saturday</c>.</summary>
    DateOnly? ClaimedForDate);

/// <summary>
/// A night that has spoken for this item (PANTRY_SHELVES §2, KITCHEN_LOOP_ADDENDUM §1).
/// </summary>
/// <remarks>
/// The item sheet shows this as <c>claimed for Saturday</c> — the row knowing it is spoken for is
/// what stops the household counting the same tin twice when they look at two different screens.
/// </remarks>
public record ItemClaimDto(
    int PlanEntryId,
    DateOnly Date,
    string Slot,
    /// <summary>The dish that wants it, so the sheet can name a night rather than an id.</summary>
    string? DishName,
    /// <summary>How much, in the item's own measure unit. Null for an estimated item.</summary>
    decimal? Quantity);
