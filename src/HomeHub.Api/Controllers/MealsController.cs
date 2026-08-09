namespace HomeHub.Api.Controllers;

using HomeHub.Api.Data;
using HomeHub.Api.Meals;
using HomeHub.Api.Auth;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// The week plan — the Meals tab's home screen. Dates here are <see cref="DateOnly"/> household
/// calendar dates, not instants (meals-planning.md D7), so a slot never drifts across midnight.
/// </summary>
[ApiController]
[Route("api/[controller]")]
public class MealsController : ControllerBase
{
    private const int DaysInWeek = 7;

    private readonly HomeHubDbContext _db;
    private readonly MealNotifier _notifier;

    public MealsController(HomeHubDbContext db, MealNotifier notifier)
    {
        _db = db;
        _notifier = notifier;
    }

    /// <summary>
    /// Seven days from <paramref name="start"/> (defaults to today). Days with nothing planned come
    /// back empty rather than missing, so the week screen can render seven ruled rows from one
    /// response without filling gaps itself.
    /// </summary>
    [HttpGet("week")]
    public async Task<ActionResult<MealWeekDto>> Week([FromQuery] DateOnly? start, CancellationToken ct)
    {
        var from = start ?? DateOnly.FromDateTime(DateTime.Now);
        var to = from.AddDays(DaysInWeek - 1);

        var entries = await _db.MealPlanEntries
            .Include(e => e.Recipe)
            .Where(e => e.Date >= from && e.Date <= to)
            .ToListAsync(ct);

        var days = Enumerable.Range(0, DaysInWeek)
            .Select(offset => from.AddDays(offset))
            .Select(date => new MealDayDto(
                date,
                entries.Where(e => e.Date == date)
                    // Slot then Position, so an arrangement arrives in the order it is cooked and
                    // the client never has to re-sort a night to render it.
                    .OrderBy(e => e.Slot).ThenBy(e => e.Position)
                    .Select(MealPlanEntryDto.From)
                    .ToList()))
            .ToList();

        return new MealWeekDto(from, to, days);
    }

    /// <summary>
    /// Assign a slot, replacing whatever was there. An upsert rather than a create because a
    /// date + slot holds at most one plan (enforced by a unique index), which is what makes the
    /// week screen's "tap an empty row" and "tap a filled row" the same operation.
    /// </summary>
    [HttpPut("plan")]
    public async Task<ActionResult<MealPlanEntryDto>> Plan(
        MealPlanInput input, [FromQuery] int? baseVersion, CancellationToken ct)
    {
        var freeText = string.IsNullOrWhiteSpace(input.FreeText) ? null : input.FreeText.Trim();

        // JsonStringEnumConverter accepts raw numbers as well as names, so without this a body of
        // {"slot":99} stores a row in a slot the week screen can neither render nor address.
        if (!Enum.IsDefined(input.Slot)) return BadRequest($"Unknown meal slot '{(int)input.Slot}'.");

        // A slot holds a recipe, a note, or both — never neither, because an entry with neither is
        // an empty row, which is expressed by having no entry at all.
        //
        // Both together is linked leftovers (MEALS_DATA_CONTRACT §3.1): Tuesday lunch reads
        // "Leftovers" and still opens Monday's recipe at the servings it was cooked at. This used
        // to be rejected; the alternative the contract explicitly rules out is storing
        // "Leftovers of Chicken Piccata" as text, which reads the same and links nowhere.
        if (input.RecipeId is null && freeText is null)
            return BadRequest("A plan needs either a recipe or some text.");
        if (freeText is { Length: > MealFieldLimits.FreeText })
            return BadRequest($"The plan text is longer than {MealFieldLimits.FreeText} characters.");

        if (input.RecipeId is { } recipeId && !await _db.Recipes.AnyAsync(r => r.Id == recipeId, ct))
            return NotFound($"Recipe {recipeId} does not exist.");

        var now = DateTime.UtcNow;
        var onSlot = await _db.MealPlanEntries
            .Where(e => e.Date == input.Date && e.Slot == input.Slot)
            .OrderBy(e => e.Position)
            .ToListAsync(ct);

        // `Replace` is the historic behaviour and the default: this recipe becomes the only thing on
        // the night. `Replace: false` adds alongside, which is how an arrangement grows a side
        // (MEALS_GROUPS §4.3). Adding is the deliberate act, so it is the one that has to say so.
        if (input.Replace && onSlot.Count > 1)
        {
            _db.MealPlanEntries.RemoveRange(onSlot.Skip(1));
            onSlot = onSlot.Take(1).ToList();
        }

        // Adding the *same* recipe again is a no-op rather than a duplicate row — a double-tap on
        // the pick list should not put garlic toast on the night twice.
        var existingSame = input.RecipeId is { } id
            ? onSlot.FirstOrDefault(e => e.RecipeId == id)
            : null;

        // Tracked explicitly rather than inferred from `entry.Id == 0`. The in-memory provider the
        // tests run on assigns a key the moment an entity is Added, so an id check reports a
        // brand-new row as pre-existing — and the version then starts at 2, which throws off every
        // conditional write made against it afterwards.
        var isNew = false;

        MealPlanEntry entry;
        if (input.Replace || onSlot.Count == 0)
        {
            entry = onSlot.FirstOrDefault() ?? New();
        }
        else if (existingSame is not null)
        {
            entry = existingSame;
        }
        else
        {
            entry = New();
            entry.Position = onSlot.Count;
            // The first recipe on a night is the Main by definition; anything added after it is a
            // Side unless the caller says otherwise.
            entry.Role = input.Role ?? MealRole.Side;
        }

        if (!isNew)
        {
            if (baseVersion is { } v && v != entry.Version)
            {
                await _db.Entry(entry).Reference(e => e.Recipe).LoadAsync(ct);
                return Conflict(MealPlanEntryDto.From(entry));
            }
            entry.Version++;
            if (input.Role is { } explicitRole) entry.Role = explicitRole;
        }

        MealPlanEntry New()
        {
            var created = new MealPlanEntry
            {
                Date = input.Date,
                Slot = input.Slot,
                CreatedUtc = now,
                Role = input.Role ?? MealRole.Main,
            };
            isNew = true;
            _db.MealPlanEntries.Add(created);
            return created;
        }

        // Re-planning a night onto a different dish drops any answer already given for it. The
        // answer was about what used to be there, and carrying it over would report the new dish as
        // eaten on a night nobody has been asked about — which is the one thing the cooked-history
        // derivation must never be fed. Changing only the servings is not a different dish, so that
        // keeps its answer.
        if (entry.RecipeId != input.RecipeId || entry.FreeText != freeText) entry.WasEaten = null;

        entry.RecipeId = input.RecipeId;
        entry.FreeText = freeText;
        entry.ServingsOverride = input.ServingsOverride;
        entry.UpdatedUtc = now;
        if (input.Replace)
        {
            // Replacing collapses the night back to one dish, so this entry is the main again
            // whatever it used to be.
            entry.Position = 0;
            entry.Role = input.Role ?? MealRole.Main;
        }

        // No unique-index conflict to catch any more: (Date, Slot) is no longer unique, so two
        // writers racing on the same night now both succeed and the night simply holds both — which
        // is a legitimate arrangement rather than a collision. The version check above still guards
        // edit-vs-edit on a single entry.
        await _db.SaveChangesAsync(ct);

        await _db.Entry(entry).Reference(e => e.Recipe).LoadAsync(ct);

        // Only today and tomorrow notify, and only when somebody else did it — the notifier owns
        // both rules so every write path gets them identically.
        await _notifier.PlanChangedAsync(
            input.Date, input.Slot, entry.FreeText ?? entry.Recipe?.Title, this.CallerId(), ct);

        return MealPlanEntryDto.From(entry);
    }

    /// <summary>
    /// Take one recipe off a night, leaving the rest of the arrangement in place.
    /// </summary>
    /// <remarks>
    /// Distinct from <c>DELETE /plan</c>, which empties the whole slot. Removing the side from a
    /// three-dish night is not the same act as cancelling the night, and collapsing the two would
    /// mean the only way to drop a side is to rebuild the night.
    /// <para>Positions are re-packed so the arrangement keeps a contiguous order.</para>
    /// </remarks>
    [HttpDelete("plan/entry/{entryId:int}")]
    public async Task<IActionResult> RemoveEntry(int entryId, CancellationToken ct)
    {
        var entry = await _db.MealPlanEntries.FirstOrDefaultAsync(e => e.Id == entryId, ct);
        if (entry is null) return NoContent();

        var siblings = await _db.MealPlanEntries
            .Where(e => e.Date == entry.Date && e.Slot == entry.Slot && e.Id != entryId)
            .OrderBy(e => e.Position)
            .ToListAsync(ct);

        _db.MealPlanEntries.Remove(entry);

        for (var i = 0; i < siblings.Count; i++)
        {
            siblings[i].Position = i;
            // Removing the main promotes whatever is now first. A night with a side and no main is
            // an arrangement the rest of the section has no way to render.
            if (i == 0) siblings[i].Role = MealRole.Main;
        }

        await _db.SaveChangesAsync(ct);
        return NoContent();
    }

    /// <summary>
    /// Record whether a planned night was actually eaten — the only writer of
    /// <see cref="MealPlanEntry.WasEaten"/> (MEALS_DATA_CONTRACT §3.2).
    /// </summary>
    /// <remarks>
    /// Answers 404 rather than creating a row for an unplanned night: "we ate the thing that was
    /// never planned" has no dish attached to it, so there is nothing the answer could be about.
    /// <para>
    /// No <c>baseVersion</c>. The confirm surface asks a question about a night that has already
    /// happened, and the two ways a race here ends — two people both saying yes, or someone
    /// answering while another edits the servings — both settle on the answer that was given. A
    /// conflict prompt on "did you eat it" would be ceremony over a question with one true answer.
    /// </para>
    /// </remarks>
    [HttpPut("plan/eaten")]
    public async Task<ActionResult<MealPlanEntryDto>> Eaten(MealEatenInput input, CancellationToken ct)
    {
        if (!Enum.IsDefined(input.Slot)) return BadRequest($"Unknown meal slot '{(int)input.Slot}'.");

        // One answer covers the whole night (MEALS_GROUPS §5). The confirm screen names the meal, not
        // each dish — nobody ate the bolognese but not the garlic bread — so every entry on the slot
        // takes the same answer. That is also what makes the history semantics fall out for free:
        // each recipe carries its own confirmed row, so cooking a meal credits every recipe in it.
        var entries = await _db.MealPlanEntries
            .Include(e => e.Recipe)
            .Where(e => e.Date == input.Date && e.Slot == input.Slot)
            .OrderBy(e => e.Position)
            .ToListAsync(ct);
        if (entries.Count == 0) return NotFound($"Nothing is planned for {input.Date:yyyy-MM-dd} {input.Slot}.");

        var now = DateTime.UtcNow;
        foreach (var e in entries)
        {
            e.WasEaten = input.WasEaten;
            e.UpdatedUtc = now;
            e.Version++;
        }
        await _db.SaveChangesAsync(ct);

        // The main is what the night was, so that is what comes back.
        return MealPlanEntryDto.From(entries[0]);
    }

    /// <summary>Clear a slot. Absent is the same as empty, so clearing an empty slot is a no-op, not a 404.</summary>
    /// <remarks>
    /// Both parameters are nullable and checked rather than declared as plain value types. Model
    /// binding fills a missing non-nullable value type with <c>default</c> and raises no error, so
    /// <c>DELETE /api/meals/plan?date=2026-08-03</c> would silently clear that date's *breakfast* and
    /// answer 204 as though it had done what was asked — deleting the wrong plan and reporting success.
    /// </remarks>
    [HttpDelete("plan")]
    public async Task<IActionResult> Clear(
        [FromQuery] DateOnly? date, [FromQuery] MealSlot? slot, [FromQuery] int? baseVersion, CancellationToken ct)
    {
        if (date is not { } onDate) return BadRequest("A date is required.");
        if (slot is not { } inSlot) return BadRequest("A slot is required.");
        if (!Enum.IsDefined(inSlot)) return BadRequest($"Unknown meal slot '{(int)inSlot}'.");

        // Clears the whole arrangement, not just the main — "cancel Tuesday" means the night, and
        // leaving the side behind would be a night consisting of garlic bread. Removing one dish is
        // DELETE /plan/entry/{id}.
        var entries = await _db.MealPlanEntries
            .Where(e => e.Date == onDate && e.Slot == inSlot)
            .OrderBy(e => e.Position)
            .ToListAsync(ct);
        if (entries.Count == 0) return NoContent();

        // Versioned against the main, which is the entry every caller holds a version for.
        if (baseVersion is { } v && v != entries[0].Version)
        {
            await _db.Entry(entries[0]).Reference(e => e.Recipe).LoadAsync(ct);
            return Conflict(MealPlanEntryDto.From(entries[0]));
        }

        _db.MealPlanEntries.RemoveRange(entries);
        await _db.SaveChangesAsync(ct);
        return NoContent();
    }
}
