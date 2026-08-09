namespace HomeHub.Api.Controllers;

using HomeHub.Api.Data;
using HomeHub.Api.Meals;
using HomeHub.Api.Auth;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// Saved meals — named templates that expand into an arrangement of recipes (MEALS_GROUPS).
/// </summary>
/// <remarks>
/// Its own controller rather than more actions on <see cref="MealsController"/>, which owns the week
/// plan: a meal is a folder item alongside recipes, and the plan is where one lands once assigned.
/// Routed under <c>/api/meals/saved</c> so the client's meals namespace stays in one place.
/// </remarks>
[ApiController]
[Route("api/meals/saved")]
public class MealGroupsController : ControllerBase
{
    private readonly HomeHubDbContext _db;

    public MealGroupsController(HomeHubDbContext db) => _db = db;

    /// <summary>
    /// The folder's meal rows, with component titles included so the meta line renders without a
    /// request per row (MEALS_GROUPS §6.2).
    /// </summary>
    [HttpGet]
    public async Task<IReadOnlyList<MealSummaryDto>> List(
        [FromQuery] bool includeArchived, CancellationToken ct)
    {
        var query = _db.Meals.AsQueryable();
        if (!includeArchived) query = query.Where(m => !m.IsArchived);

        var meals = await query
            .OrderBy(m => m.Name)
            .Select(m => new
            {
                m.Id, m.Name, m.Servings, m.PrepNote, m.Cuisine, m.IsArchived, m.Version,
                Components = m.Components
                    .OrderBy(c => c.Position)
                    .Select(c => new { c.RecipeId, Title = c.Recipe!.Title, c.Recipe.TotalMinutes })
                    .ToList(),
            })
            .ToListAsync(ct);

        // Cooked history for the meal as a unit: a night counts once the *whole* set was confirmed
        // eaten, which is what makes "COOKED 4×" mean four dinners rather than four dishes.
        var history = await MealHistoryAsync(meals.Select(m => m.Id).ToList(), ct);

        return meals.Select(m =>
        {
            var (last, times) = history.GetValueOrDefault(m.Id);
            return new MealSummaryDto(
                m.Id, m.Name, m.Servings, m.PrepNote, m.Cuisine, m.IsArchived,
                m.Components.Select(c => c.Title).ToList(),
                m.Components.Count,
                // Null only when not one component says how long it takes — a partial sum is still
                // the best answer available, and the alternative is showing nothing for a meal whose
                // main is timed and whose side is not.
                m.Components.Any(c => c.TotalMinutes is not null)
                    ? m.Components.Sum(c => c.TotalMinutes ?? 0)
                    : null,
                last, times, m.Version);
        }).ToList();
    }

    [HttpGet("{id:int}")]
    public async Task<ActionResult<MealDto>> Get(int id, CancellationToken ct)
    {
        var meal = await LoadAsync(id, ct);
        if (meal is null) return NotFound();
        var history = await MealHistoryAsync([id], ct);
        var (last, times) = history.GetValueOrDefault(id);
        return await ToDtoAsync(meal, last, times, ct);
    }

    [HttpPost]
    public async Task<ActionResult<MealDto>> Create(MealInput input, CancellationToken ct)
    {
        if (Invalid(input) is { } problem) return BadRequest(problem);

        var now = DateTime.UtcNow;
        var meal = new Meal { Name = input.Name.Trim(), CreatedUtc = now, UpdatedUtc = now };
        if (await ApplyAsync(meal, input, now, ct) is { } applyProblem) return BadRequest(applyProblem);

        _db.Meals.Add(meal);
        await _db.SaveChangesAsync(ct);

        var saved = await LoadAsync(meal.Id, ct);
        return await ToDtoAsync(saved!, null, 0, ct);
    }

    [HttpPut("{id:int}")]
    public async Task<ActionResult<MealDto>> Replace(
        int id, MealInput input, [FromQuery] int? baseVersion, CancellationToken ct)
    {
        if (Invalid(input) is { } problem) return BadRequest(problem);

        var meal = await LoadAsync(id, ct);
        if (meal is null) return NotFound();

        var history = await MealHistoryAsync([id], ct);
        var (last, times) = history.GetValueOrDefault(id);
        if (baseVersion is { } v && v != meal.Version) return Conflict(await ToDtoAsync(meal, last, times, ct));

        var now = DateTime.UtcNow;
        meal.Name = input.Name.Trim();
        if (await ApplyAsync(meal, input, now, ct) is { } applyProblem) return BadRequest(applyProblem);
        meal.UpdatedUtc = now;
        meal.Version++;

        await _db.SaveChangesAsync(ct);
        return await ToDtoAsync(meal, last, times, ct);
    }

    /// <summary>
    /// Delete a saved meal. <b>Never deletes its recipes</b> (MEALS_GROUPS §3) — a meal is a
    /// shortcut, and removing the shortcut cannot remove the things it pointed at. Nights already
    /// planned from it are untouched, because they never referenced it.
    /// </summary>
    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id, [FromQuery] int? baseVersion, CancellationToken ct)
    {
        var meal = await LoadAsync(id, ct);
        if (meal is null) return NotFound();

        if (baseVersion is { } v && v != meal.Version)
        {
            var history = await MealHistoryAsync([id], ct);
            var (last, times) = history.GetValueOrDefault(id);
            return Conflict(await ToDtoAsync(meal, last, times, ct));
        }

        // Components cascade; the recipes they point at do not.
        _db.Meals.Remove(meal);
        await _db.SaveChangesAsync(ct);
        return NoContent();
    }

    /// <summary>
    /// Put a saved meal on a night, expanding it into one plan entry per component.
    /// </summary>
    /// <remarks>
    /// <b>Expands rather than links</b> (MEALS_GROUPS §6.2). The night records what is actually being
    /// cooked, so editing the template next month cannot silently rewrite a night already planned —
    /// and a night can then be adjusted (drop the dessert, swap the side) without that being an edit
    /// to the template.
    /// </remarks>
    [HttpPost("{id:int}/assign")]
    public async Task<ActionResult<IReadOnlyList<MealPlanEntryDto>>> Assign(
        int id, AssignMealInput input, CancellationToken ct)
    {
        if (!Enum.IsDefined(input.Slot)) return BadRequest($"Unknown meal slot '{(int)input.Slot}'.");

        var meal = await LoadAsync(id, ct);
        if (meal is null) return NotFound();
        if (meal.Components.Count == 0) return BadRequest("That meal has no recipes in it yet.");

        // Assigning a meal replaces whatever was on the night — picking "Spaghetti Night" means the
        // night *is* that, not that it gains two more dishes.
        var existing = await _db.MealPlanEntries
            .Where(e => e.Date == input.Date && e.Slot == input.Slot)
            .ToListAsync(ct);
        _db.MealPlanEntries.RemoveRange(existing);

        var now = DateTime.UtcNow;
        var servings = input.ServingsOverride ?? meal.Servings;
        var created = new List<MealPlanEntry>();
        var position = 0;
        foreach (var component in meal.Components.OrderBy(c => c.Position))
        {
            var entry = new MealPlanEntry
            {
                Date = input.Date,
                Slot = input.Slot,
                RecipeId = component.RecipeId,
                Position = position++,
                Role = component.Role,
                ServingsOverride = servings,
                CreatedUtc = now,
                UpdatedUtc = now,
            };
            _db.MealPlanEntries.Add(entry);
            created.Add(entry);
        }

        await _db.SaveChangesAsync(ct);
        foreach (var entry in created) await _db.Entry(entry).Reference(e => e.Recipe).LoadAsync(ct);
        return created.Select(MealPlanEntryDto.From).ToList();
    }

    /// <summary>
    /// Sets of recipes the household has actually cooked together three or more times, so the assign
    /// screen can offer to name the pairing (MEALS_GROUPS §4.3/§6.3).
    /// </summary>
    /// <remarks>
    /// No stored table and no analytics pipeline — the spec is explicit that this is cheap at
    /// household scale. Counts only nights confirmed eaten: offering to name a pairing that was
    /// planned three times and skipped every time would be the panel noticing a habit that does not
    /// exist.
    /// <para>Sets already saved as a meal are excluded — there is nothing left to offer.</para>
    /// </remarks>
    [HttpGet("co-occurrences")]
    public async Task<IReadOnlyList<CoOccurrenceDto>> CoOccurrences(
        [FromQuery] int minimum = 3, [FromQuery] int months = 6, CancellationToken ct = default)
    {
        var since = DateOnly.FromDateTime(DateTime.Now.AddMonths(-Math.Max(1, months)));

        var rows = await _db.MealPlanEntries
            .Where(e => e.WasEaten == true && e.Date >= since && e.RecipeId != null)
            .Select(e => new { e.Date, e.Slot, RecipeId = e.RecipeId!.Value, Title = e.Recipe!.Title })
            .ToListAsync(ct);

        // Grouped in memory: a household's six months of dinners is hundreds of rows, and expressing
        // "identical sets" in SQL costs far more than it saves at that size.
        var nights = rows
            .GroupBy(r => new { r.Date, r.Slot })
            .Select(g => g.DistinctBy(r => r.RecipeId).OrderBy(r => r.RecipeId).ToList())
            .Where(set => set.Count >= 2)
            .ToList();

        var already = await _db.Meals
            .Select(m => m.Components.Select(c => c.RecipeId).OrderBy(x => x).ToList())
            .ToListAsync(ct);
        var saved = already.Select(ids => string.Join(",", ids)).ToHashSet();

        return nights
            .GroupBy(set => string.Join(",", set.Select(r => r.RecipeId)))
            .Where(g => g.Count() >= Math.Max(2, minimum) && !saved.Contains(g.Key))
            .OrderByDescending(g => g.Count())
            .Select(g => new CoOccurrenceDto(
                g.First().Select(r => r.RecipeId).ToList(),
                g.First().Select(r => r.Title).ToList(),
                g.Count()))
            .ToList();
    }

    // ---- helpers ----

    private Task<Meal?> LoadAsync(int id, CancellationToken ct) =>
        _db.Meals
            .Include(m => m.Components).ThenInclude(c => c.Recipe)
            .FirstOrDefaultAsync(m => m.Id == id, ct);

    private static string? Invalid(MealInput input)
    {
        if (string.IsNullOrWhiteSpace(input.Name)) return "A name is required.";
        if (input.Name.Trim().Length > MealFieldLimits.Title)
            return $"The name is longer than {MealFieldLimits.Title} characters.";
        if (input.PrepNote is { } note && note.Trim().Length > MealFieldLimits.PrepNote)
            return $"The note is longer than {MealFieldLimits.PrepNote} characters.";
        var components = input.Components ?? [];
        if (components.Count == 0) return "A meal needs at least one recipe.";
        if (components.Select(c => c.RecipeId).Distinct().Count() != components.Count)
            return "The same recipe can only appear once in a meal.";
        return null;
    }

    private async Task<string?> ApplyAsync(Meal meal, MealInput input, DateTime now, CancellationToken ct)
    {
        var components = input.Components ?? [];
        var ids = components.Select(c => c.RecipeId).ToList();
        var known = await _db.Recipes.Where(r => ids.Contains(r.Id)).Select(r => r.Id).ToListAsync(ct);
        if (known.Count != ids.Count)
            return $"Recipe {ids.First(i => !known.Contains(i))} does not exist.";

        meal.Servings = input.Servings;
        meal.PrepNote = string.IsNullOrWhiteSpace(input.PrepNote) ? null : input.PrepNote.Trim();
        meal.IsArchived = input.IsArchived;

        meal.Components.Clear();
        var position = 0;
        foreach (var component in components)
        {
            meal.Components.Add(new MealComponent
            {
                RecipeId = component.RecipeId,
                // The first component is the main whatever the caller said — §1 makes exactly one
                // main required, and silently accepting a meal with none would leave every screen
                // that reads "the main" with nothing to show.
                Role = position == 0 ? MealRole.Main : component.Role,
                Position = position++,
            });
        }

        // Cuisine defaults to the main's, and is overridable. Resolved here rather than at read time
        // so a later edit to the main's tags doesn't silently re-file the meal.
        if (!string.IsNullOrWhiteSpace(input.Cuisine))
        {
            meal.Cuisine = input.Cuisine.Trim();
        }
        else if (meal.Cuisine is null && components.Count > 0)
        {
            var mainId = components[0].RecipeId;
            meal.Cuisine = await _db.RecipeTags
                .Where(t => t.RecipeId == mainId && t.Tag.StartsWith(Cuisines.Prefix))
                .Select(t => t.Tag)
                .FirstOrDefaultAsync(ct);
        }

        // Attribution from the session (AUDIT A1.2): a caller must not be able to sign somebody
        // else's name to an edit, least of all on the record the notification feed reads to say who
        // changed what.
        if (this.CallerId() is { } editor)
        {
            meal.ModifiedByProfileId = editor;
            meal.ModifiedAtUtc = now;
        }

        return null;
    }

    /// <summary>
    /// Cooked history per meal, counted as a unit: a night counts only when every component of the
    /// meal was on it and confirmed eaten (MEALS_GROUPS §5).
    /// </summary>
    private async Task<Dictionary<int, (DateOnly? Last, int Times)>> MealHistoryAsync(
        IReadOnlyList<int> mealIds, CancellationToken ct)
    {
        var result = new Dictionary<int, (DateOnly?, int)>();
        if (mealIds.Count == 0) return result;

        var sets = await _db.Meals
            .Where(m => mealIds.Contains(m.Id))
            .Select(m => new { m.Id, RecipeIds = m.Components.Select(c => c.RecipeId).ToList() })
            .ToListAsync(ct);

        var today = DateOnly.FromDateTime(DateTime.Now);
        var confirmed = await _db.MealPlanEntries
            .Where(e => e.WasEaten == true && e.Date < today && e.RecipeId != null)
            .Select(e => new { e.Date, e.Slot, RecipeId = e.RecipeId!.Value })
            .ToListAsync(ct);

        var nights = confirmed
            .GroupBy(e => new { e.Date, e.Slot })
            .Select(g => new { g.Key.Date, Ids = g.Select(x => x.RecipeId).ToHashSet() })
            .ToList();

        foreach (var set in sets)
        {
            if (set.RecipeIds.Count == 0) { result[set.Id] = (null, 0); continue; }
            // Superset rather than equality: a night that was the meal plus an extra dessert is
            // still a night that meal was cooked.
            var matches = nights.Where(n => set.RecipeIds.All(n.Ids.Contains)).ToList();
            result[set.Id] = (
                matches.Count == 0 ? null : matches.Max(n => n.Date),
                matches.Count);
        }

        return result;
    }

    private async Task<MealDto> ToDtoAsync(Meal meal, DateOnly? last, int times, CancellationToken ct)
    {
        var editor = meal.ModifiedByProfileId is { } id
            ? await _db.Profiles.Where(p => p.Id == id).Select(p => p.Name).FirstOrDefaultAsync(ct)
            : null;

        var components = meal.Components
            .OrderBy(c => c.Position)
            .Select(c => new MealComponentDto(
                c.RecipeId, c.Recipe?.Title ?? "Unknown", c.Role.ToString(), c.Position,
                c.Recipe?.TotalMinutes, c.Recipe?.Servings, c.Recipe?.SourceName))
            .ToList();

        return new MealDto(
            meal.Id, meal.Name, meal.Servings, meal.PrepNote, meal.Cuisine, meal.IsArchived,
            components,
            components.Any(c => c.TotalMinutes is not null) ? components.Sum(c => c.TotalMinutes ?? 0) : null,
            last, times,
            meal.ModifiedByProfileId, editor, meal.ModifiedAtUtc, meal.Version);
    }
}
