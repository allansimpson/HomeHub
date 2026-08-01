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
    decimal? Quantity,
    string? Unit,
    string? EstimateState,
    /// <summary>Null means never seen. The row says so rather than guessing from CreatedUtc.</summary>
    DateTime? LastSeenAtUtc,
    string? LastSeenByName,
    string? CatalogueRef,
    bool IsArchived,
    int Version);

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

/// <summary>Create or amend an item by hand. Quantity is applied through the ledger, never assigned.</summary>
public record PantryItemInput(
    string Name,
    string Location,
    string Tracking,
    decimal? Quantity,
    string? Unit,
    string? EstimateState,
    int? ProfileId);

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
    bool Undone);

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
    DateTime? LastSeenAtUtc);

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
    IReadOnlyList<int> HitNone);

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
    int Version);

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
    int? ProfileId);

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
