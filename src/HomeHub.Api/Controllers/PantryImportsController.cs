namespace HomeHub.Api.Controllers;

using HomeHub.Api.Calendar.Capture;
using HomeHub.Api.Data;
using HomeHub.Api.Kitchen;
using HomeHub.Api.Pantry;
using HomeHub.Api.Auth;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// "An order arrived" (9d) — one review screen for three input formats.
/// </summary>
/// <remarks>
/// <b>Nothing is written to the pantry until <c>PUT n AWAY</c></b> (DECISIONS PG3). A scan is one
/// item and the run list is its undo; a bad import is twenty-four wrong rows, so this one defers.
/// That is a risk judgement, not an inconsistency.
/// </remarks>
[ApiController]
[Route("api/pantry/imports")]
public class PantryImportsController : ControllerBase
{
    private readonly HomeHubDbContext _db;
    private readonly PantryLedger _ledger;
    private readonly UnitRegistry _units;
    private readonly TimeProvider _clock;
    private readonly IKitchenPhotoReader _photos;

    public PantryImportsController(
        HomeHubDbContext db,
        PantryLedger ledger,
        UnitRegistry units,
        TimeProvider clock,
        IKitchenPhotoReader photos)
    {
        _db = db;
        _ledger = ledger;
        _units = units;
        _clock = clock;
        _photos = photos;
    }

    /// <summary>
    /// Read one screenshot of an order, or a photograph of a till receipt. Writes nothing.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Screenshots, not credentials.</b> There is no consumer API worth having for a supermarket
    /// order, and no reason to ask a household to hand over an account password to get one. A
    /// photograph of the finished order says the same thing and costs nobody a secret.
    /// </para>
    /// <para>
    /// <b>One shot rarely covers a big order</b>, so this reads a single image and hands the lines
    /// back; the panel collects several readings and posts them as one payload to <c>POST /</c>.
    /// Keeping the read separate from the create is what lets somebody add another shot after
    /// seeing what the first one caught, and keeps the import a single reviewable thing rather than
    /// four half-orders.
    /// </para>
    /// </remarks>
    [HttpPost("read-photo")]
    public async Task<ActionResult<PurchaseReadingDto>> ReadPhoto(
        ReadKitchenPhotoRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (string.IsNullOrEmpty(request.ImageBase64)) return BadRequest("A photograph is required.");

        NormalizedImage image;
        try { image = ImageIngress.Normalize(request.ImageBase64, request.MediaType); }
        catch (InvalidDataException ex) { return BadRequest(ex.Message); }

        var reading = await _photos.ReadPurchasesAsync(
            image, ct);

        return Ok(PurchaseReadingDto.From(reading));
    }

    /// <summary>Imports still waiting, for the ruled row above the list on 9a.</summary>
    [HttpGet]
    public async Task<IReadOnlyList<OrderImportDto>> List(
        [FromQuery] string? status, CancellationToken ct)
    {
        var query = _db.OrderImports.Include(i => i.Lines).AsQueryable();
        if (Enum.TryParse<OrderImportStatus>(status, true, out var wanted))
            query = query.Where(i => i.Status == wanted);

        var imports = await query.OrderByDescending(i => i.CreatedUtc).Take(20).ToListAsync(ct);
        var names = await _db.Profiles.ToDictionaryAsync(p => p.Id, p => p.Name, ct);
        return imports.Select(i => ToDto(i, names)).ToList();
    }

    [HttpGet("{id:int}")]
    public async Task<ActionResult<OrderImportDto>> Get(int id, CancellationToken ct)
    {
        var import = await LoadAsync(id, ct);
        if (import is null) return NotFound();
        var names = await _db.Profiles.ToDictionaryAsync(p => p.Id, p => p.Name, ct);
        return ToDto(import, names);
    }

    /// <summary>
    /// Accept a payload and parse it. Parsing is server-side, so a phone sharing an order and a
    /// panel pasting an email get identical results.
    /// </summary>
    /// <remarks>
    /// A payload nothing could be read from is <b>not an error</b>: it comes back with a
    /// <c>0 / 0 / n</c> tally and lands on the documented state where the only action is `NOT NOW`
    /// (PANTRY_BEHAVIOURS §6). Never a stack trace, never "invalid format".
    /// </remarks>
    [HttpPost]
    public async Task<ActionResult<OrderImportDto>> Create(OrderImportInput input, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(input.RawPayload))
            return BadRequest("There was nothing in that to read.");
        if (input.RawPayload.Length > PantryFieldLimits.RawPayload)
            return BadRequest("That order is too large to read in one go.");
        await _units.LoadAsync(ct);

        var now = _clock.GetUtcNow().UtcDateTime;
        var import = new OrderImport
        {
            Source = Enum.TryParse<OrderImportSource>(input.Source, true, out var s) ? s : OrderImportSource.Email,
            VendorLabel = string.IsNullOrWhiteSpace(input.VendorLabel) ? null : input.VendorLabel.Trim(),
            RawPayload = input.RawPayload,
            DeliveredAtUtc = input.DeliveredAtUtc ?? now,
            CreatedUtc = now,
            Status = OrderImportStatus.Pending,
        };

        var items = await _db.PantryItems.Where(i => !i.IsArchived).ToListAsync(ct);
        var byKey = new Dictionary<string, PantryItem>();
        foreach (var item in items)
        {
            var key = IngredientNormaliser.Normalise(item.Name);
            if (key.Length > 0) byKey.TryAdd(key, item);
        }

        var position = 0;
        foreach (var parsed in OrderImportParser.Parse(input.RawPayload))
        {
            var line = new OrderImportLine
            {
                RawText = parsed.RawText,
                Position = position++,
                ProposedName = parsed.Name,
                ProposedQuantity = parsed.Quantity,
                // The parser reads pack sizes off receipt shorthand ("32Z", "500G"), so the unit it
                // hands back is the grocer's spelling rather than the household's. Normalised here,
                // where the line is still a proposal, so the review screen shows what would actually
                // be written.
                ProposedUnit = _units.Normalise(parsed.Unit),
                GuessFromPounds = parsed.PoundsPerPack,
            };

            if (parsed.Unreadable || parsed.Name is null)
            {
                line.Confidence = ImportLineConfidence.Unreadable;
            }
            else
            {
                var key = IngredientNormaliser.Normalise(parsed.Name);
                if (key.Length > 0 && byKey.TryGetValue(key, out var match))
                {
                    line.MatchedPantryItemId = match.Id;
                    line.ProposedLocation = match.Location;
                    line.ProposedTracking = match.Tracking;
                    line.ProposedUnit = match.Unit ?? line.ProposedUnit;
                    line.Confidence = ImportLineConfidence.Matched;
                }
                else
                {
                    line.Confidence = ImportLineConfidence.New;
                    line.ProposedLocation = GuessLocation(parsed.Name);
                }

                // A weight-derived count says so whatever else it matched — the guess is the risk,
                // not the match (DECISIONS PG5).
                if (parsed.PoundsPerPack is not null) line.Confidence = ImportLineConfidence.WeightGuess;
            }

            import.Lines.Add(line);
        }

        _db.OrderImports.Add(import);
        await _db.SaveChangesAsync(ct);

        var names = await _db.Profiles.ToDictionaryAsync(p => p.Id, p => p.Name, ct);
        return ToDto(import, names);
    }

    /// <summary>Correct a line before applying — the `TAP TO CORRECT` path.</summary>
    [HttpPatch("{id:int}/lines/{lineId:int}")]
    public async Task<ActionResult<OrderImportDto>> UpdateLine(
        int id, int lineId, ImportLineInput input, CancellationToken ct)
    {
        var import = await LoadAsync(id, ct);
        if (import is null) return NotFound();
        if (import.Status != OrderImportStatus.Pending) return BadRequest("That order has already been dealt with.");
        await _units.LoadAsync(ct);

        var line = import.Lines.FirstOrDefault(l => l.Id == lineId);
        if (line is null) return NotFound();

        if (!string.IsNullOrWhiteSpace(input.ProposedName)) line.ProposedName = input.ProposedName.Trim();
        if (input.ProposedQuantity is not null) line.ProposedQuantity = input.ProposedQuantity;
        if (input.ProposedUnit is not null) line.ProposedUnit = _units.Normalise(input.ProposedUnit);
        if (Enum.TryParse<PantryLocation>(input.ProposedLocation, true, out var loc)) line.ProposedLocation = loc;
        if (Enum.TryParse<TrackingClass>(input.ProposedTracking, true, out var track)) line.ProposedTracking = track;
        if (input.MatchedPantryItemId is not null) line.MatchedPantryItemId = input.MatchedPantryItemId;

        // A corrected line is no longer a guess and no longer unreadable — a human just read it.
        // Keeping the brass "about 6" after somebody typed the real number would be the panel
        // hedging about a fact it was handed.
        if (!string.IsNullOrWhiteSpace(line.ProposedName))
        {
            line.Confidence = line.MatchedPantryItemId is not null
                ? ImportLineConfidence.Matched
                : ImportLineConfidence.New;
            line.GuessFromPounds = null;
        }

        await _db.SaveChangesAsync(ct);
        var names = await _db.Profiles.ToDictionaryAsync(p => p.Id, p => p.Name, ct);
        return ToDto(import, names);
    }

    /// <summary>
    /// `PUT n AWAY` — all-or-nothing for the readable lines.
    /// </summary>
    /// <remarks>
    /// A second person applying an already-applied import gets <b>409 with the applied import</b>,
    /// so the screen can say "Lincoln put this away four minutes ago" instead of failing or, worse,
    /// putting everything away twice (DECISIONS PG7).
    /// </remarks>
    [HttpPost("{id:int}/apply")]
    public async Task<ActionResult<OrderImportDto>> Apply(int id, ApplyImportInput input, CancellationToken ct)
    {
        var import = await LoadAsync(id, ct);
        if (import is null) return NotFound();

        var names = await _db.Profiles.ToDictionaryAsync(p => p.Id, p => p.Name, ct);
        if (import.Status == OrderImportStatus.Applied) return Conflict(ToDto(import, names));
        if (import.Status == OrderImportStatus.Discarded) return BadRequest("That order was thrown away.");

        var now = _clock.GetUtcNow().UtcDateTime;
        var items = await _db.PantryItems.Where(i => !i.IsArchived).ToListAsync(ct);

        foreach (var line in import.Lines.OrderBy(l => l.Position))
        {
            // The ones it couldn't read stay behind until they are named — the footer says so.
            if (line.Confidence == ImportLineConfidence.Unreadable || line.ProposedName is null) continue;

            var item = line.MatchedPantryItemId is { } matchedId
                ? items.FirstOrDefault(i => i.Id == matchedId)
                : items.FirstOrDefault(i =>
                    IngredientNormaliser.Normalise(i.Name) == IngredientNormaliser.Normalise(line.ProposedName));

            if (item is null)
            {
                item = new PantryItem
                {
                    Name = line.ProposedName,
                    Location = line.ProposedLocation,
                    Tracking = line.ProposedTracking,
                    Unit = line.ProposedUnit,
                    CreatedUtc = now,
                    UpdatedUtc = now,
                };
                _db.PantryItems.Add(item);
                items.Add(item);
            }

            _ledger.Record(
                item, PantryEventKind.Imported, this.CallerId(),
                delta: item.Tracking == TrackingClass.Counted ? line.ProposedQuantity ?? 1 : null,
                setState: item.Tracking == TrackingClass.Estimated ? EstimateState.Plenty : null,
                sourceKind: PantryEventSource.OrderImport, sourceId: import.Id);

            line.Applied = true;
        }

        import.Status = OrderImportStatus.Applied;
        import.AppliedAtUtc = now;
        import.AppliedByProfileId = this.CallerId();

        await _db.SaveChangesAsync(ct);
        await SeedAliasesAsync(items, ct);
        await _db.SaveChangesAsync(ct);

        return ToDto(import, names);
    }

    /// <summary>Reverse a whole import. Available for 24 hours (PANTRY_BEHAVIOURS §3).</summary>
    [HttpPost("{id:int}/undo")]
    public async Task<IActionResult> Undo(int id, CancellationToken ct)
    {
        var profileId = this.CallerId();
        var import = await _db.OrderImports.FirstOrDefaultAsync(i => i.Id == id, ct);
        if (import is null) return NotFound();
        if (import.Status != OrderImportStatus.Applied) return BadRequest("That order hasn't been put away.");

        var cutoff = _clock.GetUtcNow().UtcDateTime.AddHours(-24);
        if (import.AppliedAtUtc is { } applied && applied < cutoff)
            return BadRequest("That was put away more than a day ago — change the items instead.");

        var events = await _db.PantryEvents
            .Where(e => e.SourceKind == PantryEventSource.OrderImport
                && e.SourceId == id
                && e.UndoneByEventId == null
                && e.Kind == PantryEventKind.Imported)
            .Select(e => e.Id)
            .ToListAsync(ct);
        foreach (var eventId in events) await _ledger.UndoAsync(eventId, profileId, ct);

        import.Status = OrderImportStatus.Pending;
        import.AppliedAtUtc = null;
        import.AppliedByProfileId = null;
        foreach (var line in await _db.OrderImportLines.Where(l => l.ImportId == id).ToListAsync(ct))
            line.Applied = false;

        await _db.SaveChangesAsync(ct);
        return NoContent();
    }

    /// <summary>`NOT NOW` leaves it pending; this is the explicit throw-away.</summary>
    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Discard(int id, CancellationToken ct)
    {
        var import = await _db.OrderImports.FirstOrDefaultAsync(i => i.Id == id, ct);
        if (import is null) return NotFound();
        if (import.Status == OrderImportStatus.Applied)
            return BadRequest("That order is already put away — undo it first.");

        import.Status = OrderImportStatus.Discarded;
        await _db.SaveChangesAsync(ct);
        return NoContent();
    }

    // ---- helpers ----

    private Task<OrderImport?> LoadAsync(int id, CancellationToken ct) =>
        _db.OrderImports.Include(i => i.Lines).FirstOrDefaultAsync(i => i.Id == id, ct);

    /// <summary>
    /// Where a new thing probably lives. A guess, and only ever a default on a screen that shows the
    /// location control right beside it — nothing downstream treats this as knowledge.
    /// </summary>
    private static PantryLocation GuessLocation(string name)
    {
        var key = IngredientNormaliser.Normalise(name);
        string[] fridge = ["milk", "cream", "butter", "cheese", "yogurt", "egg", "juice", "chicken", "beef", "pork"];
        string[] freezer = ["frozen", "ice", "pea", "salmon fillet"];
        if (freezer.Any(w => key.Contains(w, StringComparison.Ordinal))) return PantryLocation.Freezer;
        if (fridge.Any(w => key.Contains(w, StringComparison.Ordinal))) return PantryLocation.Fridge;
        return PantryLocation.Cupboard;
    }

    private async Task SeedAliasesAsync(IReadOnlyList<PantryItem> items, CancellationToken ct)
    {
        var known = await _db.IngredientAliases.Select(a => a.Alias).ToListAsync(ct);
        var seen = known.ToHashSet();
        var now = _clock.GetUtcNow().UtcDateTime;

        foreach (var item in items)
        {
            var key = IngredientNormaliser.Normalise(item.Name);
            if (key.Length == 0 || !seen.Add(key)) continue;
            _db.IngredientAliases.Add(new IngredientAlias
            {
                Alias = key,
                PantryItemId = item.Id,
                Confidence = AliasConfidence.Seeded,
                CreatedUtc = now,
            });
        }
    }

    private static OrderImportDto ToDto(OrderImport import, IReadOnlyDictionary<int, string> names) =>
        new(
            import.Id, import.Source.ToString(), import.VendorLabel, import.DeliveredAtUtc,
            import.Status.ToString(),
            import.Lines.OrderBy(l => l.Position).Select(l => new OrderImportLineDto(
                l.Id, l.RawText, l.ProposedName, l.ProposedQuantity, l.ProposedUnit,
                l.ProposedLocation.ToString(), l.ProposedTracking.ToString(),
                l.MatchedPantryItemId, l.Confidence.ToString(), l.GuessFromPounds, l.Position)).ToList(),
            import.Lines.Count(l => l.Confidence == ImportLineConfidence.Matched),
            import.Lines.Count(l => l.Confidence is ImportLineConfidence.New or ImportLineConfidence.WeightGuess),
            import.Lines.Count(l => l.Confidence == ImportLineConfidence.Unreadable),
            import.AppliedByProfileId is { } who ? names.GetValueOrDefault(who) : null,
            import.AppliedAtUtc);
}
