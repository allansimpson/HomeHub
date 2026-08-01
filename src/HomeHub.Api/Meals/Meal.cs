namespace HomeHub.Api.Meals;

/// <summary>
/// A named template that expands into an arrangement of recipes — "Spaghetti Night" =
/// Spaghetti Bolognese (main) + Garlic Toast (side). MEALS_GROUPS §1.
/// <para>
/// <b>A meal is a shortcut, never a requirement.</b> Putting two recipes on a night costs nothing
/// and needs no name; this type exists only so a pairing worth repeating can be picked in one tap.
/// That distinction is the whole design — nothing forces a household to curate, and nothing stops
/// them.
/// </para>
/// <para>
/// Assigning one <b>expands</b> it into plan entries rather than linking to it (§6.2). A night is
/// therefore a record of what was actually cooked, and editing the template later cannot silently
/// rewrite a night already planned.
/// </para>
/// </summary>
public class Meal
{
    public int Id { get; set; }

    /// <summary>Required. What the week row and the home screen's dish slot show.</summary>
    public required string Name { get; set; }

    /// <summary>
    /// Servings for the <b>whole meal</b>. Scaling it scales every component, each from its own base.
    /// </summary>
    public int? Servings { get; set; }

    /// <summary>
    /// The note that only makes sense when two things are cooking at once — "toast under the grill
    /// once the sauce is down". Separate from each recipe's own note, and the documented home for
    /// inter-component dependencies, which §2 deliberately does not model.
    /// </summary>
    public string? PrepNote { get; set; }

    /// <summary>
    /// Cuisine tag in the reserved <c>cuisine:</c> namespace, inherited from the main by default and
    /// overridable. Stored here rather than as a tag row because a meal has exactly one.
    /// </summary>
    public string? Cuisine { get; set; }

    /// <summary>Hidden from the folder without losing the plan history that references its recipes.</summary>
    public bool IsArchived { get; set; }

    public int? ModifiedByProfileId { get; set; }
    public DateTime? ModifiedAtUtc { get; set; }

    public DateTime CreatedUtc { get; set; }
    public DateTime UpdatedUtc { get; set; }

    /// <summary>Optimistic-concurrency token, same conditional-write contract as recipes.</summary>
    public int Version { get; set; } = 1;

    public List<MealComponent> Components { get; set; } = [];
}

/// <summary>One recipe's place in a saved meal.</summary>
public class MealComponent
{
    public int Id { get; set; }

    public int MealId { get; set; }
    public Meal? Meal { get; set; }

    public int RecipeId { get; set; }
    public Recipe? Recipe { get; set; }

    public MealRole Role { get; set; } = MealRole.Main;

    /// <summary>Display and expansion order within the meal.</summary>
    public int Position { get; set; }
}
