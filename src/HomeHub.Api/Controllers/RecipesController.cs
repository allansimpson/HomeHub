namespace HomeHub.Api.Controllers;

using HomeHub.Api.Auth;
using HomeHub.Api.Data;
using HomeHub.Api.Calendar.Capture;
using HomeHub.Api.Kitchen;
using HomeHub.Api.Meals;
// Units are a Pantry concept the recipe folder shares: the stock check joins the two, so both sides
// have to spell "oz" the same way. See UnitRegistry.
using HomeHub.Api.Pantry;
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
    private readonly UnitRegistry _units;
    private readonly IKitchenPhotoReader _photos;

    public RecipesController(
        HomeHubDbContext db,
        RecipeImportService import,
        MealNotifier notifier,
        UnitRegistry units,
        IKitchenPhotoReader photos)
    {
        _db = db;
        _import = import;
        _notifier = notifier;
        _units = units;
        _photos = photos;
    }

    /// <summary>
    /// Read a photograph of a recipe. Returns what it says; writes nothing, and stores nothing.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Photographs are where most of a household's recipes actually live</b> — cookbook pages,
    /// handwritten cards, screenshots of a message. So this is the lead route on the add screen
    /// rather than one option among four.
    /// </para>
    /// <para>
    /// <b>Nothing is saved here.</b> What comes back goes into the editor as ordinary fields, and
    /// the save is the existing paste import — which means a photographed recipe is parsed by the
    /// same <c>IngredientParser</c> as every other one and therefore scales the same way. A second
    /// parser living inside a model would diverge from the first, and nobody would notice until a
    /// recipe doubled for eight bought half of what it should.
    /// </para>
    /// </remarks>
    [HttpPost("read-photo")]
    public async Task<ActionResult<RecipeReadingDto>> ReadPhoto(
        ReadKitchenPhotoRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (string.IsNullOrEmpty(request.ImageBase64)) return BadRequest("A photograph is required.");

        NormalizedImage image;
        try { image = ImageIngress.Normalize(request.ImageBase64, request.MediaType); }
        catch (InvalidDataException ex) { return BadRequest(ex.Message); }

        var reading = await _photos.ReadRecipeAsync(
            image, ct);

        return Ok(RecipeReadingDto.From(reading));
    }

    /// <summary>
    /// Read a recipe out of a chat. Returns what is there; writes nothing, and stores nothing.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Why a chat is a capture path at all.</b> A household talks to the panel about recipes it
    /// found somewhere else — pasting one in to have it halved, made dairy-free, or turned into
    /// something that uses what is in the pantry. The recipe they end up with is then sitting in a
    /// transcript, which is the one place in this app a recipe could be and not be saveable.
    /// </para>
    /// <para>
    /// <b>The panel does this, not the agent.</b> There is no <c>add_recipe</c> house tool, and this
    /// is deliberate: the agent's tool list is short on purpose (<see cref="Mcp.HouseTools"/>), and
    /// a recipe is a large structured document to have a model re-type as tool arguments when the
    /// text is already written down. Reading it here means the same parser, the same ingredient
    /// scaling and the same pantry matching as every other route — and a household that is asked
    /// before anything is written.
    /// </para>
    /// <para>
    /// <b>Nothing is saved here.</b> The panel offers what came back, and a yes goes to
    /// <c>POST /import/text</c> with the same message — so the reading and the write are two parses
    /// of one block, and they cannot disagree about what it said.
    /// </para>
    /// </remarks>
    [HttpPost("read-conversation")]
    public async Task<ActionResult<RecipeConversationReadingDto>> ReadConversation(
        RecipeConversationInput input, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(input);
        var messages = input.Messages ?? [];
        if (messages.Count == 0) return BadRequest("There is nothing to read.");
        // The same bound the paste box has, applied to the whole transcript. This endpoint is
        // unauthenticated on the LAN like every other one (D6).
        if (messages.Sum(m => m?.Length ?? 0) > 100_000)
            return BadRequest("That is too much text to read as one recipe.");

        var reading = ConversationRecipeReader.Read(messages);
        if (reading.Recipe is not { } recipe)
        {
            return new RecipeConversationReadingDto(
                false, null, nameof(ImportConfidence.Empty), null, null, 0, 0, null,
                reading.Link, null, reading.Reason);
        }

        return new RecipeConversationReadingDto(
            true,
            reading.Message,
            reading.Confidence.ToString(),
            recipe.Title,
            recipe.Servings,
            recipe.Ingredients?.Count ?? 0,
            recipe.Steps?.Count ?? 0,
            recipe.SourceUrl,
            reading.Link,
            await ExistingAsync(recipe.Title, ct),
            reading.Reason);
    }

    /// <summary>
    /// A recipe the folder already holds under this name, or null.
    /// </summary>
    /// <remarks>
    /// <b>What turns a duplicate into a variation.</b> A chat that adapted the household's own
    /// chicken katsu produces a reading called "Chicken Katsu Curry", and saving that as an
    /// unrelated second entry is how one folder becomes two. Naming the match lets the offer ask
    /// which of the two things this is, which is a question only the household can answer.
    /// <para>
    /// Exact name, case aside — nothing fuzzy. A near-match offered as the parent would put a
    /// variation link on the wrong recipe, and a wrong link is worse than no link: it is provenance,
    /// and provenance is believed.
    /// </para>
    /// Archived recipes count. One that was put away is still the recipe this is a variation of.
    /// </remarks>
    private async Task<RecipeMatchDto?> ExistingAsync(string title, CancellationToken ct)
    {
        var wanted = title.Trim().ToLowerInvariant();
        if (wanted.Length == 0) return null;
        // ToLower() rather than StringComparison: this is translated to SQL, and it is the one form
        // both SQL Server and the in-memory provider the tests use agree on. See List().
#pragma warning disable CA1304, CA1311, CA1862
        var match = await _db.Recipes
            .Where(r => r.Title.ToLower() == wanted)
            .OrderBy(r => r.Id)
            .Select(r => new RecipeMatchDto(r.Id, r.Title))
            .FirstOrDefaultAsync(ct);
#pragma warning restore CA1304, CA1311, CA1862
        return match;
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
            // CA1304/CA1311/CA1862 say to pass a culture or use StringComparison.OrdinalIgnoreCase.
            // Both are wrong inside an expression tree: this lambda is never executed as IL, it is
            // translated to SQL, and neither `ToLower(CultureInfo)` nor `string.Equals(a, b,
            // StringComparison)` has a translation in EF Core — the first throws at query time, the
            // second falls back to client evaluation and pulls every tag row into memory. The
            // bare `ToLower()` is the only form both SQL Server and the in-memory provider accept,
            // which is what the comment above is about. There is no current culture on the SQL side
            // for the rule to be warning about.
#pragma warning disable CA1304, CA1311, CA1862
            query = query.Where(r => r.Tags.Any(t => t.Tag.ToLower() == wanted));
#pragma warning restore CA1304, CA1311, CA1862
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
        await _units.LoadAsync(ct);

        var now = DateTime.UtcNow;
        var recipe = new Recipe
        {
            Title = input.Title.Trim(),
            ImportMethod = RecipeImportMethod.Manual,
            CreatedUtc = now,
            UpdatedUtc = now,
        };
        Apply(recipe, input, now, _units, this.CallerId());

        _db.Recipes.Add(recipe);
        await _db.SaveChangesAsync(ct);
        await _notifier.RecipeAddedAsync(recipe, this.CallerId(), ct);
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
        // A 400 rather than the Empty response below: the page is fine, the typed name is the
        // problem, and telling someone their page publishes no recipe would send them to fix the
        // wrong thing.
        if (input.Title is { } typed && typed.Trim().Length > MealFieldLimits.Title)
            return BadRequest($"That name is longer than {MealFieldLimits.Title} characters.");

        var (confidence, parsed, imageUrl, reason) = await _import.ReadAsync(input.Url.Trim(), ct);

        // Nothing usable on the page. Deliberately a 200 with an explanation rather than an error
        // status: the request was well-formed and the panel needs to render a specific screen for
        // this, not a generic failure.
        if (confidence == ImportConfidence.Empty || parsed is null)
            return new RecipeImportResponse(nameof(ImportConfidence.Empty), null, reason);

        // A typed name wins over the page's. Same rule the paste path already follows, and the same
        // reason: whoever is standing at the panel knows what the household calls this.
        if (!string.IsNullOrWhiteSpace(input.Title)) parsed = parsed with { Title = input.Title.Trim() };

        if (TooLong(parsed) is { } tooLong)
            return new RecipeImportResponse(nameof(ImportConfidence.Empty), null, tooLong);

        return await PersistImportedAsync(
            confidence, parsed, imageUrl, reason, RecipeImportMethod.JsonLd, this.CallerId(), null, ct);
    }

    /// <summary>
    /// Import a recipe from a block of text somebody pasted — the path for publishers that refuse
    /// the fetcher.
    /// </summary>
    /// <remarks>
    /// <b>No network I/O whatsoever.</b> The URL importer cannot read every site: every People Inc.
    /// property (allrecipes, Serious Eats, Simply Recipes) answers <c>402</c> to any client, browser
    /// user-agent included, pointing at their content-licensing address. This does not go around
    /// that — the household reads the page in their own browser and pastes what they can already
    /// see, and the panel parses the text it was handed.
    /// <para>
    /// Ingredients go through the same <see cref="IngredientParser"/> as a JSON-LD import, so a
    /// pasted recipe scales exactly like a fetched one. That is the entire point: the paste box that
    /// existed before this stored every line as raw text, which reads fine and scales not at all.
    /// </para>
    /// </remarks>
    [HttpPost("import/text")]
    public async Task<ActionResult<RecipeImportResponse>> ImportText(RecipePasteInput input, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(input.Text)) return BadRequest("There is nothing to read.");
        // Generous — a long recipe with notes runs to a few KB — but not unbounded: this is an
        // unauthenticated endpoint on the LAN like every other (D6).
        if (input.Text.Length > 100_000) return BadRequest("That is too much text to read as one recipe.");
        if (input.SourceUrl is { } url && url.Trim().Length > MealFieldLimits.Url)
            return BadRequest($"That link is longer than {MealFieldLimits.Url} characters.");

        // A variation has to have something to be a variation of. A parent that has since been
        // deleted is a 404 rather than a silently unlinked save: the household asked for the link,
        // and a recipe that quietly arrives without one is a second copy under the same name.
        Recipe? parent = null;
        if (input.ForkOf is { } parentId)
        {
            parent = await LoadAsync(parentId, ct);
            if (parent is null) return NotFound();
        }

        // Markdown out of the way first. Text pasted from a message or a notes app carries `##` and
        // `**` as often as not, and the parser matches its section headings whole — so `## Ingredients`
        // is not the word `ingredients` to it, and the whole block reads as one unsectioned list.
        // A block with no markers in it comes back unchanged, which is why this is unconditional
        // rather than a flag the caller has to know to set (see MarkdownToText).
        var text = MarkdownToText.Flatten(input.Text) ?? input.Text;
        var result = PastedRecipeImporter.Parse(text, input.SourceUrl, input.Title);

        // Same contract as the URL path: a block that yielded nothing is a 200 with an explanation,
        // because the request was well-formed and the screen renders a specific state for it.
        if (result.Confidence == ImportConfidence.Empty || result.Recipe is null)
            return new RecipeImportResponse(nameof(ImportConfidence.Empty), null, result.Reason);

        if (TooLong(result.Recipe) is { } tooLong)
            return new RecipeImportResponse(nameof(ImportConfidence.Empty), null, tooLong);

        // The cuisine chip is the one thing on the screen the parser cannot read off the text.
        var parsed = input.Tags is { Count: > 0 } ? result.Recipe with { Tags = input.Tags } : result.Recipe;

        return await PersistImportedAsync(
            result.Confidence, parsed, null, result.Reason, RecipeImportMethod.Pasted, this.CallerId(), parent, ct);
    }

    /// <summary>
    /// Write an imported recipe, whichever importer produced it.
    /// </summary>
    /// <remarks>
    /// Shared by the URL and paste paths so the two cannot drift on completeness, attribution or
    /// image caching — the same reason import persistence lives in this controller rather than in
    /// the import service.
    /// </remarks>
    private async Task<RecipeImportResponse> PersistImportedAsync(
        ImportConfidence confidence,
        RecipeInput parsed,
        string? imageUrl,
        string? reason,
        RecipeImportMethod method,
        int? profileId,
        Recipe? parent,
        CancellationToken ct)
    {
        await _units.LoadAsync(ct);

        var now = DateTime.UtcNow;
        var recipe = new Recipe
        {
            Title = parsed.Title.Trim(),
            // The only places ImportMethod is anything but Manual — provenance the folder can show.
            ImportMethod = method,
            Completeness = confidence == ImportConfidence.Complete
                ? RecipeCompleteness.Complete
                : RecipeCompleteness.Partial,
            IncompleteReason = confidence == ImportConfidence.Complete ? null : Truncate(reason ?? "Incomplete page", MealFieldLimits.IncompleteReason),
            CreatedUtc = now,
            UpdatedUtc = now,
        };
        Apply(recipe, parsed, now, _units, profileId);
        // Apply() is shared with the manual path and does not know about import-only fields.
        recipe.ImageSourceUrl = imageUrl is null ? null : Truncate(imageUrl, MealFieldLimits.Url);
        recipe.ModifiedByProfileId = profileId;
        if (profileId is not null) recipe.ModifiedAtUtc = now;
        Inherit(recipe, parent);

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
        await _units.LoadAsync(ct);

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
            ModifiedByProfileId = this.CallerId(),
            ModifiedAtUtc = this.CallerId() is null ? null : now,
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
                Unit = _units.Normalise(line.Unit),
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
        await _notifier.RecipeAddedAsync(fork, this.CallerId(), ct);

        return CreatedAtAction(
            nameof(Get), new { id = fork.Id },
            RecipeDto.From(fork, await EditorNameAsync(fork, ct), input.KeepLink ? original.Title : null));
    }

    /// <summary>
    /// Set or clear the cuisine — the one thing the folder groups by.
    /// </summary>
    /// <remarks>
    /// <b>A named action rather than a field on the full replace</b>, because cuisine is a reserved
    /// tag and a screen that only wanted to say "this is Mexican" should not be in a position to
    /// drop every other tag by omission (see <see cref="RecipeCuisineInput"/>). Exactly one cuisine
    /// tag survives: the folder groups each recipe under one heading, and a recipe carrying two
    /// would appear under both, which is not a richer answer but a double count.
    /// <para>
    /// Import still guesses. This is how a household overrules the guess, and nothing re-derives it
    /// afterwards — <c>Apply</c> writes whatever tag list the caller sends, and every screen that
    /// saves a recipe sends the list it was given.
    /// </para>
    /// </remarks>
    [HttpPut("{id:int}/cuisine")]
    public async Task<ActionResult<RecipeDto>> SetCuisine(
        int id, RecipeCuisineInput input, [FromQuery] int? baseVersion, CancellationToken ct)
    {
        // A name that cannot be stored is a refusal rather than a silent clear: "" means clear, and
        // 300 characters of prose means somebody typed into the wrong box.
        var tag = Cuisines.Tag(input.Cuisine);
        if (tag is null && !string.IsNullOrWhiteSpace(input.Cuisine))
            return BadRequest($"A cuisine has to fit in {MealFieldLimits.Tag - Cuisines.Prefix.Length} characters.");

        var recipe = await LoadAsync(id, ct);
        if (recipe is null) return NotFound();
        if (baseVersion is { } v && v != recipe.Version)
            return Conflict(RecipeDto.From(recipe, await EditorNameAsync(recipe, ct), await ParentTitleAsync(recipe, ct)));

        var existing = recipe.Tags.Where(t => Cuisines.IsCuisine(t.Tag)).ToList();
        // Already what it is: no write, no version bump, no attribution. Tapping the chip somebody
        // else already set should not read as an edit on the folder.
        if (tag is not null && existing.Count == 1 && existing[0].Tag == tag)
        {
            return RecipeDto.From(recipe, await EditorNameAsync(recipe, ct), await ParentTitleAsync(recipe, ct));
        }
        if (tag is null && existing.Count == 0)
        {
            return RecipeDto.From(recipe, await EditorNameAsync(recipe, ct), await ParentTitleAsync(recipe, ct));
        }

        foreach (var stale in existing) recipe.Tags.Remove(stale);
        if (tag is not null) recipe.Tags.Add(new RecipeTag { Tag = tag });

        var now = DateTime.UtcNow;
        recipe.UpdatedUtc = now;
        recipe.Version++;
        // Attribution from the session (AUDIT A1.2): "edited by" should say who edited it.
        if (this.CallerId() is { } editor)
        {
            recipe.ModifiedByProfileId = editor;
            recipe.ModifiedAtUtc = now;
        }

        await _db.SaveChangesAsync(ct);
        // Deliberately not notified. MEALS_BEHAVIOURS §4's recipe-changed notice is about amounts and
        // method — the things somebody standing at the hob would want to know changed under them.
        // Filing a dish under Mexican is not that, and a notification per chip tap would train the
        // household to ignore the ones that matter.
        return RecipeDto.From(recipe, await EditorNameAsync(recipe, ct), await ParentTitleAsync(recipe, ct));
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

        await _units.LoadAsync(ct);
        var now = DateTime.UtcNow;
        recipe.Title = input.Title.Trim();
        Apply(recipe, input, now, _units, this.CallerId());
        recipe.UpdatedUtc = now;
        recipe.Version++;

        await _db.SaveChangesAsync(ct);
        await _notifier.RecipeChangedAsync(recipe, this.CallerId(), ct);
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
    private static void Apply(
        Recipe recipe, RecipeInput input, DateTime now, UnitRegistry units, int? editorProfileId)
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

        // Attribution is a claim from the authenticated principal, never a request field. An
        // unattributed service write leaves the previous attribution standing rather than letting a
        // machine erase or impersonate the last household editor.
        if (editorProfileId is { } editor)
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
                // The stock check joins a recipe's units to the pantry's, so both sides have to
                // spell them the same way. Scaling still reads RawText, which is left exactly as the
                // source wrote it — normalising the field changes what is compared, never what is
                // shown (meals-planning.md D3).
                Unit = units.Normalise(line.Unit),
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

    /// <summary>
    /// Fill an imported recipe's gaps from the recipe it is a variation of, and record the link.
    /// </summary>
    /// <remarks>
    /// <b>Gaps only.</b> Everything the block actually said stands — a chat that changed the method
    /// changed the method, which is the difference between this and <c>POST /{id}/fork</c>, where
    /// the parent's steps are copied verbatim because a fork is about amounts. What a block cannot
    /// say for itself is where the recipe came from, what cuisine the household files it under, and
    /// what it looks like, so those come across.
    /// <para>
    /// The photograph is shared rather than re-downloaded: cache filenames are content hashes, and
    /// <see cref="Delete"/> already declines to remove a file another recipe still points at.
    /// </para>
    /// </remarks>
    private static void Inherit(Recipe recipe, Recipe? parent)
    {
        if (parent is null) return;

        recipe.ForkedFrom = parent.Id;
        recipe.SourceUrl ??= parent.SourceUrl;
        recipe.SourceName ??= parent.SourceName;
        recipe.ImagePath ??= parent.ImagePath;
        recipe.ImageSourceUrl ??= parent.ImageSourceUrl;
        recipe.Description ??= parent.Description;
        recipe.YieldText ??= parent.YieldText;
        recipe.PrepNote ??= parent.PrepNote;
        recipe.LeadMinutes ??= parent.LeadMinutes;

        // All or nothing, never merged: tags are a set the household curates, and a variation that
        // came back with its own cuisine has already answered the only question this could ask.
        if (recipe.Tags.Count > 0) return;
        foreach (var tag in parent.Tags.Select(t => t.Tag))
        {
            recipe.Tags.Add(new RecipeTag { Tag = tag });
        }
    }

    private static string? Blank(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static string Truncate(string value, int max) => value.Length <= max ? value : value[..max];
}
