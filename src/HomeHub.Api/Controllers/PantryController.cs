namespace HomeHub.Api.Controllers;

using HomeHub.Api.Data;
using HomeHub.Api.Pantry;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// What the house has (9a), how it gets in (9c), and what it says about a night (9b/9f).
/// </summary>
/// <remarks>
/// <b>Nothing here blocks anything</b> (PANTRY_BEHAVIOURS §1). The pantry is advisory in every
/// direction: a shortfall never prevents assigning, cooking or confirming a night, and when this
/// controller is unavailable the Meals flow proceeds with the check silently skipped. A stock check
/// that isn't there is worth less than nothing to a standing adult with wet hands.
/// </remarks>
[ApiController]
[Route("api/pantry")]
public class PantryController : ControllerBase
{
    private readonly HomeHubDbContext _db;
    private readonly PantryLedger _ledger;
    private readonly StockCheckService _check;
    private readonly DeductionService _deduction;
    private readonly IProductLookup _lookup;
    private readonly TimeProvider _clock;

    public PantryController(
        HomeHubDbContext db,
        PantryLedger ledger,
        StockCheckService check,
        DeductionService deduction,
        IProductLookup lookup,
        TimeProvider clock)
    {
        _db = db;
        _ledger = ledger;
        _check = check;
        _deduction = deduction;
        _lookup = lookup;
        _clock = clock;
    }

    /// <summary>
    /// The whole tab in one response: items, the hedged tally, who last touched it, and any import
    /// still waiting to be put away.
    /// </summary>
    /// <remarks>
    /// One request rather than four because 9a is a wall panel that polls — and because the tally
    /// and the list have to agree. Counting client-side from a list fetched separately is how "36
    /// THINGS" ends up describing a different moment than the rows beneath it.
    /// </remarks>
    [HttpGet]
    public async Task<PantryListDto> List([FromQuery] string? location, CancellationToken ct)
    {
        var query = _db.PantryItems.Where(i => !i.IsArchived);
        if (Parse<PantryLocation>(location) is { } loc) query = query.Where(i => i.Location == loc);

        var items = await query.OrderBy(i => i.Location).ThenBy(i => i.Name).ToListAsync(ct);
        var lastSeen = await _ledger.LastSeenAsync(items.Select(i => i.Id).ToList(), ct);
        var names = await ProfileNamesAsync(ct);

        var seenBy = await _db.PantryEvents
            .Where(e => items.Select(i => i.Id).Contains(e.PantryItemId)
                && e.UndoneByEventId == null && e.Kind != PantryEventKind.Undone)
            .GroupBy(e => e.PantryItemId)
            .Select(g => new { g.Key, ByProfileId = g.OrderByDescending(e => e.AtUtc).First().ByProfileId })
            .ToDictionaryAsync(x => x.Key, x => x.ByProfileId, ct);

        var dtos = items.Select(i => ToDto(i, lastSeen, seenBy, names)).ToList();

        // Counts are over the *whole* pantry, not the filtered view: the tally is a fact about the
        // kitchen, and having it change when you tap FRIDGE would make it read as a search result.
        var all = await _db.PantryItems.Where(i => !i.IsArchived)
            .Select(i => new { i.Tracking, i.Quantity, i.EstimateState })
            .ToListAsync(ct);

        var probablyOut = all.Count(i =>
            (i.Tracking == TrackingClass.Counted && i.Quantity <= 0) ||
            (i.Tracking == TrackingClass.Estimated && i.EstimateState == EstimateState.None));
        var probablyLow = all.Count(i =>
            (i.Tracking == TrackingClass.Counted && i.Quantity > 0 && i.Quantity <= 2) ||
            (i.Tracking == TrackingClass.Estimated && i.EstimateState == EstimateState.Low));

        var lastTouched = await _db.PantryEvents
            .Where(e => e.Kind != PantryEventKind.Undone)
            .OrderByDescending(e => e.AtUtc)
            .Select(e => new { e.AtUtc, e.ByProfileId })
            .FirstOrDefaultAsync(ct);

        var pending = await _db.OrderImports
            .Where(i => i.Status == OrderImportStatus.Pending)
            .OrderByDescending(i => i.CreatedUtc)
            .Select(i => new PendingImportDto(i.Id, i.VendorLabel, i.DeliveredAtUtc, i.Lines.Count))
            .ToListAsync(ct);

        return new PantryListDto(
            dtos, all.Count, probablyLow, probablyOut,
            lastTouched?.ByProfileId is { } who ? names.GetValueOrDefault(who) : null,
            lastTouched?.AtUtc,
            pending);
    }

    /// <summary>One item's ledger, newest first — the row sheet's history and the undo surface.</summary>
    [HttpGet("{id:int}/events")]
    public async Task<ActionResult<IReadOnlyList<PantryEventDto>>> Events(
        int id, [FromQuery] int take = 40, CancellationToken ct = default)
    {
        if (!await _db.PantryItems.AnyAsync(i => i.Id == id, ct)) return NotFound();
        var names = await ProfileNamesAsync(ct);

        var events = await _db.PantryEvents
            .Where(e => e.PantryItemId == id)
            .OrderByDescending(e => e.AtUtc).ThenByDescending(e => e.Id)
            .Take(Math.Clamp(take, 1, 200))
            .ToListAsync(ct);

        return events.Select(e => new PantryEventDto(
            e.Id, e.PantryItemId, e.Kind.ToString(), e.Delta, e.ResultingQuantity,
            e.ResultingState?.ToString(), e.AtUtc,
            e.ByProfileId is { } p ? names.GetValueOrDefault(p) : null,
            e.UndoneByEventId is not null)).ToList();
    }

    /// <summary>Add something by hand — the 9a footer, and the fallback for every other route in.</summary>
    [HttpPost]
    public async Task<ActionResult<PantryItemDto>> Create(PantryItemInput input, CancellationToken ct)
    {
        if (Invalid(input) is { } problem) return BadRequest(problem);

        var now = _clock.GetUtcNow().UtcDateTime;
        var item = new PantryItem
        {
            Name = input.Name.Trim(),
            Location = Parse<PantryLocation>(input.Location) ?? PantryLocation.Cupboard,
            Tracking = Parse<TrackingClass>(input.Tracking) ?? TrackingClass.Counted,
            Unit = Blank(input.Unit),
            CreatedUtc = now,
            UpdatedUtc = now,
        };
        _db.PantryItems.Add(item);

        // Through the ledger, never assigned: the row and its history have to agree from the first
        // moment, or `SEEN TODAY` on a brand-new item is already a claim nothing backs.
        _ledger.Record(
            item, PantryEventKind.TypedIn, input.ProfileId,
            setQuantity: item.Tracking == TrackingClass.Counted ? input.Quantity ?? 0 : null,
            setState: item.Tracking == TrackingClass.Estimated
                ? Parse<EstimateState>(input.EstimateState) ?? EstimateState.Plenty
                : null);

        await _db.SaveChangesAsync(ct);
        await SeedAliasAsync(item, ct);
        await _db.SaveChangesAsync(ct);

        return await SingleAsync(item.Id, ct);
    }

    /// <summary>Amend an item — amount, state, location, tracking class. Writes an event.</summary>
    [HttpPatch("{id:int}")]
    public async Task<ActionResult<PantryItemDto>> Update(
        int id, PantryItemInput input, [FromQuery] int? baseVersion, CancellationToken ct)
    {
        if (Invalid(input) is { } problem) return BadRequest(problem);

        var item = await _db.PantryItems.FirstOrDefaultAsync(i => i.Id == id, ct);
        if (item is null) return NotFound();
        // The pantry has no long forms, so the terse conflict strip is enough — PANTRY_BEHAVIOURS §4
        // is explicit that no yours-vs-theirs screen is needed here.
        if (baseVersion is { } v && v != item.Version) return Conflict(await BuildAsync(item, ct));

        item.Name = input.Name.Trim();
        item.Location = Parse<PantryLocation>(input.Location) ?? item.Location;
        item.Unit = Blank(input.Unit);

        var tracking = Parse<TrackingClass>(input.Tracking) ?? item.Tracking;
        if (tracking != item.Tracking)
        {
            item.Tracking = tracking;
            // Changing class resets the other class's field, so an item switched to Estimated does
            // not keep a stale count that nothing will ever update again.
            if (tracking != TrackingClass.Counted) item.Quantity = null;
            if (tracking != TrackingClass.Estimated) item.EstimateState = null;
        }

        _ledger.Record(
            item, PantryEventKind.Corrected, input.ProfileId,
            setQuantity: item.Tracking == TrackingClass.Counted ? input.Quantity ?? 0 : null,
            setState: item.Tracking == TrackingClass.Estimated
                ? Parse<EstimateState>(input.EstimateState) ?? item.EstimateState ?? EstimateState.Plenty
                : null);

        item.Version++;
        await _db.SaveChangesAsync(ct);
        return await BuildAsync(item, ct);
    }

    /// <summary>
    /// Archive, never hard delete — the ledger references it (§2), and a deleted row would take
    /// somebody's history of the shelf with it.
    /// </summary>
    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id, [FromQuery] int? baseVersion, CancellationToken ct)
    {
        var item = await _db.PantryItems.FirstOrDefaultAsync(i => i.Id == id, ct);
        if (item is null) return NotFound();
        if (baseVersion is { } v && v != item.Version) return Conflict(await BuildAsync(item, ct));

        item.IsArchived = true;
        item.UpdatedUtc = _clock.GetUtcNow().UtcDateTime;
        item.Version++;
        await _db.SaveChangesAsync(ct);
        return NoContent();
    }

    /// <summary>
    /// One scan (9c). Resolves the catalogue, upserts the item, and answers with whether it matched.
    /// </summary>
    /// <remarks>
    /// <b>Writes immediately</b>, one row per scan — the run list is the undo. That keeps the loop at
    /// one tap per pack, which is the only speed that survives unpacking six bags (DECISIONS PG3).
    /// Idempotent on <c>(scanRunId, sequence)</c>, so two phones on the same delivery both add and a
    /// retry does not.
    /// </remarks>
    [HttpPost("scan")]
    public async Task<ActionResult<ScanResultDto>> Scan(ScanInput input, CancellationToken ct)
    {
        var barcode = Barcodes.Normalise(input.Barcode, input.Format);
        if (barcode is null) return BadRequest("That doesn't look like a grocery barcode.");

        var already = await _db.PantryEvents
            .Include(e => e.Item)
            .FirstOrDefaultAsync(e => e.ScanRunId == input.ScanRunId && e.ScanSequence == input.Sequence, ct);
        if (already?.Item is not null)
        {
            return new ScanResultDto(true, barcode, await BuildDtoAsync(already.Item, ct), already.Id);
        }

        // Household entries win over global ones — that is the whole learning mechanism.
        var entry = await _db.ProductCatalogue
            .Where(c => c.Barcode == barcode)
            .OrderByDescending(c => c.Scope == CatalogueScope.Household)
            .FirstOrDefaultAsync(ct);

        // An unmatched barcode is a first-class row, not an error (DECISIONS PG4). Nothing is
        // written; the phone shows the `NAME IT` row and the next identical pack will resolve.
        //
        // Before giving up, ask whatever outside catalogue is configured — but only to *pre-fill*
        // that row. The suggestion creates nothing and teaches nothing: confirming it is what writes
        // the household entry, which is the same gesture as typing the name by hand and keeps the
        // household's own words authoritative over a stranger's database.
        if (entry is null)
        {
            var suggestion = await _lookup.LookupAsync(barcode, ct);
            return new ScanResultDto(false, barcode, null, null,
                suggestion is { } found
                    ? new ProductSuggestionDto(found.Name, found.Brand, found.Unit, found.PackSize, found.Source)
                    : null);
        }

        var location = Parse<PantryLocation>(input.Location) ?? entry.DefaultLocation;
        var item = await _db.PantryItems
            .FirstOrDefaultAsync(i => !i.IsArchived && (i.CatalogueRef == barcode || i.Name == entry.Name), ct);

        var now = _clock.GetUtcNow().UtcDateTime;
        var isNew = item is null;
        if (item is null)
        {
            item = new PantryItem
            {
                Name = entry.Name,
                Location = location,
                Tracking = entry.DefaultTracking,
                Unit = entry.DefaultUnit,
                CatalogueRef = barcode,
                CreatedUtc = now,
                UpdatedUtc = now,
            };
            _db.PantryItems.Add(item);
        }
        else
        {
            item.CatalogueRef = barcode;
        }

        // `Delta` is a count of **packs** — the phone scanned one thing. What one pack is worth
        // depends on the catalogue: a tin is 1 tin, but a bag of walnuts is 500 g, and adding "1"
        // to an item measured in grams is not a small error, it is a meaningless number that then
        // has to be corrected a tap at a time.
        //
        // Only applied when the catalogue states a pack size *and* the item is counted in the same
        // breath. A counted-by-the-unit item ("cans", "ea") keeps a pack size of one whatever the
        // database says the net weight is.
        var perPack = entry.PackSize is { } size && size > 0 && !UnitConversion.IsCountable(item.Unit)
            ? size
            : 1m;

        var evt = _ledger.Record(
            item, PantryEventKind.Scanned, input.ProfileId,
            delta: input.Delta * perPack,
            setState: item.Tracking == TrackingClass.Estimated ? EstimateState.Plenty : null,
            scanRunId: input.ScanRunId, scanSequence: input.Sequence);

        await _db.SaveChangesAsync(ct);
        if (isNew) { await SeedAliasAsync(item, ct); await _db.SaveChangesAsync(ct); }

        return new ScanResultDto(true, barcode, await BuildDtoAsync(item, ct), evt.Id);
    }

    /// <summary>
    /// `NAME IT` — teach the household catalogue what a barcode is, so the second tin resolves.
    /// </summary>
    [HttpPost("catalogue")]
    public async Task<ActionResult<ProductCatalogueEntry>> NameIt(CatalogueInput input, CancellationToken ct)
    {
        var barcode = Barcodes.Normalise(input.Barcode, input.Format);
        if (barcode is null) return BadRequest("That doesn't look like a grocery barcode.");
        if (string.IsNullOrWhiteSpace(input.Name)) return BadRequest("A name is required.");

        var existing = await _db.ProductCatalogue
            .FirstOrDefaultAsync(c => c.Barcode == barcode && c.Scope == CatalogueScope.Household, ct);

        if (existing is null)
        {
            existing = new ProductCatalogueEntry
            {
                Barcode = barcode,
                Scope = CatalogueScope.Household,
                CreatedUtc = _clock.GetUtcNow().UtcDateTime,
            };
            _db.ProductCatalogue.Add(existing);
        }

        existing.Name = input.Name.Trim();
        existing.DefaultUnit = Blank(input.Unit);
        existing.DefaultLocation = Parse<PantryLocation>(input.Location) ?? PantryLocation.Cupboard;
        existing.DefaultTracking = Parse<TrackingClass>(input.Tracking) ?? TrackingClass.Counted;
        existing.PackSize = input.PackSize;

        await _db.SaveChangesAsync(ct);
        return existing;
    }

    /// <summary>Reverse one event. The run-list undo, the receipt's per-line untick, the row sheet.</summary>
    [HttpPost("events/{id:int}/undo")]
    public async Task<ActionResult<PantryItemDto>> Undo(
        int id, [FromQuery] int? profileId, CancellationToken ct)
    {
        var itemId = await _db.PantryEvents.Where(e => e.Id == id).Select(e => e.PantryItemId)
            .FirstOrDefaultAsync(ct);
        if (itemId == 0) return NotFound();
        if (!await _ledger.UndoAsync(id, profileId, ct)) return BadRequest("That change was already undone.");
        return await SingleAsync(itemId, ct);
    }

    // ---- 9b · the stock check ----

    /// <summary>What a night probably needs. Server-side, because the aliases live there.</summary>
    [HttpGet("check")]
    public async Task<ActionResult<StockCheckDto>> Check(
        [FromQuery] int recipeId, [FromQuery] int? servings, [FromQuery] int? planEntryId,
        CancellationToken ct)
    {
        // A check dismissed with "Leave it, I'll sort it" does not re-fire for that entry (§5).
        if (planEntryId is { } entryId
            && await _db.StockCheckDismissals.AnyAsync(d => d.PlanEntryId == entryId, ct))
        {
            return NoContent();
        }

        var result = await _check.CheckAsync(recipeId, servings, ct);
        return result is null ? NotFound() : Ok(result);
    }

    /// <summary>"Leave it, I'll sort it" — records the dismissal so the check does not re-fire.</summary>
    [HttpPost("check/{planEntryId:int}/dismiss")]
    public async Task<IActionResult> Dismiss(
        int planEntryId, [FromQuery] int? profileId, CancellationToken ct)
    {
        if (!await _db.StockCheckDismissals.AnyAsync(d => d.PlanEntryId == planEntryId, ct))
        {
            _db.StockCheckDismissals.Add(new StockCheckDismissal
            {
                PlanEntryId = planEntryId,
                AtUtc = _clock.GetUtcNow().UtcDateTime,
                ByProfileId = profileId,
            });
            await _db.SaveChangesAsync(ct);
        }
        return NoContent();
    }

    /// <summary>
    /// "We've got these — the panel's wrong": mark every listed item seen today, at least at the
    /// amount the recipe needs.
    /// </summary>
    [HttpPost("correct")]
    public async Task<IActionResult> Correct(CorrectStockInput input, CancellationToken ct)
    {
        var ids = input.Lines.Select(l => l.PantryItemId).ToList();
        var items = await _db.PantryItems.Where(i => ids.Contains(i.Id)).ToListAsync(ct);

        foreach (var line in input.Lines)
        {
            var item = items.FirstOrDefault(i => i.Id == line.PantryItemId);
            if (item is null) continue;

            _ledger.Record(
                item, PantryEventKind.Corrected, input.ProfileId,
                // "At least what the recipe needs" — never less, so re-running the check clears the
                // row, which is the acceptance criterion for this action.
                setQuantity: item.Tracking == TrackingClass.Counted
                    ? Math.Max(item.Quantity ?? 0, line.AtLeast ?? 1)
                    : null,
                setState: item.Tracking == TrackingClass.Estimated ? EstimateState.Plenty : null);
        }

        await _db.SaveChangesAsync(ct);
        return NoContent();
    }

    // ---- 9f · deduction ----

    /// <summary>
    /// Take a cooked night off the shelves and hand back the receipt. Idempotent per plan entry.
    /// </summary>
    /// <remarks>
    /// 204 rather than 404 when there is nothing to deduct — a night with no matched ingredients is
    /// a normal outcome in the first weeks (PANTRY_BEHAVIOURS §7), and 9f simply does not appear.
    /// </remarks>
    [HttpPost("deduct")]
    public async Task<ActionResult<DeductionReceiptDto>> Deduct(
        [FromQuery] int planEntryId, [FromQuery] int? profileId, CancellationToken ct)
    {
        var receipt = await _deduction.DeductAsync(planEntryId, profileId, ct);
        if (receipt is null) return NoContent();
        if (receipt.Counted.Count == 0 && receipt.Estimated.Count == 0) return NoContent();
        return Ok(receipt);
    }

    /// <summary>`UNDO ALL` — reverses the whole night. Individual lines use the event undo.</summary>
    [HttpPost("deduct/{planEntryId:int}/undo")]
    public async Task<IActionResult> UndoDeduction(
        int planEntryId, [FromQuery] int? profileId, CancellationToken ct)
    {
        var ok = await _deduction.UndoAllAsync(planEntryId, profileId, ct);
        return ok ? NoContent() : NotFound();
    }

    // ---- helpers ----

    private static string? Blank(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static T? Parse<T>(string? name) where T : struct, Enum =>
        Enum.TryParse<T>(name, ignoreCase: true, out var value) && Enum.IsDefined(value) ? value : null;

    private static string? Invalid(PantryItemInput input)
    {
        if (string.IsNullOrWhiteSpace(input.Name)) return "A name is required.";
        if (input.Name.Trim().Length > PantryFieldLimits.ItemName)
            return $"The name is longer than {PantryFieldLimits.ItemName} characters.";
        if (input.Unit is { } unit && unit.Trim().Length > PantryFieldLimits.Unit)
            return $"The unit is longer than {PantryFieldLimits.Unit} characters.";
        if (input.Quantity is < 0) return "An amount cannot be negative.";
        return null;
    }

    private Task<Dictionary<int, string>> ProfileNamesAsync(CancellationToken ct) =>
        _db.Profiles.ToDictionaryAsync(p => p.Id, p => p.Name, ct);

    /// <summary>
    /// Teach the alias table this item's own name, so a new shelf answers the stock check without
    /// anyone having to link it by hand.
    /// </summary>
    /// <remarks>
    /// <see cref="AliasConfidence.Seeded"/>, not confirmed — a guessed join is still a guess, and
    /// the distinction is what lets a later correction win without argument. Skipped when the alias
    /// is already claimed: the first item to claim a name keeps it, because silently re-pointing an
    /// alias would change what an earlier stock check meant.
    /// </remarks>
    private async Task SeedAliasAsync(PantryItem item, CancellationToken ct)
    {
        var key = IngredientNormaliser.Normalise(item.Name);
        if (key.Length == 0) return;
        if (await _db.IngredientAliases.AnyAsync(a => a.Alias == key, ct)) return;

        _db.IngredientAliases.Add(new IngredientAlias
        {
            Alias = key,
            PantryItemId = item.Id,
            Confidence = AliasConfidence.Seeded,
            CreatedUtc = _clock.GetUtcNow().UtcDateTime,
        });
    }

    private async Task<ActionResult<PantryItemDto>> SingleAsync(int id, CancellationToken ct)
    {
        var item = await _db.PantryItems.FirstOrDefaultAsync(i => i.Id == id, ct);
        return item is null ? NotFound() : await BuildAsync(item, ct);
    }

    private async Task<ActionResult<PantryItemDto>> BuildAsync(PantryItem item, CancellationToken ct) =>
        await BuildDtoAsync(item, ct);

    private async Task<PantryItemDto> BuildDtoAsync(PantryItem item, CancellationToken ct)
    {
        var lastSeen = await _ledger.LastSeenAsync([item.Id], ct);
        var names = await ProfileNamesAsync(ct);
        var by = await _db.PantryEvents
            .Where(e => e.PantryItemId == item.Id && e.UndoneByEventId == null && e.Kind != PantryEventKind.Undone)
            .OrderByDescending(e => e.AtUtc)
            .Select(e => e.ByProfileId)
            .FirstOrDefaultAsync(ct);
        return ToDto(item, lastSeen, new Dictionary<int, int?> { [item.Id] = by }, names);
    }

    private static PantryItemDto ToDto(
        PantryItem item,
        IReadOnlyDictionary<int, DateTime> lastSeen,
        IReadOnlyDictionary<int, int?> seenBy,
        IReadOnlyDictionary<int, string> names)
    {
        var by = seenBy.TryGetValue(item.Id, out var profile) ? profile : null;
        return new PantryItemDto(
            item.Id, item.Name, item.Location.ToString(), item.Tracking.ToString(),
            item.Quantity, item.Unit, item.EstimateState?.ToString(),
            lastSeen.TryGetValue(item.Id, out var at) ? at : null,
            by is { } id ? names.GetValueOrDefault(id) : null,
            item.CatalogueRef, item.IsArchived, item.Version);
    }
}
