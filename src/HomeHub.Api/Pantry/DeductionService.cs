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
    private readonly TimeProvider _clock;

    public DeductionService(HomeHubDbContext db, PantryLedger ledger, TimeProvider clock)
    {
        _db = db;
        _ledger = ledger;
        _clock = clock;
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

        // Deductions only. `Produced` shares the source pair with them, so an unfiltered guard would
        // let a leftovers answer alone stand in for a deduction that never happened — and a night
        // whose lines only started matching after somebody taught an alias would never come off the
        // shelves at all.
        var existing = await _db.PantryEvents
            .Where(e => e.SourceKind == PantryEventSource.PlanEntry
                && e.SourceId == planEntryId
                && e.Kind == PantryEventKind.Deducted)
            .Include(e => e.Item)
            .OrderBy(e => e.Id)
            .ToListAsync(ct);

        if (existing.Count > 0) return await ReceiptAsync(entry, existing, ct);

        var recipe = entry.Recipe;
        var servings = entry.ServingsOverride ?? recipe.Servings ?? 0;
        var factor = recipe.Servings is > 0 && servings > 0 ? (decimal)servings / recipe.Servings.Value : 1m;

        // The shared matcher, not a private copy of the same lookup. This is the one path that
        // actually moves stock, so it is the path where a refused pairing matters most: a private
        // alias-then-name lookup ignores `AliasRejection` and takes a tin off a shelf the household
        // has already said is the wrong tin.
        var matcher = await PantryMatcher.LoadAsync(_db, ct);

        var written = new List<PantryEvent>();
        // One event per item, not per ingredient line: a recipe naming butter twice took butter out
        // once, and two events would deduct it twice and offer two undo ticks for one act.
        var touched = new HashSet<int>();

        foreach (var ingredient in recipe.Ingredients.OrderBy(i => i.Position))
        {
            var item = matcher.Match(ingredient);
            // A recipe line nothing answers to changes nothing and does not appear on the receipt (§2).
            if (item is null || !touched.Add(item.Id)) continue;

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

        // "Undo removes the produced item with the rest of the receipt" (§5). Leaving it behind
        // would put a box of leftovers in the fridge for a night the household just said did not
        // happen — and a later night would then claim it.
        await ProduceAsync(planEntryId, location: null, portions: null, byProfileId, ct);
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

        var servings = entry.ServingsOverride ?? entry.Recipe?.Servings ?? 0;

        // Who and when, from the deduction's own first event rather than from the request: the
        // receipt is a record of what happened, and re-opening it later must name the person who
        // confirmed the night, not whoever is standing at the panel now.
        var first = events.FirstOrDefault(e => e.Kind == PantryEventKind.Deducted);
        var writtenBy = first?.ByProfileId is { } profileId
            ? await _db.Profiles.Where(p => p.Id == profileId).Select(p => p.Name).FirstOrDefaultAsync(ct)
            : null;

        return new DeductionReceiptDto(
            entry.Id,
            entry.FreeText ?? entry.Recipe?.Title ?? "Dinner",
            servings,
            entry.Date,
            counted, estimated, leftAlone, hitNone,
            Leftovers(entry, servings),
            writtenBy,
            first?.AtUtc);
    }

    /// <summary>
    /// What the night left over, or null when it left nothing (KITCHEN_LOOP_ADDENDUM §5).
    /// </summary>
    /// <remarks>
    /// <b>Only a night answered "or some of it" leaves anything.</b> A plain "yes, we ate it" means
    /// everyone sat down, so there is nothing spare and no card — which is why this returns null
    /// rather than a card offering zero portions.
    /// </remarks>
    private static ProducedSuggestionDto? Leftovers(MealPlanEntry entry, int servings)
    {
        if (entry.WasEaten != true) return null;

        var eaten = entry.PortionsEaten ?? servings;
        var spare = servings - eaten;
        if (spare <= 0) return null;

        var dish = entry.Recipe?.Title ?? entry.FreeText;
        if (string.IsNullOrWhiteSpace(dish)) return null;

        return new ProducedSuggestionDto(
            $"Leftover {dish}", spare, nameof(PantryLocation.Fridge));
    }

    /// <summary>
    /// Act on the leftovers card — put the spare portions somewhere, or say there are none.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Creates an <b>ordinary</b> <see cref="TrackingClass.Counted"/> item measured in portions, not
    /// a special kind of row. That is the whole point: a leftovers night then claims it through the
    /// same settle as a tin (§1), and the grocery review stops asking anybody to buy for Tuesday.
    /// </para>
    /// <para>
    /// <see cref="PantryItem.OpenedAt"/> is set to the cook time because a cooked thing is open from
    /// the moment it exists — there is no unopened state for a box of leftovers.
    /// </para>
    /// </remarks>
    public async Task<PantryItem?> ProduceAsync(
        int planEntryId, PantryLocation? location, int? portions, int? byProfileId, CancellationToken ct)
    {
        var entry = await _db.MealPlanEntries
            .Include(e => e.Recipe)
            .FirstOrDefaultAsync(e => e.Id == planEntryId, ct);
        if (entry is null) return null;

        // Replace rather than add: answering the card twice is answering it once, and two boxes of
        // Tuesday's leftovers is a fiction the fridge will not back up.
        var existing = await _db.PantryItems
            .Where(i => i.ProducedByPlanEntryId == planEntryId && !i.IsArchived)
            .ToListAsync(ct);

        if (location is null)
        {
            // `NONE LEFT`. Anything produced by an earlier answer goes away with it.
            foreach (var item in existing) item.IsArchived = true;
            await _db.SaveChangesAsync(ct);
            return null;
        }

        var servings = entry.ServingsOverride ?? entry.Recipe?.Servings ?? 0;
        var suggested = Leftovers(entry, servings);
        var count = portions ?? suggested?.SuggestedPortions ?? 0;
        if (count <= 0) return null;

        var now = _clock.GetUtcNow().UtcDateTime;
        var name = suggested?.SuggestedName ?? $"Leftover {entry.Recipe?.Title ?? entry.FreeText}";

        var produced = existing.FirstOrDefault();
        if (produced is null)
        {
            produced = new PantryItem
            {
                Name = name,
                Tracking = TrackingClass.Counted,
                Unit = "portions",
                CreatedUtc = now,
                ProducedByPlanEntryId = planEntryId,
            };
            _db.PantryItems.Add(produced);
        }

        produced.Location = location.Value;
        produced.IsArchived = false;
        produced.OpenedAt = now;
        produced.OpenedByProfileId = byProfileId;
        produced.UpdatedUtc = now;
        await _db.SaveChangesAsync(ct);

        // Through the ledger like every other change of stock, so the row and its history agree.
        _db.PantryEvents.Add(new PantryEvent
        {
            PantryItemId = produced.Id,
            Kind = PantryEventKind.Produced,
            Delta = count - (produced.Quantity ?? 0),
            ResultingQuantity = count,
            AtUtc = now,
            ByProfileId = byProfileId,
            SourceKind = PantryEventSource.PlanEntry,
            SourceId = planEntryId,
        });
        produced.Quantity = count;
        await _db.SaveChangesAsync(ct);

        return produced;
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
