namespace HomeHub.Api.Meals;

using HomeHub.Api.Pantry;

// ---------- Recipes: read ----------

/// <summary>
/// A recipe as the folder list sees it — no ingredients or steps. The folder shows dozens of
/// these at once and needs none of the body, so they are not loaded.
/// </summary>
public record RecipeSummaryDto(
    int Id,
    string Title,
    string? Description,
    string? SourceName,
    int? Servings,
    string? YieldText,
    int? TotalMinutes,
    bool HasImage,
    // Enum-valued fields cross the wire as their names, matching ActiveAlertDto.Severity and
    // ClimateZoneDto.Mode; the client mirrors them as string unions.
    string ImportMethod,
    string Completeness,
    string? IncompleteReason,
    bool IsArchived,
    IReadOnlyList<string> Tags,
    int IngredientCount,
    int StepCount,
    // Lead time rides on the summary as well as the detail because the week screen's
    // "START 14:00 · PORK OUT FRIDAY NIGHT" line renders from the folder list, without opening
    // each recipe.
    int? LeadMinutes,
    string? PrepNote,
    // ---- Cooked history (MEALS_DATA_CONTRACT §3.3), derived from the plan, never stored ----
    /// <summary>Most recent past night this was actually eaten, or null for NEVER.</summary>
    DateOnly? LastCookedDate,
    /// <summary>How many past nights it was actually eaten. Drives "COOKED 2×".</summary>
    int TimesCooked,
    /// <summary>
    /// Most recent past night it was planned and explicitly <i>not</i> eaten — the folder's
    /// SKIPPED state (§3.2). Implied by the contract rather than named in its field list: SKIPPED
    /// carries a date, and there is nowhere else for that date to come from.
    /// </summary>
    DateOnly? LastSkippedDate,
    // ---- Lineage (MEALS_FORK §5) — on the summary so the folder can indent and label without a
    // request per row.
    int? ForkedFrom,
    string? ForkedFromTitle,
    int Version);
// Deliberately no From(Recipe) factory. It would need the ingredient and step collections loaded
// just to count them, which is exactly the over-fetch RecipesController.List now avoids by counting
// in SQL. Leaving one here would be an invitation to reintroduce it.

/// <summary>The full recipe, as the detail screen and cook mode need it.</summary>
public record RecipeDto(
    int Id,
    string Title,
    string? Description,
    string? SourceUrl,
    string? SourceName,
    int? Servings,
    string? YieldText,
    int? PrepMinutes,
    int? CookMinutes,
    int? TotalMinutes,
    bool HasImage,
    string ImportMethod,
    string Completeness,
    string? IncompleteReason,
    bool IsArchived,
    IReadOnlyList<string> Tags,
    IReadOnlyList<RecipeIngredientDto> Ingredients,
    IReadOnlyList<RecipeStepDto> Steps,
    int? LeadMinutes,
    string? PrepNote,
    // ---- Attribution (MEALS_DATA_CONTRACT §3, "Also needed for attribution") ----
    /// <summary>Who last edited this. The client compares it to the active profile so a reader is never attributed to themselves.</summary>
    int? ModifiedByProfileId,
    /// <summary>That profile's display name, resolved server-side so the strip reads "Ellen changed the amounts" without a second request.</summary>
    string? ModifiedByName,
    DateTime? ModifiedAtUtc,
    /// <summary>The recipe this is a variation of, or null. Drives the lineage strip.</summary>
    int? ForkedFrom,
    /// <summary>Its title, kept as plain text if the parent is later deleted.</summary>
    string? ForkedFromTitle,
    DateTime CreatedUtc,
    DateTime UpdatedUtc,
    int Version)
{
    /// <param name="modifiedByName">
    /// Resolved by the caller — the aggregate deliberately has no navigation to Profile, so the
    /// name is passed in rather than lazily loaded off a recipe that otherwise never touches the
    /// profiles table.
    /// </param>
    /// <param name="forkedFromTitle">
    /// Likewise resolved by the caller. Null when the parent has been deleted, which the lineage
    /// strip renders as a name without a link rather than as an error.
    /// </param>
    public static RecipeDto From(Recipe r, string? modifiedByName = null, string? forkedFromTitle = null) => new(
        r.Id, r.Title, r.Description, r.SourceUrl, r.SourceName, r.Servings, r.YieldText,
        r.PrepMinutes, r.CookMinutes, r.TotalMinutes, r.ImagePath is not null, r.ImportMethod.ToString(),
        r.Completeness.ToString(), r.IncompleteReason, r.IsArchived,
        r.Tags.Select(t => t.Tag).OrderBy(t => t, StringComparer.OrdinalIgnoreCase).ToList(),
        r.Ingredients.OrderBy(i => i.Position).Select(RecipeIngredientDto.From).ToList(),
        r.Steps.OrderBy(s => s.Position).Select(RecipeStepDto.From).ToList(),
        r.LeadMinutes, r.PrepNote,
        r.ModifiedByProfileId, modifiedByName, r.ModifiedAtUtc,
        r.ForkedFrom, forkedFromTitle,
        r.CreatedUtc, r.UpdatedUtc, r.Version);
}

/// <summary>
/// Save an edit as a new recipe instead of over the original (MEALS_FORK §5).
/// </summary>
/// <remarks>
/// The body supplies only what the person actually changed — the name and the edited ingredient
/// values. Everything else (steps, source, cuisine, tags, prep note, lead time) is copied
/// server-side from the recipe being forked, so the client cannot accidentally drop provenance by
/// omitting a field it did not happen to be displaying.
/// </remarks>
public record ForkRecipeInput(
    string Name,
    IReadOnlyList<RecipeIngredientInput>? Ingredients = null,
    int? Servings = null,
    /// <summary>
    /// Record where it came from. Unchecking the box on the naming sheet makes it a clean unlinked
    /// copy — a deliberate choice, not a default.
    /// </summary>
    bool KeepLink = true);

/// <summary><see cref="RawText"/> is what the panel renders; the parsed fields are for scaling and merging (doc D3).</summary>
public record RecipeIngredientDto(
    int Id,
    int Position,
    string RawText,
    decimal? Quantity,
    string? Unit,
    string? Name,
    string? Note,
    string? SectionHeading)
{
    public static RecipeIngredientDto From(RecipeIngredient i) =>
        new(i.Id, i.Position, i.RawText, i.Quantity, i.Unit, i.Name, i.Note, i.SectionHeading);
}

public record RecipeStepDto(int Id, int Position, string Text, string? SectionHeading)
{
    public static RecipeStepDto From(RecipeStep s) => new(s.Id, s.Position, s.Text, s.SectionHeading);
}

/// <summary>A tag and how many recipes carry it — the folder's Chip filter row.</summary>
public record RecipeTagCountDto(string Tag, int Count);

// ---------- Recipes: write ----------

/// <summary>
/// Create or replace payload. Ingredients, steps and tags are sent whole and replace what was
/// there: a recipe is edited as a document, not field by field, so there is no partial-update
/// shape to get wrong. Position is taken from array order, not from the client.
/// </summary>
public record RecipeInput(
    string Title,
    string? Description = null,
    string? SourceUrl = null,
    string? SourceName = null,
    int? Servings = null,
    string? YieldText = null,
    int? PrepMinutes = null,
    int? CookMinutes = null,
    int? TotalMinutes = null,
    IReadOnlyList<RecipeIngredientInput>? Ingredients = null,
    IReadOnlyList<RecipeStepInput>? Steps = null,
    IReadOnlyList<string>? Tags = null,
    bool IsArchived = false,
    int? LeadMinutes = null,
    string? PrepNote = null);

/// <summary>
/// One ingredient line to save. Only <see cref="RawText"/> is required — the parsed fields are
/// optional and are populated by the Stage M2 importer, not by hand on the panel.
/// </summary>
public record RecipeIngredientInput(
    string RawText,
    decimal? Quantity = null,
    string? Unit = null,
    string? Name = null,
    string? Note = null,
    string? SectionHeading = null);

public record RecipeStepInput(string Text, string? SectionHeading = null);

// ---------- Meal plan ----------

/// <summary>Seven days starting at <see cref="Start"/>. Days with nothing planned are still present, with no entries.</summary>
public record MealWeekDto(DateOnly Start, DateOnly End, IReadOnlyList<MealDayDto> Days);

public record MealDayDto(DateOnly Date, IReadOnlyList<MealPlanEntryDto> Entries);

/// <summary>
/// A planned meal. <see cref="RecipeTitle"/> is denormalized so the week screen renders from one
/// request — it shows day + title and has no use for the recipe body.
/// </summary>
public record MealPlanEntryDto(
    int Id,
    DateOnly Date,
    string Slot,
    int? RecipeId,
    string? RecipeTitle,
    bool RecipeHasImage,
    string? FreeText,
    int? ServingsOverride,
    /// <summary>Null unanswered, true eaten, false skipped. See <see cref="MealPlanEntry.WasEaten"/>.</summary>
    bool? WasEaten,
    /// <summary>Order within the slot — a night can hold several recipes (MEALS_GROUPS §6.1).</summary>
    int Position,
    /// <summary><c>Main</c> / <c>Side</c> / <c>Dessert</c>. A single-recipe night is always Main.</summary>
    string Role,
    /// <summary>Total cook time of the recipe behind this entry, for deriving the night's order.</summary>
    int? TotalMinutes,
    int Version,
    /// <summary>
    /// The one word the week row carries — <c>Covered</c>, <c>Short</c>, <c>Unknown</c> or
    /// <c>NoClaim</c> (KITCHEN_LOOP_ADDENDUM §1, PLAN_WEEK §1).
    /// </summary>
    /// <remarks>
    /// Null when the caller did not ask for it. It is on the week response rather than fetched per
    /// night because the alternative is a stock check per row — seven round trips to draw seven
    /// words, on the screen that opens most.
    /// </remarks>
    string? StockSummary = null)
{
    public static MealPlanEntryDto From(MealPlanEntry e, PlanStockSummary? summary = null) => new(
        e.Id, e.Date, e.Slot.ToString(), e.RecipeId, e.Recipe?.Title, e.Recipe?.ImagePath is not null,
        e.FreeText, e.ServingsOverride, e.WasEaten, e.Position, e.Role.ToString(),
        e.Recipe?.TotalMinutes, e.Version, summary?.ToString());
}

/// <summary>
/// Assign a slot. At least one of <see cref="RecipeId"/> / <see cref="FreeText"/> must be set —
/// neither is a 400, both is linked leftovers. Upserts, because a date+slot holds at most one plan.
/// </summary>
public record MealPlanInput(
    DateOnly Date,
    MealSlot Slot,
    int? RecipeId = null,
    string? FreeText = null,
    int? ServingsOverride = null,
    /// <summary>
    /// Role for this recipe on the night. Ignored when <see cref="Replace"/> is true and this is the
    /// first entry — the first recipe on a night is always the Main (MEALS_GROUPS §1).
    /// </summary>
    MealRole? Role = null,
    /// <summary>
    /// True — the historic behaviour — clears the slot first, so this becomes the only thing on it.
    /// False adds alongside whatever is already there, which is how a night grows a side.
    /// </summary>
    /// <remarks>
    /// Defaults to true so every caller written against the one-recipe-per-slot contract keeps
    /// behaving exactly as it did. Building an arrangement is the deliberate act, and it says so.
    /// </remarks>
    bool Replace = true,
    /// <summary>
    /// Who is making this change. Attribution only — there is no auth to derive it from — and its
    /// sole use is deciding whether the change is worth telling the rest of the household about.
    /// </summary>
    int? ProfileId = null);

/// <summary>Remove one recipe from a night, leaving the rest of the arrangement alone.</summary>
public record RemovePlanEntryInput(int EntryId);

/// <summary>
/// Answer the morning-after ask for one night.
/// </summary>
/// <remarks>
/// Its own input and its own endpoint rather than a field on <see cref="MealPlanInput"/>, because
/// the contract's rule is that <see cref="MealPlanEntry.WasEaten"/> is written by the confirm
/// surface and nowhere else. Hanging it off the upsert would mean every assign either carries the
/// flag or silently clears it, and the second of those is how "we ate that" quietly becomes
/// "unanswered" when someone changes the servings.
/// </remarks>
public record MealEatenInput(
    DateOnly Date,
    MealSlot Slot,
    bool? WasEaten,
    /// <summary>
    /// How many actually sat down, when fewer did than were cooked for (COOKING_AND_AFTER §2's
    /// `OR SOME OF IT`). Null means everyone — a plain yes, and nothing spare.
    /// </summary>
    int? PortionsEaten = null);

/// <summary>
/// Import a recipe from a link. Attribution comes only from the authenticated caller.
/// </summary>
public record RecipeImportInput(
    string Url,
    /// <summary>
    /// What to call it, when the household typed a name on the add screen. Overrides the page's own
    /// title rather than filling in for it: a publisher's "Our Best-Ever Weeknight Chili (Really!)"
    /// is a headline, and the folder is browsed by the name the household would actually say.
    /// </summary>
    string? Title = null);

/// <summary>
/// A recipe copied off a page and pasted in, for publishers that refuse the fetcher.
/// </summary>
/// <remarks>
/// <see cref="SourceUrl"/> is provenance only and is <b>never fetched</b> — this path does no
/// network I/O at all, which is the whole reason it works where the URL importer cannot.
/// </remarks>
public record RecipePasteInput(
    string Text,
    string? SourceUrl = null,
    /// <summary>
    /// What to call it, from the box on the add screen. Overrides the name the parser reads off the
    /// top of the block — a typed name is a decision, and the parser's is a guess at where the
    /// recipe started.
    /// </summary>
    string? Title = null,
    /// <summary>The cuisine chip, which the parser has no way to read off a block of text.</summary>
    IReadOnlyList<string>? Tags = null);

/// <summary>
/// Set (or clear) the one thing the folder groups by.
/// </summary>
/// <remarks>
/// <b>Its own endpoint rather than a field on a full replace.</b> Cuisine is stored as a reserved
/// <c>cuisine:</c> tag (MEALS_DATA_CONTRACT §2), so changing it through <c>PUT /recipes/{id}</c>
/// would mean the caller sending the recipe's entire tag list back — and a screen that only wanted
/// to say "this is Mexican" would be in a position to drop every other tag by omission. A named
/// action can only do the one thing, which is also what makes it safe to offer from the detail
/// screen, where the whole recipe is on display but not in hand.
/// <para>
/// Import still guesses (<c>recipeCuisine</c>, via <see cref="JsonLdRecipeImporter"/>); this is how
/// a household overrules the guess, and nothing re-derives it afterwards.
/// </para>
/// </remarks>
public record RecipeCuisineInput(
    /// <summary>A cuisine in the household's own words — "Middle Eastern". Null or blank clears it.</summary>
    string? Cuisine);

// ---- Saved weeks (KITCHEN_LOOP_ADDENDUM §6) ----

/// <summary>A saved week as the picker lists it.</summary>
public record MealPlanTemplateDto(
    int Id,
    string Name,
    /// <summary>How many nights it fills — enough to choose between two saved weeks.</summary>
    int NightCount,
    DateTime CreatedUtc);

/// <summary>`SAVE THIS WEEK` — names the week starting <see cref="Start"/> and keeps its shape.</summary>
public record SaveWeekInput(string Name, DateOnly Start);

/// <summary>What applying a template did.</summary>
/// <remarks>
/// <see cref="Skipped"/> is not an error count. A template whose recipe was later deleted simply
/// leaves that night alone, and saying so is more useful than failing the whole apply.
/// </remarks>
public record ApplyTemplateResultDto(int Written, int Skipped);
