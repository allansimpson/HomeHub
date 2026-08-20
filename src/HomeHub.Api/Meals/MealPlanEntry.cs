namespace HomeHub.Api.Meals;

/// <summary>
/// One planned meal: a date, a slot, and either a recipe or a bit of free text.
/// <para>
/// <b><see cref="Date"/> is a <see cref="DateOnly"/>, deliberately breaking the app's
/// <c>DateTime …Utc</c> convention</b> (meals-planning.md D7). Every other date here is an instant;
/// this one is a calendar date. Tuesday's dinner is Tuesday's dinner — stored as UTC it would shift
/// across the midnight boundary with the offset and render on Monday.
/// </para>
/// At least one of <see cref="RecipeId"/> / <see cref="FreeText"/> is set, enforced by the
/// controller: free text is how "leftovers" or "takeout" occupies a slot without inventing a
/// recipe, and it is also what a planned recipe degrades into if the recipe is later deleted.
/// <b>Both together</b> is the linked-leftovers case (MEALS_DATA_CONTRACT §3.1) — Tuesday lunch
/// reads "Leftovers" but still opens Monday's recipe at the servings it was cooked at. Storing
/// that as the text <c>"Leftovers of Chicken Piccata"</c> was rejected: it loses the link and the
/// servings, which are the only two things the row exists to carry.
/// </summary>
public class MealPlanEntry
{
    public int Id { get; set; }

    /// <summary>The household's local calendar date — not an instant. See the type note above.</summary>
    public DateOnly Date { get; set; }

    public MealSlot Slot { get; set; } = MealSlot.Dinner;

    /// <summary>
    /// Order within the slot. A night can hold several recipes (MEALS_GROUPS §6.1) — the main, a
    /// side, a dessert — and this is what makes "the entries on this slot" an ordered arrangement
    /// rather than a set.
    /// </summary>
    public int Position { get; set; }

    /// <summary>
    /// What this recipe is to the night. The first recipe added is the <see cref="MealRole.Main"/>.
    /// </summary>
    /// <remarks>
    /// Three fixed values and no more. A richer vocabulary ("starter", "salad", "sauce") is a
    /// taxonomy somebody has to maintain and agree on, and the only thing the panel does with a role
    /// is order the schedule and label a 58px column.
    /// </remarks>
    public MealRole Role { get; set; } = MealRole.Main;

    /// <summary>The planned recipe, or null when this slot holds <see cref="FreeText"/> instead.</summary>
    public int? RecipeId { get; set; }
    public Recipe? Recipe { get; set; }

    /// <summary>
    /// What the row reads as when it isn't simply the recipe's title ("Leftovers", "Takeout").
    /// Set alone for a plan with no recipe behind it, or alongside <see cref="RecipeId"/> for
    /// linked leftovers.
    /// </summary>
    public string? FreeText { get; set; }

    /// <summary>Cook for a different number than the recipe's own yield. Null = use the recipe's.</summary>
    public int? ServingsOverride { get; set; }

    /// <summary>
    /// Did the household actually eat this? Null unanswered, true cooked and eaten, false planned
    /// but not (MEALS_DATA_CONTRACT §3.2).
    /// <para>
    /// <b>Written only by the confirm surface</b> — the morning-after "what actually happened" ask.
    /// Never inferred from the date passing, because "it was planned and the day is over" is not
    /// evidence that anyone cooked it. <see cref="Recipe"/>'s cooked history counts
    /// <c>true</c> only, so an unanswered night stays uncounted rather than being assumed either
    /// way; that is what keeps the folder's NOT LATELY sort honest.
    /// </para>
    /// </summary>
    public bool? WasEaten { get; set; }

    /// <summary>
    /// How many portions were actually eaten, when the household answered "or some of it"
    /// (COOKING_AND_AFTER §2).
    /// </summary>
    /// <remarks>
    /// Null on a plain yes, which means everyone ate and there is nothing spare. The difference
    /// between this and <see cref="ServingsOverride"/> is what the leftovers card offers to put in
    /// the fridge — and it is a guess, which is why C3 labels it one rather than presenting a keypad.
    /// </remarks>
    public int? PortionsEaten { get; set; }

    public DateTime CreatedUtc { get; set; }
    public DateTime UpdatedUtc { get; set; }

    /// <summary>Optimistic-concurrency token bumped on every write, per Stage 9b.</summary>
    public int Version { get; set; } = 1;
}
