namespace HomeHub.Api.Meals;

/// <summary>
/// Which meal of the day a plan entry occupies. The week screen shows <see cref="Dinner"/> only
/// (meals-planning.md Stage M1) — the other members cost nothing now and save a migration if the
/// UI ever grows past dinner.
/// </summary>
public enum MealSlot
{
    Breakfast = 0,
    Lunch = 1,
    Dinner = 2,
    Other = 3,
}

/// <summary>
/// What a recipe is to the night, or to a saved meal (MEALS_GROUPS §1). Exactly three, deliberately:
/// enough to drive the schedule order and a label column, not enough to become a taxonomy.
/// </summary>
public enum MealRole
{
    /// <summary>The dish the night is named after. Every arrangement has exactly one.</summary>
    Main = 0,
    Side = 1,
    Dessert = 2,
}

/// <summary>How a recipe got into the database. Stored as an int; serialized to the client by name.</summary>
public enum RecipeImportMethod
{
    /// <summary>Typed in on the panel.</summary>
    Manual = 0,

    /// <summary>Parsed from schema.org <c>Recipe</c> JSON-LD (Stage M2 — the only importer, per doc D2).</summary>
    JsonLd = 1,

    /// <summary>
    /// Parsed out of a block of text somebody pasted.
    /// </summary>
    /// <remarks>
    /// Distinct from <see cref="Manual"/> on purpose: both were entered by a person, but a pasted
    /// recipe went through <see cref="PastedRecipeImporter"/> and so has parsed amounts that scale,
    /// where a hand-typed one has raw lines that do not. The folder shows provenance, and "somebody
    /// typed this" and "somebody pasted a page that would not let us read it" are different stories.
    /// </remarks>
    Pasted = 2,
}

/// <summary>
/// Whether an imported recipe actually arrived usable (doc D10). A valid <c>Recipe</c> JSON-LD node
/// does not guarantee a usable recipe: paywalled pages (NYT Cooking is the known case) emit a
/// well-formed node with the ingredients and steps stripped out.
/// </summary>
public enum RecipeCompleteness
{
    /// <summary>Title, at least two ingredients, and at least one step.</summary>
    Complete = 0,

    /// <summary>Saved but missing something — <see cref="Recipe.IncompleteReason"/> says what.</summary>
    Partial = 1,
}
