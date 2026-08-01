namespace HomeHub.Api.Meals;

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
    bool KeepLink = true,
    int? ModifiedByProfileId = null);

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
    string? PrepNote = null,
    /// <summary>
    /// Who is making this edit. Optional: an unattributed write (a script, the Stage M2 importer)
    /// leaves the previous attribution in place rather than blanking it, because "nobody changed
    /// this last" is never true of a recipe that has been changed.
    /// </summary>
    int? ModifiedByProfileId = null);

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
    int Version)
{
    public static MealPlanEntryDto From(MealPlanEntry e) => new(
        e.Id, e.Date, e.Slot.ToString(), e.RecipeId, e.Recipe?.Title, e.Recipe?.ImagePath is not null,
        e.FreeText, e.ServingsOverride, e.WasEaten, e.Position, e.Role.ToString(),
        e.Recipe?.TotalMinutes, e.Version);
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
public record MealEatenInput(DateOnly Date, MealSlot Slot, bool? WasEaten);

/// <summary>
/// Import a recipe from a link. <see cref="ProfileId"/> is optional and only sets attribution —
/// there is no authentication on this endpoint to derive it from (meals-planning.md D6).
/// </summary>
public record RecipeImportInput(string Url, int? ProfileId = null);
