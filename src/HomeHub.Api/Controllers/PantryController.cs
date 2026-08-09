namespace HomeHub.Api.Controllers;

using HomeHub.Api.Data;
using HomeHub.Api.Pantry;
using HomeHub.Api.Auth;
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
    private readonly UnitRegistry _units;
    private readonly TimeProvider _clock;

    public PantryController(
        HomeHubDbContext db,
        PantryLedger ledger,
        StockCheckService check,
        DeductionService deduction,
        IProductLookup lookup,
        UnitRegistry units,
        TimeProvider clock)
    {
        _db = db;
        _ledger = ledger;
        _check = check;
        _deduction = deduction;
        _lookup = lookup;
        _units = units;
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
    /// <remarks>
    /// The fallback that matters most is the one after a failed scan: a pack neither the household
    /// catalogue nor the outside lookup could name is typed in here, and if the phone read a code it
    /// arrives on <see cref="PantryItemInput.Barcode"/> and is kept. That is what makes the second
    /// pack of the same thing resolve on its own.
    /// </remarks>
    [HttpPost]
    public async Task<ActionResult<PantryItemDto>> Create(PantryItemInput input, CancellationToken ct)
    {
        if (Invalid(input) is { } problem) return BadRequest(problem);
        await _units.LoadAsync(ct);

        var now = _clock.GetUtcNow().UtcDateTime;
        var item = new PantryItem
        {
            Name = input.Name.Trim(),
            Location = Parse<PantryLocation>(input.Location) ?? PantryLocation.Cupboard,
            Tracking = Parse<TrackingClass>(input.Tracking) ?? TrackingClass.Counted,
            // "ounces", "OZ" and "Oz." are one unit, stored once — otherwise the shelf and the
            // recipe that wants it spell the same thing differently and never meet.
            Unit = _units.Normalise(input.Unit),
            PackSize = Pack(input.PackSize),
            PackUnit = Pack(input.PackSize) is null ? null : _units.Normalise(input.PackUnit),
            CreatedUtc = now,
            UpdatedUtc = now,
        };
        _db.PantryItems.Add(item);

        // Before the ledger write, so a refused barcode costs nothing: nothing has been recorded yet
        // and the caller gets its sentence back with the shelves untouched.
        if (Blank(input.Barcode) is { } code
            && await AttachBarcodeAsync(item, code, input.BarcodeFormat, ct) is { } refusal)
        {
            return BadRequest(refusal);
        }

        // Through the ledger, never assigned: the row and its history have to agree from the first
        // moment, or `SEEN TODAY` on a brand-new item is already a claim nothing backs.
        _ledger.Record(
            item, PantryEventKind.TypedIn, this.CallerId(),
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
        await _units.LoadAsync(ct);

        var item = await _db.PantryItems.FirstOrDefaultAsync(i => i.Id == id, ct);
        if (item is null) return NotFound();
        // The pantry has no long forms, so the terse conflict strip is enough — PANTRY_BEHAVIOURS §4
        // is explicit that no yours-vs-theirs screen is needed here.
        if (baseVersion is { } v && v != item.Version) return Conflict(await BuildAsync(item, ct));

        item.Name = input.Name.Trim();
        item.Location = Parse<PantryLocation>(input.Location) ?? item.Location;
        item.Unit = _units.Normalise(input.Unit);
        // Clearing the pack size clears its unit with it: "3 of nothing" is not a state, and a
        // stranded pack unit would make PantryAmounts read a loose row as a packaged one.
        item.PackSize = Pack(input.PackSize);
        item.PackUnit = item.PackSize is null ? null : _units.Normalise(input.PackUnit);

        var tracking = Parse<TrackingClass>(input.Tracking) ?? item.Tracking;
        if (tracking != item.Tracking)
        {
            item.Tracking = tracking;
            // Changing class resets the other class's field, so an item switched to Estimated does
            // not keep a stale count that nothing will ever update again.
            if (tracking != TrackingClass.Counted) item.Quantity = null;
            if (tracking != TrackingClass.Estimated) item.EstimateState = null;
        }

        /*
         * The barcode, after the fields above so the catalogue learns the *amended* item.
         *
         * Three cases, and all three end with the code and the household's words agreeing:
         *   - a code supplied where there was none — attach it and teach the catalogue;
         *   - a code supplied that differs — move it, and the old entry keeps naming whatever it
         *     named, because a barcode nobody re-used is not evidence of anything;
         *   - no code supplied but the item already carries one — re-teach from the new fields, so
         *     renaming "Coca-Cola Zero Sugar 355 ml" to "Coke Zero" makes the next scan say Coke
         *     Zero. Silence here is not a request to unlink; clearing a code means sending a blank
         *     one, which `Blank` turns into null and `CatalogueRef` follows.
         */
        if (Blank(input.Barcode) is { } code)
        {
            if (await AttachBarcodeAsync(item, code, input.BarcodeFormat, ct) is { } refusal)
            {
                return BadRequest(refusal);
            }
        }
        else if (input.Barcode is not null)
        {
            // An explicit empty string — the field was cleared. The catalogue entry stays: it is the
            // household's record of what that code means, and unlinking one item from it says
            // nothing about the next pack.
            item.CatalogueRef = null;
        }
        else if (item.CatalogueRef is { } existing)
        {
            await TeachCatalogueAsync(existing, item.Name, item.Unit, item.Location, item.Tracking, null, ct);
        }

        _ledger.Record(
            item, PantryEventKind.Corrected, this.CallerId(),
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
                    ? new ProductSuggestionDto(
                        // Brand in front of the product, because the catalogue splits them and the
                        // product half is often generic to the point of being useless on a shelf:
                        // "Pickle Spears" is a row you cannot tell from the other jar of pickles,
                        // and the database knew it was Grillo's all along. See ProductNames.Specific.
                        ProductNames.Specific(found.Brand, found.Name)!,
                        found.Brand, found.Unit, found.PackSize, found.Source)
                    : null);
        }

        var location = Parse<PantryLocation>(input.Location) ?? entry.DefaultLocation;

        // What the catalogue says one pack is. A stated size makes the row packaged: `Quantity`
        // becomes a count of packs and the shelf reads `500 g ×2`. A countable default unit ("cans",
        // "ea") is a pack of one whatever net weight the database also carries — a tin is a tin.
        var packSize = entry.PackSize is > 0 && !UnitConversion.IsCountable(entry.DefaultUnit)
            ? entry.PackSize
            : null;
        var packUnit = packSize is null ? null : entry.DefaultUnit;

        // The barcode first, because it already encodes brand, product *and* size — the grouping key
        // done by the manufacturer. The name fallback exists for a shelf someone typed in before
        // ever scanning it, and it has to match on size too: a 3 oz pot and a 32 oz tub share a name
        // and are two different things to run out of (PantryAmounts.SameProduct).
        var item = await _db.PantryItems
            .FirstOrDefaultAsync(i => !i.IsArchived && i.CatalogueRef == barcode, ct);
        if (item is null)
        {
            var named = await _db.PantryItems
                .Where(i => !i.IsArchived && i.Name == entry.Name)
                .ToListAsync(ct);
            item = named.FirstOrDefault(i => PantryAmounts.SameProduct(i, entry.Name, packSize, packUnit));
        }

        var now = _clock.GetUtcNow().UtcDateTime;
        var isNew = item is null;
        if (item is null)
        {
            item = new PantryItem
            {
                Name = entry.Name,
                Location = location,
                Tracking = entry.DefaultTracking,
                // A packaged row counts containers, so its display unit is the container rather than
                // the net weight — the weight is the pack size, and saying it twice would make
                // `3 oz ×5` read as `3 oz ×5 oz`.
                Unit = packSize is null ? entry.DefaultUnit : null,
                PackSize = packSize,
                PackUnit = packUnit,
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

        /*
         * How much one scan is worth.
         *
         * One scan is one package, and the whole reason `PackSize` is a column is that the previous
         * answer multiplied it into the item's unit instead: a 500 g bag arrived as "+500 g", so
         * five of them read as 2500 g — a number nobody can check by looking at a shelf.
         *
         * A row that predates the catalogue knowing a size has to be brought across, or the second
         * scan of the bag would add 1 to a count of grams, which is the "+1 g" error this used to
         * exist to prevent. Three cases, and the third is the one that keeps it honest:
         */
        var perScan = 1m;
        if (packSize is { } size && !PantryAmounts.IsPackaged(item))
        {
            if (item.Quantity is null or 0)
            {
                // Nothing counted yet, so there is nothing to convert and no way to be wrong.
                item.PackSize = size;
                item.PackUnit = packUnit;
                item.Unit = null;
            }
            else if (UnitRegistry.Fold(item.Unit ?? string.Empty) == UnitRegistry.Fold(packUnit ?? string.Empty))
            {
                // The row was counting the very thing the pack is measured in — 500 g of a 500 g
                // bag — so the same shelf can be restated as one package without inventing anything.
                item.Quantity = item.Quantity / size;
                item.PackSize = size;
                item.PackUnit = packUnit;
                item.Unit = null;
            }
            else
            {
                // The shelf is counted in something else — "4 boxes" of a product the catalogue
                // measures in grams. Restating the count as packages would need a conversion nobody
                // can make, so the row stays exactly as it is and the scan adds one pack's worth in
                // the unit it already uses: converted where that is honest arithmetic, and otherwise
                // one of whatever it counts. A countable row gets 1 because a box is a box, whatever
                // net weight the database also carries.
                perScan = UnitConversion.Convert(size, packUnit, item.Unit)
                    ?? (UnitConversion.IsCountable(item.Unit) ? 1m : size);
            }
        }

        var evt = _ledger.Record(
            item, PantryEventKind.Scanned, this.CallerId(),
            delta: input.Delta * perScan,
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
        await _units.LoadAsync(ct);

        // The one path that knows what a pack is worth, because the phone asked while somebody was
        // holding it. Every other route in leaves that field alone — see TeachCatalogueAsync.
        var entry = await TeachCatalogueAsync(
            barcode,
            // Cased here, on the scan path only: this is a pack being named for the first time, or a
            // suggestion out of a stranger's database, and neither is the household's own words yet.
            // A name typed into the row sheet is left exactly as typed — see ProductNames.
            ProductNames.TitleCase(input.Name)!,
            // A suggestion out of an outside catalogue arrives spelled however that database spells
            // it — this is where "grams" becomes the g every other screen uses.
            _units.Normalise(input.Unit),
            Parse<PantryLocation>(input.Location) ?? PantryLocation.Cupboard,
            Parse<TrackingClass>(input.Tracking) ?? TrackingClass.Counted,
            input.PackSize,
            ct);

        await _db.SaveChangesAsync(ct);
        return entry;
    }

    /// <summary>
    /// Write (or refresh) the household's catalogue entry for a barcode.
    /// </summary>
    /// <remarks>
    /// <b>The single definition of "teach the catalogue".</b> Three routes reach it — <c>NAME IT</c>
    /// on the phone, and adding or amending an item by hand with a barcode in the box — and they had
    /// better agree, because what they write is what every later scan resolves against.
    /// <para>
    /// <paramref name="packSize"/> is applied <b>only when stated</b>. A hand entry does not know
    /// what one pack weighs, and writing null over the 500 g that <c>NAME IT</c> recorded while
    /// somebody was holding the bag would quietly turn every later scan of it into "+1 g". Not
    /// stating a thing must never overwrite a thing somebody stated.
    /// </para>
    /// <para>
    /// The household's own words win. Re-teaching a known barcode overwrites the name, which is the
    /// point: rename the row to what you actually call it, and the next scan says that.
    /// </para>
    /// </remarks>
    private async Task<ProductCatalogueEntry> TeachCatalogueAsync(
        string barcode,
        string name,
        string? unit,
        PantryLocation location,
        TrackingClass tracking,
        decimal? packSize,
        CancellationToken ct)
    {
        var entry = await _db.ProductCatalogue
            .FirstOrDefaultAsync(c => c.Barcode == barcode && c.Scope == CatalogueScope.Household, ct);

        if (entry is null)
        {
            entry = new ProductCatalogueEntry
            {
                Barcode = barcode,
                Scope = CatalogueScope.Household,
                CreatedUtc = _clock.GetUtcNow().UtcDateTime,
            };
            _db.ProductCatalogue.Add(entry);
        }

        entry.Name = name.Trim();
        entry.DefaultUnit = unit;
        entry.DefaultLocation = location;
        entry.DefaultTracking = tracking;
        if (packSize is not null) entry.PackSize = packSize;

        return entry;
    }

    /// <summary>
    /// Attach a supplied barcode to an item, and teach the catalogue from that item's own fields.
    /// </summary>
    /// <returns>An error sentence when the code cannot be attached; null on success.</returns>
    /// <remarks>
    /// This is what closes the loop the scan screen opens: a pack the outside lookup could not name
    /// gets typed in by hand, and the code stays with what the household decided to call it, so the
    /// second pack resolves without asking anybody anything.
    /// <para>
    /// Refuses a barcode a different item on the shelves already carries. Two live rows answering to
    /// one code makes every later scan of it a coin toss — <c>Scan</c> resolves on
    /// <c>CatalogueRef == barcode || Name == entry.Name</c> and would land on whichever row the
    /// query happened to return first. An archived item does not count; its code is free again.
    /// </para>
    /// </remarks>
    private async Task<string?> AttachBarcodeAsync(
        PantryItem item, string rawBarcode, string? format, CancellationToken ct)
    {
        var barcode = Barcodes.Normalise(rawBarcode, format);
        if (barcode is null) return "That doesn't look like a grocery barcode.";

        var owner = await _db.PantryItems
            .FirstOrDefaultAsync(i => !i.IsArchived && i.Id != item.Id && i.CatalogueRef == barcode, ct);
        if (owner is not null) return $"That barcode already belongs to {owner.Name}.";

        item.CatalogueRef = barcode;
        await TeachCatalogueAsync(barcode, item.Name, item.Unit, item.Location, item.Tracking, null, ct);
        return null;
    }

    /// <summary>Reverse one event. The run-list undo, the receipt's per-line untick, the row sheet.</summary>
    [HttpPost("events/{id:int}/undo")]
    public async Task<ActionResult<PantryItemDto>> Undo(
        int id, CancellationToken ct)
    {
        // Attribution comes from the session, not the request (AUDIT A1.2). The pantry is shared, so
        // this was never a scoping question — but it is a ledger, and a caller who can name anyone as
        // the author of a change can make the "who touched this last" line say whatever they like.
        var profileId = this.CallerId();
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
        int planEntryId, CancellationToken ct)
    {
        var profileId = this.CallerId();
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
                item, PantryEventKind.Corrected, this.CallerId(),
                // "At least what the recipe needs" — never less, so re-running the check clears the
                // row, which is the acceptance criterion for this action.
                //
                // The figure arrives as a bare number in whatever the shelf measures, so on a
                // packaged row it has to come back through the pack size before it can be a count:
                // "at least 4 oz" of 3 oz pots is a pot and a third, not four pots.
                setQuantity: item.Tracking == TrackingClass.Counted
                    ? Math.Max(item.Quantity ?? 0, PantryAmounts.ToQuantity(item, line.AtLeast ?? 1))
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
        [FromQuery] int planEntryId, CancellationToken ct)
    {
        var receipt = await _deduction.DeductAsync(planEntryId, this.CallerId(), ct);
        if (receipt is null) return NoContent();
        if (receipt.Counted.Count == 0 && receipt.Estimated.Count == 0) return NoContent();
        return Ok(receipt);
    }

    /// <summary>`UNDO ALL` — reverses the whole night. Individual lines use the event undo.</summary>
    [HttpPost("deduct/{planEntryId:int}/undo")]
    public async Task<IActionResult> UndoDeduction(
        int planEntryId, CancellationToken ct)
    {
        var ok = await _deduction.UndoAllAsync(planEntryId, this.CallerId(), ct);
        return ok ? NoContent() : NotFound();
    }

    // ---- helpers ----

    private static string? Blank(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    /// <summary>
    /// A pack size, or null when the item is not packaged.
    /// </summary>
    /// <remarks>
    /// Zero and negative both become null. Zero is what a stepper wound down past one produces, and
    /// a pack of nothing is not a state worth distinguishing from "loose" — it would only ever be a
    /// division by zero waiting in <see cref="PantryAmounts.ToQuantity"/>.
    /// </remarks>
    private static decimal? Pack(decimal? size) => size is > 0 ? size : null;

    private static T? Parse<T>(string? name) where T : struct, Enum =>
        Enum.TryParse<T>(name, ignoreCase: true, out var value) && Enum.IsDefined(value) ? value : null;

    private static string? Invalid(PantryItemInput input)
    {
        if (string.IsNullOrWhiteSpace(input.Name)) return "A name is required.";
        if (input.Name.Trim().Length > PantryFieldLimits.ItemName)
            return $"The name is longer than {PantryFieldLimits.ItemName} characters.";
        if (input.Unit is { } unit && unit.Trim().Length > PantryFieldLimits.Unit)
            return $"The unit is longer than {PantryFieldLimits.Unit} characters.";
        if (input.PackUnit is { } packUnit && packUnit.Trim().Length > PantryFieldLimits.Unit)
            return $"The pack unit is longer than {PantryFieldLimits.Unit} characters.";
        if (input.Quantity is < 0) return "An amount cannot be negative.";
        if (input.PackSize is < 0) return "A pack cannot hold a negative amount.";
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
            item.PackSize, item.PackUnit,
            lastSeen.TryGetValue(item.Id, out var at) ? at : null,
            by is { } id ? names.GetValueOrDefault(id) : null,
            item.CatalogueRef, item.IsArchived, item.Version);
    }
}
