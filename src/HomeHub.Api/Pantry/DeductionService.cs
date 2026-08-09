namespace HomeHub.Api.Pantry;

using HomeHub.Api.Data;
using HomeHub.Api.Meals;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// Takes a cooked night off the shelves (9f) — the ambitious half of the section, and the reason
/// auto-deduct was the right answer to DECISIONS P1: hand-decrementing is why household pantry apps
/// get abandoned in week three.
/// </summary>
/// <remarks>
/// Driven by <see cref="MealPlanEntry.WasEaten"/> flipping to <c>true</c> and by nothing else. A
/// planned night deducts nothing; an unanswered night deducts nothing; a night answered "no"
/// deducts nothing. Idempotent per plan entry, so flipping the answer twice cannot double-deduct.
/// <para>
/// Everything it does is applied <b>before</b> the receipt is shown. The ticks on 9f are undo, not
/// consent.
/// </para>
/// </remarks>
public sealed class DeductionService
{
    private readonly HomeHubDbContext _db;
    private readonly PantryLedger _ledger;

    public DeductionService(HomeHubDbContext db, PantryLedger ledger)
    {
        _db = db;
        _ledger = ledger;
    }

    /// <summary>
    /// Deduct for one plan entry, or return the receipt for a deduction already applied.
    /// </summary>
    /// <remarks>
    /// The already-applied path is not an error and does not re-deduct: two people confirming the
    /// same night, or a retried write from the offline queue, must both land on the same receipt.
    /// </remarks>
    public async Task<DeductionReceiptDto?> DeductAsync(int planEntryId, int? byProfileId, CancellationToken ct)
    {
        var entry = await _db.MealPlanEntries
            .Include(e => e.Recipe)!.ThenInclude(r => r!.Ingredients)
            .FirstOrDefaultAsync(e => e.Id == planEntryId, ct);
        if (entry is null) return null;

        // Only a night someone said they ate. Never inferred from the date passing.
        if (entry.WasEaten != true) return null;
        if (entry.Recipe is null) return null;

        var existing = await _db.PantryEvents
            .Where(e => e.SourceKind == PantryEventSource.PlanEntry && e.SourceId == planEntryId)
            .Include(e => e.Item)
            .OrderBy(e => e.Id)
            .ToListAsync(ct);

        if (existing.Count > 0) return await ReceiptAsync(entry, existing, ct);

        var recipe = entry.Recipe;
        var servings = entry.ServingsOverride ?? recipe.Servings ?? 0;
        var factor = recipe.Servings is > 0 && servings > 0 ? (decimal)servings / recipe.Servings.Value : 1m;

        var items = await _db.PantryItems.Where(i => !i.IsArchived).ToListAsync(ct);
        var aliases = await _db.IngredientAliases.ToDictionaryAsync(a => a.Alias, a => a.PantryItemId, ct);
        var byName = new Dictionary<string, int>();
        foreach (var item in items)
        {
            var key = IngredientNormaliser.Normalise(item.Name);
            if (key.Length > 0) byName.TryAdd(key, item.Id);
        }

        var written = new List<PantryEvent>();
        // One event per item, not per ingredient line: a recipe naming butter twice took butter out
        // once, and two events would deduct it twice and offer two undo ticks for one act.
        var touched = new HashSet<int>();

        foreach (var ingredient in recipe.Ingredients.OrderBy(i => i.Position))
        {
            var key = IngredientNormaliser.Normalise(ingredient.Name ?? ingredient.RawText);
            if (key.Length == 0) continue;

            var itemId = aliases.TryGetValue(key, out var viaAlias) ? viaAlias
                : byName.TryGetValue(key, out var viaName) ? viaName
                : (int?)null;
            // A recipe line with no alias changes nothing and does not appear on the receipt (§2).
            if (itemId is null || !touched.Add(itemId.Value)) continue;

            var item = items.First(i => i.Id == itemId.Value);
            // Staples are listed under LEFT ALONE and never touched.
            if (item.Tracking == TrackingClass.NotCounted) continue;

            written.Add(DeductOne(item, ingredient, factor, byProfileId, planEntryId));
        }

        await _db.SaveChangesAsync(ct);
        return await ReceiptAsync(entry, written, ct);
    }

    /// <summary>
    /// Deduct one item for one ingredient line, applying the four rules in
    /// PANTRY_DATA_CONTRACT §2 exactly.
    /// </summary>
    private PantryEvent DeductOne(
        PantryItem item, RecipeIngredient ingredient, decimal factor, int? byProfileId, int planEntryId)
    {
        PantryEvent Write(decimal? delta, EstimateState? state) => _ledger.Record(
            item, PantryEventKind.Deducted, byProfileId,
            delta: delta, setState: state,
            sourceKind: PantryEventSource.PlanEntry, sourceId: planEntryId);

        if (item.Tracking == TrackingClass.Estimated)
        {
            // One step. Never two — the panel does not know how much a recipe took out of a jar,
            // and taking two steps would invent precision in the class defined by its absence.
            return Write(null, PantryLedger.StepDown(item.EstimateState));
        }

        var scaled = ingredient.Quantity is { } q ? q * factor : (decimal?)null;
        var comparable = scaled is null
            ? null
            : UnitConversion.Convert(scaled.Value, ingredient.Unit, PantryAmounts.MeasureUnit(item));

        // Back into whatever `Quantity` counts. On a packaged row that is packs, so four ounces out
        // of 3 oz pots takes a pot and a third off the count rather than four of something.
        if (comparable is { } amount) return Write(-PantryAmounts.ToQuantity(item, amount), null);

        // Counted, but the units cannot honestly be compared — "4 tbsp" against "1 lb" of butter.
        //
        // Recorded with a **zero delta**: the event exists so the line is on the receipt, is
        // undoable, and updates the item's last-seen age, but no number is claimed. §2 calls this
        // "treat as Estimated for this deduction … and say so", and the receipt says so in words
        // (`most left`, plus the note) — which is what 9f's own mockup shows for exactly this case.
        //
        // The alternative reading, stepping a *counted* row down by a whole unit, would announce
        // that a pound of butter is gone because a recipe used four tablespoons, and then offer to
        // put it on the grocery list. That is the confident wrongness DECISIONS P9 exists to forbid.
        // The cost is real and accepted: an item only ever cooked with in unconvertible units never
        // falls on its own, and stays accurate only if somebody corrects it by hand.
        return Write(0, null);
    }

    /// <summary>Reverse a whole night's deduction — `UNDO ALL`.</summary>
    public async Task<bool> UndoAllAsync(int planEntryId, int? byProfileId, CancellationToken ct)
    {
        var events = await _db.PantryEvents
            .Where(e => e.SourceKind == PantryEventSource.PlanEntry
                && e.SourceId == planEntryId
                && e.UndoneByEventId == null
                && e.Kind == PantryEventKind.Deducted)
            .Select(e => e.Id)
            .ToListAsync(ct);
        if (events.Count == 0) return false;

        foreach (var id in events) await _ledger.UndoAsync(id, byProfileId, ct);
        return true;
    }

    private async Task<DeductionReceiptDto> ReceiptAsync(
        MealPlanEntry entry, IReadOnlyList<PantryEvent> events, CancellationToken ct)
    {
        var itemIds = events.Select(e => e.PantryItemId).ToList();
        var items = await _db.PantryItems.Where(i => itemIds.Contains(i.Id)).ToDictionaryAsync(i => i.Id, ct);

        var counted = new List<ReceiptLineDto>();
        var estimated = new List<ReceiptLineDto>();
        var hitNone = new List<int>();

        foreach (var e in events.Where(e => e.Kind == PantryEventKind.Deducted))
        {
            if (!items.TryGetValue(e.PantryItemId, out var item)) continue;
            var undone = e.UndoneByEventId is not null;

            if (item.Tracking == TrackingClass.Estimated)
            {
                estimated.Add(new ReceiptLineDto(
                    e.Id, item.Id, item.Name, null, null, e.ResultingState?.ToString(),
                    "out of a jar — no way to count that", undone));
                if (!undone && e.ResultingState == EstimateState.None) hitNone.Add(item.Id);
                continue;
            }

            // A zero-delta counted line is the degraded case: no arithmetic was claimed, so it
            // belongs beside the estimates rather than under `COUNTED · EXACT`.
            if (e.Delta is 0)
            {
                estimated.Add(new ReceiptLineDto(
                    e.Id, item.Id, item.Name, null, null, "MostLeft",
                    "the recipe's units don't convert to "
                        + $"{PantryAmounts.MeasureUnit(item) ?? "what's on the shelf"} — nothing counted off",
                    undone));
                continue;
            }

            var to = e.ResultingQuantity;
            var from = to + Math.Abs(e.Delta ?? 0);
            counted.Add(new ReceiptLineDto(e.Id, item.Id, item.Name, from, to, null, null, undone));
            if (!undone && to is <= 0) hitNone.Add(item.Id);
        }

        var leftAlone = await LeftAloneAsync(entry, ct);

        return new DeductionReceiptDto(
            entry.Id,
            entry.FreeText ?? entry.Recipe?.Title ?? "Dinner",
            entry.ServingsOverride ?? entry.Recipe?.Servings ?? 0,
            entry.Date,
            counted, estimated, leftAlone, hitNone);
    }

    /// <summary>
    /// The staples this recipe uses, named but untouched. Named rather than hidden: `LEFT ALONE ·
    /// STAPLES` is how the household learns which lines the pantry will never chase them about.
    /// </summary>
    private async Task<List<string>> LeftAloneAsync(MealPlanEntry entry, CancellationToken ct)
    {
        if (entry.Recipe is null) return [];

        var staples = await _db.PantryItems
            .Where(i => !i.IsArchived && i.Tracking == TrackingClass.NotCounted)
            .Select(i => new { i.Id, i.Name })
            .ToListAsync(ct);
        if (staples.Count == 0) return [];

        var byKey = new Dictionary<string, string>();
        foreach (var s in staples)
        {
            var key = IngredientNormaliser.Normalise(s.Name);
            if (key.Length > 0) byKey.TryAdd(key, s.Name);
        }

        var aliases = await _db.IngredientAliases
            .Where(a => staples.Select(s => s.Id).Contains(a.PantryItemId))
            .ToDictionaryAsync(a => a.Alias, a => a.PantryItemId, ct);
        var stapleNames = staples.ToDictionary(s => s.Id, s => s.Name);

        var used = new List<string>();
        foreach (var ingredient in entry.Recipe.Ingredients.OrderBy(i => i.Position))
        {
            var key = IngredientNormaliser.Normalise(ingredient.Name ?? ingredient.RawText);
            if (key.Length == 0) continue;
            var name = byKey.TryGetValue(key, out var direct) ? direct
                : aliases.TryGetValue(key, out var id) ? stapleNames.GetValueOrDefault(id)
                : null;
            if (name is not null && !used.Contains(name)) used.Add(name);
        }
        return used;
    }
}
