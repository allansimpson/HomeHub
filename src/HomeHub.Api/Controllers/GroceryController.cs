namespace HomeHub.Api.Controllers;

using HomeHub.Api.Data;
using HomeHub.Api.Pantry;
using HomeHub.Api.Auth;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// The household's grocery list (9e) — <b>owned here</b>, and mirrored into Microsoft To Do rather
/// than read from it (DECISIONS P8).
/// </summary>
/// <remarks>
/// Meals and the pantry belong to the household; To Do lists belong to a signed-in profile. Owning
/// the list locally is the only arrangement that survives that mismatch, and it buys two things a
/// mirrored list cannot carry: provenance ("Chicken Piccata · Wed"), and the return trip, where
/// ticking a line puts stock back on the shelf.
/// </remarks>
[ApiController]
[Route("api/grocery")]
public class GroceryController : ControllerBase
{
    private readonly HomeHubDbContext _db;
    private readonly PantryLedger _ledger;
    private readonly GroceryMirrorService _mirror;
    private readonly UnitRegistry _units;
    private readonly TimeProvider _clock;

    public GroceryController(
        HomeHubDbContext db, PantryLedger ledger, GroceryMirrorService mirror,
        UnitRegistry units, TimeProvider clock)
    {
        _db = db;
        _ledger = ledger;
        _mirror = mirror;
        _units = units;
        _clock = clock;
    }

    /// <summary>Open lines plus recently-checked ones, with provenance and the mirror's state.</summary>
    [HttpGet]
    public async Task<GroceryListDto> List(CancellationToken ct)
    {
        var lines = await LoadAsync(ct);
        var names = await _db.Profiles.ToDictionaryAsync(p => p.Id, p => p.Name, ct);
        var items = await _db.PantryItems
            .Where(i => lines.Select(l => l.PantryItemId).Contains(i.Id))
            .ToDictionaryAsync(i => i.Id, ct);

        return new GroceryListDto(
            lines.Select(l => ToDto(l, names, items)).ToList(),
            lines.Count(l => l.CheckedAtUtc is null),
            await _mirror.StatusAsync(ct));
    }

    /// <summary>Add one line, merging into an existing row when it is the same thing (§1).</summary>
    [HttpPost]
    public async Task<ActionResult<GroceryLineDto>> Add(GroceryInput input, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(input.Text)) return BadRequest("Some words are required.");
        if (input.Text.Trim().Length > PantryFieldLimits.GroceryText)
            return BadRequest($"That is longer than {PantryFieldLimits.GroceryText} characters.");
        await _units.LoadAsync(ct);

        var line = await MergeAsync(input, ct);
        await _db.SaveChangesAsync(ct);
        _mirror.RequestSync();
        return await SingleAsync(line.Id, ct);
    }

    /// <summary>
    /// The batch behind 9b's `ADD THE THREE TO THE GROCERY LIST`. Same merge rules, one round trip.
    /// </summary>
    [HttpPost("batch")]
    public async Task<ActionResult<GroceryListDto>> AddMany(GroceryBatchInput input, CancellationToken ct)
    {
        await _units.LoadAsync(ct);
        foreach (var entry in input.Lines)
        {
            if (string.IsNullOrWhiteSpace(entry.Text)) continue;
            await MergeAsync(entry, ct);
        }
        await _db.SaveChangesAsync(ct);
        _mirror.RequestSync();
        return await List(ct);
    }

    [HttpPatch("{id:int}")]
    public async Task<ActionResult<GroceryLineDto>> Update(
        int id, GroceryInput input, [FromQuery] int? baseVersion, CancellationToken ct)
    {
        var line = await _db.GroceryLines.Include(l => l.Sources).FirstOrDefaultAsync(l => l.Id == id, ct);
        if (line is null) return NotFound();
        if (baseVersion is { } v && v != line.Version) return Conflict(await BuildAsync(line, ct));
        await _units.LoadAsync(ct);

        if (!string.IsNullOrWhiteSpace(input.Text)) line.Text = input.Text.Trim();
        line.Quantity = input.Quantity;
        line.Unit = _units.Normalise(input.Unit);
        line.Version++;
        line.MirrorPending = true;

        await _db.SaveChangesAsync(ct);
        _mirror.RequestSync();
        return await BuildAsync(line, ct);
    }

    /// <summary>
    /// Tick a line off — <b>and put the stock back</b>. The return trip is the whole reason the list
    /// is owned locally (DECISIONS P8), and it runs on this one path so a tick in To Do produces
    /// exactly the same pantry event as a tick on the panel.
    /// </summary>
    [HttpPost("{id:int}/check")]
    public async Task<ActionResult<GroceryLineDto>> Check(
        int id, [FromQuery] bool checkedOff = true, CancellationToken ct = default)
    {
        // Attribution comes from the session, not the request (AUDIT A1.2). The pantry is shared, so
        // this was never a scoping question — but it is a ledger, and a caller who can name anyone as
        // the author of a change can make the "who touched this last" line say whatever they like.
        var profileId = this.CallerId();
        var line = await _db.GroceryLines.Include(l => l.Sources).FirstOrDefaultAsync(l => l.Id == id, ct);
        if (line is null) return NotFound();

        var now = _clock.GetUtcNow().UtcDateTime;

        if (checkedOff && line.CheckedAtUtc is null)
        {
            line.CheckedAtUtc = now;
            line.CheckedByProfileId = profileId;

            // Only a line that knows which shelf it belongs to can put anything back. A hand-typed
            // "kitchen roll" ticks off and changes no stock, which is correct — the pantry holds
            // food, and inventing an item from a shopping note would fill it with guesses.
            if (line.PantryItemId is { } itemId)
            {
                var item = await _db.PantryItems.FirstOrDefaultAsync(i => i.Id == itemId, ct);
                if (item is not null)
                {
                    _ledger.Record(
                        item, PantryEventKind.CheckedOff, profileId,
                        delta: item.Tracking == TrackingClass.Counted ? line.Quantity ?? 1 : null,
                        setState: item.Tracking == TrackingClass.Estimated ? EstimateState.Plenty : null,
                        sourceKind: PantryEventSource.GroceryLine, sourceId: line.Id);
                }
            }
        }
        else if (!checkedOff && line.CheckedAtUtc is not null)
        {
            line.CheckedAtUtc = null;
            line.CheckedByProfileId = null;

            // Unticking reverses the stock it put back, through the ledger's compensating event so
            // the item's last-seen age reverts honestly rather than to now.
            var evt = await _db.PantryEvents
                .Where(e => e.SourceKind == PantryEventSource.GroceryLine
                    && e.SourceId == line.Id
                    && e.UndoneByEventId == null
                    && e.Kind == PantryEventKind.CheckedOff)
                .OrderByDescending(e => e.Id)
                .FirstOrDefaultAsync(ct);
            if (evt is not null) await _ledger.UndoAsync(evt.Id, profileId, ct);
        }

        line.Version++;
        line.MirrorPending = true;
        await _db.SaveChangesAsync(ct);
        _mirror.RequestSync();
        return await BuildAsync(line, ct);
    }

    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id, CancellationToken ct)
    {
        var line = await _db.GroceryLines.FirstOrDefaultAsync(l => l.Id == id, ct);
        if (line is null) return NotFound();

        await _mirror.ForgetAsync(line, ct);
        _db.GroceryLines.Remove(line);
        await _db.SaveChangesAsync(ct);
        return NoContent();
    }

    /// <summary>`CLEAR n` — removes the ticked rows. Never touches stock; that already happened.</summary>
    [HttpPost("clear-checked")]
    public async Task<IActionResult> ClearChecked(CancellationToken ct)
    {
        var done = await _db.GroceryLines.Where(l => l.CheckedAtUtc != null).ToListAsync(ct);
        foreach (var line in done) await _mirror.ForgetAsync(line, ct);
        _db.GroceryLines.RemoveRange(done);
        await _db.SaveChangesAsync(ct);
        return NoContent();
    }

    // ---- the mirror ----

    /// <summary>The strip's state, refreshed on render so the relative age stays honest.</summary>
    [HttpGet("mirror")]
    public Task<MirrorStatusDto> Mirror(CancellationToken ct) => _mirror.StatusAsync(ct);

    /// <summary>Choose the list to mirror into, and whose Graph token does it. Null id turns it off.</summary>
    [HttpPut("mirror")]
    public async Task<MirrorStatusDto> SetMirror(MirrorSettingsInput input, CancellationToken ct)
    {
        await _mirror.ConfigureAsync(input, ct);
        return await _mirror.StatusAsync(ct);
    }

    // ---- helpers ----

    /// <summary>
    /// Find the row this line belongs on, or start one.
    /// </summary>
    /// <remarks>
    /// Merge on <see cref="GroceryLine.PantryItemId"/> when set, else on the normalised text (§1).
    /// Two nights needing lemons is one row carrying both provenances — a list that says "Lemons"
    /// twice is a list that gets one of them ignored.
    /// <para>
    /// A <b>checked</b> row is never merged into: ticking something off and then planning another
    /// night that needs it has to put it back on the list, not silently re-open the row somebody
    /// already dealt with.
    /// </para>
    /// </remarks>
    private async Task<GroceryLine> MergeAsync(GroceryInput input, CancellationToken ct)
    {
        var now = _clock.GetUtcNow().UtcDateTime;
        var text = input.Text.Trim();
        var key = IngredientNormaliser.Normalise(text);

        var open = await _db.GroceryLines
            .Include(l => l.Sources)
            .Where(l => l.CheckedAtUtc == null)
            .ToListAsync(ct);

        var line = input.PantryItemId is { } itemId
            ? open.FirstOrDefault(l => l.PantryItemId == itemId)
            : open.FirstOrDefault(l => l.PantryItemId == null
                && key.Length > 0
                && IngredientNormaliser.Normalise(l.Text) == key);

        if (line is null)
        {
            line = new GroceryLine
            {
                Text = text,
                Quantity = input.Quantity,
                Unit = _units.Normalise(input.Unit),
                PantryItemId = input.PantryItemId,
                SourceKind = Enum.TryParse<GroceryLineSource>(input.SourceKind, true, out var s)
                    ? s
                    : GroceryLineSource.Hand,
                CreatedUtc = now,
                AddedByProfileId = this.CallerId(),
                MirrorPending = true,
            };
            _db.GroceryLines.Add(line);
        }
        else
        {
            // The larger of the two amounts, not the sum: two nights each wanting four lemons want
            // four lemons between them far more often than eight, and over-buying by four is a
            // worse error than the shopper adding one more.
            if (input.Quantity is { } q) line.Quantity = Math.Max(line.Quantity ?? 0, q);
            line.MirrorPending = true;
            line.Version++;
        }

        var alreadyClaimed = line.Sources.Any(x =>
            x.RecipeId == input.SourceRecipeId && x.ForDate == input.SourceDate);
        if (!alreadyClaimed)
        {
            line.Sources.Add(new GroceryLineSourceRef
            {
                RecipeId = input.SourceRecipeId,
                RecipeTitle = input.SourceRecipeTitle,
                ForDate = input.SourceDate,
                ByProfileId = this.CallerId(),
                CreatedUtc = now,
            });
        }

        return line;
    }

    private Task<List<GroceryLine>> LoadAsync(CancellationToken ct) =>
        _db.GroceryLines
            .Include(l => l.Sources)
            .OrderBy(l => l.CheckedAtUtc != null)
            .ThenBy(l => l.SourceKind)
            .ThenBy(l => l.CreatedUtc)
            .ToListAsync(ct);

    private async Task<ActionResult<GroceryLineDto>> SingleAsync(int id, CancellationToken ct)
    {
        var line = await _db.GroceryLines.Include(l => l.Sources).FirstOrDefaultAsync(l => l.Id == id, ct);
        return line is null ? NotFound() : await BuildAsync(line, ct);
    }

    private async Task<GroceryLineDto> BuildAsync(GroceryLine line, CancellationToken ct)
    {
        var names = await _db.Profiles.ToDictionaryAsync(p => p.Id, p => p.Name, ct);
        var items = line.PantryItemId is { } id
            ? await _db.PantryItems.Where(i => i.Id == id).ToDictionaryAsync(i => i.Id, ct)
            : [];
        return ToDto(line, names, items);
    }

    private static GroceryLineDto ToDto(
        GroceryLine line,
        IReadOnlyDictionary<int, string> names,
        IReadOnlyDictionary<int, PantryItem> items)
    {
        var provenance = line.Sources
            .OrderBy(s => s.ForDate ?? DateOnly.MaxValue)
            .ThenBy(s => s.CreatedUtc)
            .Select(s => new GroceryProvenanceDto(
                s.RecipeTitle
                    ?? (s.ByProfileId is { } p ? names.GetValueOrDefault(p) : null)
                    ?? "Added by hand",
                s.ForDate))
            .ToList();

        // "Put 1 lb in the fridge" — stated in the words of the shelf it went back on, which is the
        // only way the sentence is any use while unpacking.
        string? returnTrip = null;
        if (line.CheckedAtUtc is not null && line.PantryItemId is { } itemId
            && items.TryGetValue(itemId, out var item))
        {
            var amount = line.Quantity is { } q
                ? $"{Trim(q)}{(string.IsNullOrWhiteSpace(line.Unit) ? "" : " " + line.Unit)}"
                : "it";
            returnTrip = $"Put {amount} in the {item.Location.ToString().ToLowerInvariant()}";
        }

        return new GroceryLineDto(
            line.Id, line.Text, line.Quantity, line.Unit, line.PantryItemId,
            line.SourceKind.ToString(), provenance, line.CheckedAtUtc, returnTrip, line.Version);
    }

    private static string Trim(decimal value) =>
        (value == decimal.Truncate(value) ? decimal.Truncate(value) : value)
            .ToString(System.Globalization.CultureInfo.InvariantCulture);
}
