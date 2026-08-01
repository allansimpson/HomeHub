namespace HomeHub.Api.Controllers;

using HomeHub.Api.Data;
using HomeHub.Api.Meals;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// The household's recipe folder. Talks to the database directly rather than through a provider
/// seam: there is no external system of record for recipes, so there is nothing to swap
/// (meals-planning.md D1). Stage M2 adds <c>POST /import</c> and <c>GET /{id}/image</c> on top of
/// this same controller.
/// </summary>
[ApiController]
[Route("api/[controller]")]
public class RecipesController : ControllerBase
{
    private readonly HomeHubDbContext _db;
    private readonly RecipeImportService _import;
    private readonly MealNotifier _notifier;

    public RecipesController(HomeHubDbContext db, RecipeImportService import, MealNotifier notifier)
    {
        _db = db;
        _import = import;
        _notifier = notifier;
    }

    /// <summary>
    /// The folder list. Archived recipes are hidden unless asked for; <paramref name="tag"/> filters
    /// to one tag (case-insensitive), which is what the Chip filter row sends.
    /// </summary>
    [HttpGet]
    public async Task<IReadOnlyList<RecipeSummaryDto>> List(
        [FromQuery] string? tag, [FromQuery] bool includeArchived, CancellationToken ct)
    {
        // Local copy so the history subqueries below close over the context directly instead of over
        // `this` — capturing the controller in an expression tree drags the whole instance into the
        // closure EF has to translate.
        var db = _db;
        var query = db.Recipes.AsQueryable();

        if (!includeArchived) query = query.Where(r => !r.IsArchived);
        if (!string.IsNullOrWhiteSpace(tag))
        {
            // ToLower() rather than a plain == or EF.Functions.Like: SQL Server's default collation is
            // case-insensitive but the in-memory provider used by the tests is ordinal, and Like isn't
            // translated there at all. This is the one form that means the same thing on both.
            var wanted = tag.Trim().ToLowerInvariant();
            query = query.Where(r => r.Tags.Any(t => t.Tag.ToLower() == wanted));
        }

        // "Cooked" means a night that has passed AND was confirmed eaten. Both halves matter: a
        // future plan is not history, and an unanswered past night is not evidence — counting
        // either would make the folder's NOT LATELY sort quietly wrong, which is the failure the
        // whole wasEaten field exists to prevent (MEALS_DATA_CONTRACT §3.2).
        var today = DateOnly.FromDateTime(DateTime.Now);

        // Counted in SQL, not loaded. Including the children to call .Count on them in memory would
        // drag every ingredient and step row across for a folder that displays neither — roughly
        // 1,600 wasted rows for a hundred recipes, on a screen that polls. The history aggregates
        // below are correlated subqueries for the same reason: the alternative is pulling every
        // plan entry the household has ever had, to end up with three numbers per recipe.
        var rows = await query
            .OrderBy(r => r.Title)
            .Select(r => new
            {
                r.Id,
                r.Title,
                r.Description,
                r.SourceName,
                r.Servings,
                r.YieldText,
                r.TotalMinutes,
                HasImage = r.ImagePath != null,
                r.ImportMethod,
                r.Completeness,
                r.IncompleteReason,
                r.IsArchived,
                Tags = r.Tags.Select(t => t.Tag).ToList(),
                IngredientCount = r.Ingredients.Count,
                StepCount = r.Steps.Count,
                r.LeadMinutes,
                r.PrepNote,
                LastCookedDate = db.MealPlanEntries
                    .Where(e => e.RecipeId == r.Id && e.Date < today && e.WasEaten == true)
                    .Max(e => (DateOnly?)e.Date),
                TimesCooked = db.MealPlanEntries
                    .Count(e => e.RecipeId == r.Id && e.Date < today && e.WasEaten == true),
                LastSkippedDate = db.MealPlanEntries
                    .Where(e => e.RecipeId == r.Id && e.Date < today && e.WasEaten == false)
                    .Max(e => (DateOnly?)e.Date),
                r.ForkedFrom,
                // Resolved in the same query so the folder can indent and label a variation without
                // a request per row. Null when the parent has been deleted — the strip then keeps
                // the name as plain text and drops the link.
                ForkedFromTitle = db.Recipes
                    .Where(p => p.Id == r.ForkedFrom)
                    .Select(p => p.Title)
                    .FirstOrDefault(),
                r.Version,
            })
            .ToListAsync(ct);

        // Enum→name and the tag sort happen here: neither translates to SQL.
        return rows.Select(r => new RecipeSummaryDto(
            r.Id, r.Title, r.Description, r.SourceName, r.Servings, r.YieldText, r.TotalMinutes,
            r.HasImage, r.ImportMethod.ToString(), r.Completeness.ToString(), r.IncompleteReason, r.IsArchived,
            r.Tags.OrderBy(t => t, StringComparer.OrdinalIgnoreCase).ToList(),
            r.IngredientCount, r.StepCount, r.LeadMinutes, r.PrepNote,
            r.LastCookedDate, r.TimesCooked, r.LastSkippedDate,
            r.ForkedFrom, r.ForkedFromTitle, r.Version)).ToList();
    }

    /// <summary>Every tag in use with its recipe count, for the folder's filter row.</summary>
    [HttpGet("tags")]
    public async Task<IReadOnlyList<RecipeTagCountDto>> Tags([FromQuery] bool includeArchived, CancellationToken ct)
    {
        var query = _db.RecipeTags.AsQueryable();
        if (!includeArchived) query = query.Where(t => t.Recipe != null && !t.Recipe.IsArchived);

        var counts = await query
            .GroupBy(t => t.Tag)
            .Select(g => new RecipeTagCountDto(g.Key, g.Count()))
            .ToListAsync(ct);

        return counts.OrderByDescending(t => t.Count).ThenBy(t => t.Tag, StringComparer.OrdinalIgnoreCase).ToList();
    }

    [HttpGet("{id:int}")]
    public async Task<ActionResult<RecipeDto>> Get(int id, CancellationToken ct)
    {
        var recipe = await LoadAsync(id, ct);
        return recipe is null ? NotFound() : RecipeDto.From(recipe, await EditorNameAsync(recipe, ct), await ParentTitleAsync(recipe, ct));
    }

    [HttpPost]
    public async Task<ActionResult<RecipeDto>> Create(RecipeInput input, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(input.Title)) return BadRequest("Title is required.");
        if (TooLong(input) is { } tooLong) return BadRequest(tooLong);

        var now = DateTime.UtcNow;
        var recipe = new Recipe
        {
            Title = input.Title.Trim(),
            ImportMethod = RecipeImportMethod.Manual,
            CreatedUtc = now,
            UpdatedUtc = now,
        };
        Apply(recipe, input, now);

        _db.Recipes.Add(recipe);
        await _db.SaveChangesAsync(ct);
        await _notifier.RecipeAddedAsync(recipe, input.ModifiedByProfileId, ct);
        return CreatedAtAction(
            nameof(Get), new { id = recipe.Id }, RecipeDto.From(recipe, await EditorNameAsync(recipe, ct), await ParentTitleAsync(recipe, ct)));
    }

    /// <summary>
    /// Import a recipe from a URL (meals-planning.md D2/D10) — the primary capture path.
    /// </summary>
    /// <remarks>
    /// <b>This endpoint makes the server fetch a URL a caller supplied</b>, and the API has no
    /// authentication (D6), so it is reachable by anything on the LAN. The SSRF guard in
    /// <see cref="RecipeFetcher"/> is what makes that acceptable — it is not optional hardening and
    /// must not be bypassed by fetching here directly.
    /// <para>
    /// Three outcomes, per D10: <c>Complete</c> saves normally; <c>Partial</c> saves and is flagged
    /// so the panel can say what is missing; <c>Empty</c> writes nothing, because a recipe row with
    /// no recipe in it is worse than an honest "that page publishes none".
    /// </para>
    /// </remarks>
    [HttpPost("import")]
    public async Task<ActionResult<RecipeImportResponse>> Import(RecipeImportInput input, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(input.Url)) return BadRequest("A link is required.");
        if (input.Url.Trim().Length > MealFieldLimits.Url)
            return BadRequest($"That link is longer than {MealFieldLimits.Url} characters.");

        var (confidence, parsed, imageUrl, reason) = await _import.ReadAsync(input.Url.Trim(), ct);

        // Nothing usable on the page. Deliberately a 200 with an explanation rather than an error
        // status: the request was well-formed and the panel needs to render a specific screen for
        // this, not a generic failure.
        if (confidence == ImportConfidence.Empty || parsed is null)
            return new RecipeImportResponse(nameof(ImportConfidence.Empty), null, reason);

        if (TooLong(parsed) is { } tooLong)
            return new RecipeImportResponse(nameof(ImportConfidence.Empty), null, tooLong);

        var now = DateTime.UtcNow;
        var recipe = new Recipe
        {
            Title = parsed.Title.Trim(),
            // The one place ImportMethod is anything but Manual — provenance the folder can show.
            ImportMethod = RecipeImportMethod.JsonLd,
            Completeness = confidence == ImportConfidence.Complete
                ? RecipeCompleteness.Complete
                : RecipeCompleteness.Partial,
            IncompleteReason = confidence == ImportConfidence.Complete ? null : Truncate(reason ?? "Incomplete page", MealFieldLimits.IncompleteReason),
            CreatedUtc = now,
            UpdatedUtc = now,
        };
        Apply(recipe, parsed, now);
        // Apply() is shared with the manual path and does not know about import-only fields.
        recipe.ImageSourceUrl = imageUrl is null ? null : Truncate(imageUrl, MealFieldLimits.Url);
        recipe.ModifiedByProfileId = input.ProfileId;
        if (input.ProfileId is not null) recipe.ModifiedAtUtc = now;

        _db.Recipes.Add(recipe);
        await _db.SaveChangesAsync(ct);

        // After the save, and never fatal: a recipe is not worth losing because its photo 404'd.
        if (imageUrl is not null)
        {
            recipe.ImagePath = await _import.CacheImageAsync(imageUrl, ct);
            if (recipe.ImagePath is not null) await _db.SaveChangesAsync(ct);
        }

        return new RecipeImportResponse(
            confidence.ToString(),
            RecipeDto.From(recipe, await EditorNameAsync(recipe, ct), await ParentTitleAsync(recipe, ct)),
            reason);
    }

    /// <summary>
    /// Save an edit as a recipe in its own right, leaving the original untouched (MEALS_FORK).
    /// </summary>
    /// <remarks>
    /// <b>What is copied and what is not is the whole design</b> (§2). Provenance survives — source,
    /// cuisine, tags, steps, prep note — because a variation of a Serious Eats recipe still came
    /// from Serious Eats. **History does not**: the new recipe reads NEVER COOKED, because nobody
    /// has cooked *this* version yet, and inheriting the parent's cooked count is exactly what would
    /// make the folder's NOT LATELY sort start lying.
    /// <para>
    /// The original is never read for writing and never modified — §6's first acceptance criterion
    /// is that it comes out byte-identical.
    /// </para>
    /// </remarks>
    [HttpPost("{id:int}/fork")]
    public async Task<ActionResult<RecipeDto>> Fork(int id, ForkRecipeInput input, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(input.Name)) return BadRequest("A name is required.");
        if (input.Name.Trim().Length > MealFieldLimits.Title)
            return BadRequest($"The name is longer than {MealFieldLimits.Title} characters.");

        var original = await LoadAsync(id, ct);
        if (original is null) return NotFound();

        var now = DateTime.UtcNow;
        var fork = new Recipe
        {
            Title = input.Name.Trim(),
            Description = original.Description,
            // Provenance is copied, deliberately: it is still where the recipe came from.
            SourceUrl = original.SourceUrl,
            SourceName = original.SourceName,
            ImportMethod = original.ImportMethod,
            ImagePath = original.ImagePath,
            ImageSourceUrl = original.ImageSourceUrl,
            Servings = input.Servings ?? original.Servings,
            YieldText = original.YieldText,
            PrepMinutes = original.PrepMinutes,
            CookMinutes = original.CookMinutes,
            TotalMinutes = original.TotalMinutes,
            PrepNote = original.PrepNote,
            LeadMinutes = original.LeadMinutes,
            // A fork is a fresh record: Completeness is re-derived from what it actually holds
            // rather than inherited, because the edit may have filled in what was missing.
            Completeness = original.Completeness,
            IncompleteReason = original.IncompleteReason,
            // Never archived, whatever the original is — you just made this on purpose.
            IsArchived = false,
            ForkedFrom = input.KeepLink ? original.Id : null,
            ModifiedByProfileId = input.ModifiedByProfileId,
            ModifiedAtUtc = input.ModifiedByProfileId is null ? null : now,
            CreatedUtc = now,
            UpdatedUtc = now,
        };

        // Edited ingredient values when the caller sent them; the original's lines otherwise, so a
        // fork with no amount changes is still a complete recipe.
        var lines = input.Ingredients is { Count: > 0 }
            ? input.Ingredients
            : original.Ingredients.OrderBy(i => i.Position)
                .Select(i => new RecipeIngredientInput(i.RawText, i.Quantity, i.Unit, i.Name, i.Note, i.SectionHeading))
                .ToList();

        var position = 0;
        foreach (var line in lines)
        {
            if (string.IsNullOrWhiteSpace(line.RawText)) continue;
            fork.Ingredients.Add(new RecipeIngredient
            {
                Position = position++,
                RawText = line.RawText.Trim(),
                Quantity = line.Quantity,
                Unit = Blank(line.Unit),
                Name = Blank(line.Name),
                Note = Blank(line.Note),
                SectionHeading = Blank(line.SectionHeading),
            });
        }

        // Steps verbatim — a variation is about amounts, and rewriting the method is an ordinary
        // edit on the new recipe afterwards.
        position = 0;
        foreach (var step in original.Steps.OrderBy(s => s.Position))
        {
            fork.Steps.Add(new RecipeStep
            {
                Position = position++, Text = step.Text, SectionHeading = step.SectionHeading,
            });
        }

        foreach (var tag in original.Tags.Select(t => t.Tag))
        {
            fork.Tags.Add(new RecipeTag { Tag = tag });
        }

        _db.Recipes.Add(fork);
        await _db.SaveChangesAsync(ct);
        // A fork is an addition, not a change: the original is untouched, so notifying about *it*
        // would be reporting an edit that never happened.
        await _notifier.RecipeAddedAsync(fork, input.ModifiedByProfileId, ct);

        return CreatedAtAction(
            nameof(Get), new { id = fork.Id },
            RecipeDto.From(fork, await EditorNameAsync(fork, ct), input.KeepLink ? original.Title : null));
    }

    /// <summary>
    /// The cached hero image (D5). Streams from the configured directory — never from
    /// <c>wwwroot</c>, which every deploy replaces.
    /// </summary>
    [HttpGet("{id:int}/image")]
    public async Task<IActionResult> Image(int id, CancellationToken ct)
    {
        var recipe = await _db.Recipes.FirstOrDefaultAsync(r => r.Id == id, ct);
        if (recipe is null) return NotFound();

        var fileName = recipe.ImagePath;
        if (string.IsNullOrWhiteSpace(fileName)) return NotFound();

        var path = _import.ResolveImagePath(fileName);

        // The file is gone but the recipe still believes it has one — a pruned directory, a restored
        // database, a machine move. This is a cache, so rebuild it rather than reporting a permanent
        // 404 for an image we still know the source of: that is exactly why ImageSourceUrl is stored
        // (D5). Re-fetch goes through the same guarded fetcher as the original import.
        if (path is null && !string.IsNullOrWhiteSpace(recipe.ImageSourceUrl))
        {
            var rebuilt = await _import.CacheImageAsync(recipe.ImageSourceUrl, ct);
            if (rebuilt is not null)
            {
                recipe.ImagePath = rebuilt;
                await _db.SaveChangesAsync(ct);
                fileName = rebuilt;
                path = _import.ResolveImagePath(rebuilt);
            }
        }

        if (path is null) return NotFound();

        var contentType = RecipeImportService.ContentTypeFor(fileName);
        if (contentType is null) return NotFound();

        // The filename IS the content hash, so it is a strong ETag by construction and the panel
        // re-requests an unchanged image exactly once.
        var etag = new Microsoft.Net.Http.Headers.EntityTagHeaderValue(
            $"\"{Path.GetFileNameWithoutExtension(fileName)}\"");
        return PhysicalFile(path, contentType, lastModified: null, entityTag: etag);
    }

    /// <summary>
    /// Replace a recipe wholesale. Ingredients, steps and tags are sent complete and overwrite what
    /// was stored — a recipe is edited as a document, so there is no partial-update shape to get
    /// wrong. <paramref name="baseVersion"/> makes it a conditional write per Stage 9b.
    /// </summary>
    [HttpPut("{id:int}")]
    public async Task<ActionResult<RecipeDto>> Replace(
        int id, RecipeInput input, [FromQuery] int? baseVersion, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(input.Title)) return BadRequest("Title is required.");
        if (TooLong(input) is { } tooLong) return BadRequest(tooLong);

        var recipe = await LoadAsync(id, ct);
        if (recipe is null) return NotFound();
        // The 409 body is what the edit-amounts conflict screen diffs against, so it carries the
        // editor's name too — "changed on another device" is not the message; "Ellen edited this 40
        // seconds ago" is (MEALS_SCREEN §8b).
        if (baseVersion is { } v && v != recipe.Version)
            return Conflict(RecipeDto.From(recipe, await EditorNameAsync(recipe, ct), await ParentTitleAsync(recipe, ct)));

        var now = DateTime.UtcNow;
        recipe.Title = input.Title.Trim();
        Apply(recipe, input, now);
        recipe.UpdatedUtc = now;
        recipe.Version++;

        await _db.SaveChangesAsync(ct);
        await _notifier.RecipeChangedAsync(recipe, input.ModifiedByProfileId, ct);
        return RecipeDto.From(recipe, await EditorNameAsync(recipe, ct), await ParentTitleAsync(recipe, ct));
    }

    /// <summary>
    /// Delete a recipe. Any plan entry pointing at it is first rewritten to free text holding the
    /// title, so deleting "Chicken Piccata" leaves last Tuesday reading "Chicken Piccata" rather
    /// than blanking a night you actually ate.
    /// </summary>
    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id, [FromQuery] int? baseVersion, CancellationToken ct)
    {
        var recipe = await LoadAsync(id, ct);
        if (recipe is null) return NotFound();
        if (baseVersion is { } v && v != recipe.Version)
            return Conflict(RecipeDto.From(recipe, await EditorNameAsync(recipe, ct), await ParentTitleAsync(recipe, ct)));

        var planned = await _db.MealPlanEntries.Where(e => e.RecipeId == id).ToListAsync(ct);
        var now = DateTime.UtcNow;
        foreach (var entry in planned)
        {
            entry.RecipeId = null;
            entry.Recipe = null;
            entry.FreeText = Truncate(recipe.Title, MealFieldLimits.FreeText);
            entry.UpdatedUtc = now;
            entry.Version++;
        }

        var cachedImage = recipe.ImagePath;

        _db.Recipes.Remove(recipe);
        await _db.SaveChangesAsync(ct);

        // Drop the cached image too, or every deleted recipe leaves its photo on disk forever — a
        // slow leak in a directory nothing else ever prunes.
        //
        // Only when nothing else points at that file. Cache filenames are content hashes, so two
        // recipes that imported the same photo genuinely share one file, and deleting it for the
        // first would leave the second serving a 404 for an image it still believes it has.
        if (!string.IsNullOrWhiteSpace(cachedImage)
            && !await _db.Recipes.AnyAsync(r => r.ImagePath == cachedImage, ct))
        {
            _import.DeleteCachedImage(cachedImage);
        }

        return NoContent();
    }

    /// <summary>
    /// The full aggregate for one recipe.
    /// </summary>
    /// <remarks>
    /// Split into one query per collection. Three collection includes in a single statement is a
    /// cartesian product — a recipe with 15 ingredients, 10 steps and 4 tags returns 600 rows for 29
    /// rows of actual data, and EF only collapses that after paying for it on the wire. EF Core warns
    /// about exactly this (<c>MultipleCollectionIncludeWarning</c>); four small indexed queries are
    /// the cheaper shape here.
    /// </remarks>
    private Task<Recipe?> LoadAsync(int id, CancellationToken ct) =>
        _db.Recipes
            .Include(r => r.Ingredients)
            .Include(r => r.Steps)
            .Include(r => r.Tags)
            .AsSplitQuery()
            .FirstOrDefaultAsync(r => r.Id == id, ct);

    /// <summary>
    /// Copy an input onto an entity. Children are replaced rather than diffed — at recipe scale the
    /// churn is a handful of rows, and diffing by value would be more code and more ways to be wrong.
    /// Position comes from array order, so the client reorders by reordering.
    /// </summary>
    private static void Apply(Recipe recipe, RecipeInput input, DateTime now)
    {
        recipe.Description = Blank(input.Description);
        recipe.SourceUrl = Blank(input.SourceUrl);
        recipe.SourceName = Blank(input.SourceName);
        recipe.Servings = input.Servings;
        recipe.YieldText = Blank(input.YieldText);
        recipe.PrepMinutes = input.PrepMinutes;
        recipe.CookMinutes = input.CookMinutes;
        recipe.TotalMinutes = input.TotalMinutes;
        recipe.IsArchived = input.IsArchived;
        recipe.LeadMinutes = input.LeadMinutes;
        recipe.PrepNote = Blank(input.PrepNote);

        // Only stamped when the caller says who they are. An unattributed write leaves the previous
        // attribution standing rather than clearing it — the strip's job is to name whoever last
        // changed the recipe, and a scripted or imported write does not make that person nobody.
        if (input.ModifiedByProfileId is { } editor)
        {
            recipe.ModifiedByProfileId = editor;
            recipe.ModifiedAtUtc = now;
        }

        recipe.Ingredients.Clear();
        var position = 0;
        foreach (var line in input.Ingredients ?? [])
        {
            if (string.IsNullOrWhiteSpace(line.RawText)) continue;
            recipe.Ingredients.Add(new RecipeIngredient
            {
                Position = position++,
                RawText = line.RawText.Trim(),
                Quantity = line.Quantity,
                Unit = Blank(line.Unit),
                Name = Blank(line.Name),
                Note = Blank(line.Note),
                SectionHeading = Blank(line.SectionHeading),
            });
        }

        recipe.Steps.Clear();
        position = 0;
        foreach (var step in input.Steps ?? [])
        {
            if (string.IsNullOrWhiteSpace(step.Text)) continue;
            recipe.Steps.Add(new RecipeStep
            {
                Position = position++,
                Text = step.Text.Trim(),
                SectionHeading = Blank(step.SectionHeading),
            });
        }

        recipe.Tags.Clear();
        // Tags are user-typed, so they arrive with stray whitespace, blanks, casing drift and
        // duplicates. Normalize once here so the filter row isn't showing "Quick" next to "quick".
        // No truncation here: an overlong tag is rejected by TooLong before this runs, so silently
        // clipping one would only ever hide a bug in that guard.
        foreach (var tag in (input.Tags ?? [])
            .Where(t => !string.IsNullOrWhiteSpace(t))
            .Select(t => t.Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase))
        {
            recipe.Tags.Add(new RecipeTag { Tag = tag });
        }
    }

    /// <summary>
    /// The first field that exceeds its column, or null when the input fits.
    /// </summary>
    /// <remarks>
    /// Checked here rather than left to SQL Server, which answers an overlong field with
    /// "String or binary data would be truncated" wrapped in a <c>DbUpdateException</c> — a 500 that
    /// names neither the field nor the limit, on input the caller could have corrected. Silently
    /// truncating instead was rejected: quietly discarding the end of someone's recipe is worse than
    /// telling them it was too long.
    /// <para>The in-memory provider the tests run on ignores <c>HasMaxLength</c>, so nothing here is
    /// covered by simply exercising the endpoint — the limits live in <see cref="MealFieldLimits"/>
    /// precisely so both sides read the same numbers.</para>
    /// </remarks>
    private static string? TooLong(RecipeInput input)
    {
        static string? Check(string? value, int max, string field) =>
            value is not null && value.Trim().Length > max
                ? $"{field} is longer than {max} characters."
                : null;

        var problem =
            Check(input.Title, MealFieldLimits.Title, "Title")
            ?? Check(input.Description, MealFieldLimits.Description, "Description")
            ?? Check(input.SourceUrl, MealFieldLimits.Url, "Source URL")
            ?? Check(input.SourceName, MealFieldLimits.SourceName, "Source name")
            ?? Check(input.YieldText, MealFieldLimits.YieldText, "Yield")
            ?? Check(input.PrepNote, MealFieldLimits.PrepNote, "Prep note");
        if (problem is not null) return problem;

        var position = 0;
        foreach (var line in input.Ingredients ?? [])
        {
            position++;
            problem =
                Check(line.RawText, MealFieldLimits.IngredientRawText, $"Ingredient {position}")
                ?? Check(line.Unit, MealFieldLimits.Unit, $"Ingredient {position} unit")
                ?? Check(line.Name, MealFieldLimits.IngredientName, $"Ingredient {position} name")
                ?? Check(line.Note, MealFieldLimits.Note, $"Ingredient {position} note")
                ?? Check(line.SectionHeading, MealFieldLimits.SectionHeading, $"Ingredient {position} heading");
            if (problem is not null) return problem;
        }

        position = 0;
        foreach (var step in input.Steps ?? [])
        {
            position++;
            problem =
                Check(step.Text, MealFieldLimits.StepText, $"Step {position}")
                ?? Check(step.SectionHeading, MealFieldLimits.SectionHeading, $"Step {position} heading");
            if (problem is not null) return problem;
        }

        foreach (var tag in input.Tags ?? [])
        {
            problem = Check(tag, MealFieldLimits.Tag, $"Tag '{tag?.Trim()}'");
            if (problem is not null) return problem;
        }

        return null;
    }

    /// <summary>
    /// The display name of whoever last edited this recipe, or null when nobody has since it was
    /// tracked — or when that profile has since been deleted, which reads as "no attribution"
    /// rather than as a dangling id the strip would have to apologise for.
    /// </summary>
    private async Task<string?> EditorNameAsync(Recipe recipe, CancellationToken ct) =>
        recipe.ModifiedByProfileId is { } id
            ? await _db.Profiles.Where(p => p.Id == id).Select(p => p.Name).FirstOrDefaultAsync(ct)
            : null;

    /// <summary>
    /// The title of the recipe this one was forked from, or null when it has no parent — or when
    /// the parent has since been deleted, which the lineage strip renders as a name with no link
    /// rather than as a dangling reference it has to apologise for.
    /// </summary>
    private async Task<string?> ParentTitleAsync(Recipe recipe, CancellationToken ct) =>
        recipe.ForkedFrom is { } parentId
            ? await _db.Recipes.Where(r => r.Id == parentId).Select(r => r.Title).FirstOrDefaultAsync(ct)
            : null;

    private static string? Blank(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static string Truncate(string value, int max) => value.Length <= max ? value : value[..max];
}
