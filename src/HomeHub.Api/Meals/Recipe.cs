namespace HomeHub.Api.Meals;

/// <summary>
/// A recipe in the household's own folder.
/// <para>
/// Unlike every other domain in the app, this is <b>not</b> a cache of an external system of
/// record — HomeHub owns recipes outright, which is why there is no provider seam here
/// (meals-planning.md D1). Imported rows keep <see cref="SourceUrl"/> and
/// <see cref="SourceName"/> so the detail screen can attribute the original.
/// </para>
/// The ingredient / step / tag types live alongside it because they are one aggregate: they have
/// no meaning apart from their recipe and are always loaded and saved with it.
/// </summary>
public class Recipe
{
    public int Id { get; set; }

    public required string Title { get; set; }

    public string? Description { get; set; }

    /// <summary>Where it was imported from. Null for manually entered recipes.</summary>
    public string? SourceUrl { get; set; }

    /// <summary>Human-readable origin ("Serious Eats") for the attribution line.</summary>
    public string? SourceName { get; set; }

    /// <summary>Parsed serving count, when the source gave a usable number. Drives scaling.</summary>
    public int? Servings { get; set; }

    /// <summary>The source's own yield wording ("4 to 6 servings"), shown when <see cref="Servings"/> is null.</summary>
    public string? YieldText { get; set; }

    public int? PrepMinutes { get; set; }
    public int? CookMinutes { get; set; }
    public int? TotalMinutes { get; set; }

    /// <summary>
    /// Filename of the locally cached hero image (doc D5 — written to the configured image
    /// directory, never to <c>wwwroot</c>, which deploys wipe). Served via
    /// <c>GET /api/recipes/{id}/image</c> in Stage M2. Null until then, and whenever caching failed.
    /// </summary>
    public string? ImagePath { get; set; }

    /// <summary>The image's original URL, kept for re-fetching if the cache is ever lost.</summary>
    public string? ImageSourceUrl { get; set; }

    public RecipeImportMethod ImportMethod { get; set; } = RecipeImportMethod.Manual;

    /// <summary>
    /// Set by the Stage M2 importer (doc D10). Manual recipes are always
    /// <see cref="RecipeCompleteness.Complete"/> — the person typing decides when they are done.
    /// </summary>
    public RecipeCompleteness Completeness { get; set; } = RecipeCompleteness.Complete;

    /// <summary>What was missing, when <see cref="Completeness"/> is Partial ("no steps found").</summary>
    public string? IncompleteReason { get; set; }

    /// <summary>Hidden from the folder without losing plan history that references it.</summary>
    public bool IsArchived { get; set; }

    /// <summary>
    /// The recipe this one was forked from — "your version of Chicken Piccata" (MEALS_FORK §1).
    /// </summary>
    /// <remarks>
    /// A variation is an <b>ordinary recipe</b> that remembers where it came from: editable,
    /// plannable, deletable and forkable again like any other. This one nullable column is the only
    /// thing that makes it a variation, which is why there is no revision table and no version
    /// browser.
    /// <para>
    /// <b>Deliberately not a foreign key, and no cascade.</b> Deleting either recipe must leave the
    /// other completely intact — the survivor's lineage strip simply loses its link and keeps the
    /// name as text, the same pattern as a deleted recipe on a plan entry. A real FK with any
    /// delete behaviour would either take the child with the parent or block the parent's deletion,
    /// and both are wrong here.
    /// </para>
    /// <para>The parent knows nothing about its children; the folder queries by this when it needs them.</para>
    /// </remarks>
    public int? ForkedFrom { get; set; }

    /// <summary>
    /// How far ahead this recipe needs starting — an overnight marinade, a frozen joint, a levain.
    /// Free text in <see cref="PrepNote"/> says what; this says when, in minutes before the meal.
    /// Nothing is inferred from the ingredients (MEALS_DATA_CONTRACT §3.4): a parser guessing
    /// "soak overnight" out of an ingredient line would be wrong often enough to be worse than
    /// silent.
    /// </summary>
    public int? LeadMinutes { get; set; }

    /// <summary>
    /// What to do ahead of time, in the cook's own words. Drives BEFORE YOU START on the detail
    /// screen and the evening-before notice.
    /// </summary>
    public string? PrepNote { get; set; }

    /// <summary>
    /// Who last changed this recipe, for the attribution strip. Null for rows never edited since
    /// import, and for edits made before this was tracked.
    /// </summary>
    /// <remarks>
    /// Deliberately not a revision history (MEALS_DATA_CONTRACT §3, "Also needed for attribution").
    /// The collection is shared by design, so the useful question is "who touched this last and
    /// when", which this answers; the per-line diff the 409 path already produces covers "what
    /// changed". Keeping more would be storage in search of a screen.
    /// </remarks>
    public int? ModifiedByProfileId { get; set; }

    /// <summary>
    /// When <see cref="ModifiedByProfileId"/> made that change. Distinct from
    /// <see cref="UpdatedUtc"/>, which also moves for writes that carry no profile.
    /// </summary>
    public DateTime? ModifiedAtUtc { get; set; }

    public DateTime CreatedUtc { get; set; }
    public DateTime UpdatedUtc { get; set; }

    /// <summary>Optimistic-concurrency token bumped on every write, per Stage 9b.</summary>
    public int Version { get; set; } = 1;

    public List<RecipeIngredient> Ingredients { get; set; } = [];
    public List<RecipeStep> Steps { get; set; } = [];
    public List<RecipeTag> Tags { get; set; } = [];
}

/// <summary>
/// One ingredient line. <see cref="RawText"/> is authoritative and is what the panel displays;
/// the parsed fields are best-effort and exist only for serving scaling and shopping-list merging
/// (doc D3). A line the parser cannot read leaves every parsed field null — <b>never a guess</b>,
/// because a wrong quantity in a shopping list is worse than an unmerged one.
/// </summary>
public class RecipeIngredient
{
    public int Id { get; set; }

    public int RecipeId { get; set; }
    public Recipe? Recipe { get; set; }

    /// <summary>Display order within the recipe.</summary>
    public int Position { get; set; }

    /// <summary>The original line, exactly as the source wrote it. Always populated.</summary>
    public required string RawText { get; set; }

    public decimal? Quantity { get; set; }
    public string? Unit { get; set; }
    public string? Name { get; set; }

    /// <summary>Trailing qualifier split off the name ("divided", "finely chopped").</summary>
    public string? Note { get; set; }

    /// <summary>Group heading this line sits under ("For the sauce"), when the source had one.</summary>
    public string? SectionHeading { get; set; }
}

/// <summary>One instruction step. Cook mode (Stage M4) walks these in <see cref="Position"/> order.</summary>
public class RecipeStep
{
    public int Id { get; set; }

    public int RecipeId { get; set; }
    public Recipe? Recipe { get; set; }

    public int Position { get; set; }

    public required string Text { get; set; }

    /// <summary>Group heading, when the source used <c>HowToSection</c>.</summary>
    public string? SectionHeading { get; set; }
}

/// <summary>
/// A free-text tag on a recipe, driving the folder's Chip filters. Deliberately a plain string
/// rather than a normalized tag table with a join: at household scale that is overhead with no
/// payoff, and it keeps the whole aggregate one round-trip away.
/// </summary>
public class RecipeTag
{
    public int Id { get; set; }

    public int RecipeId { get; set; }
    public Recipe? Recipe { get; set; }

    public required string Tag { get; set; }
}
