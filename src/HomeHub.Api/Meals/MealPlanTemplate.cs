namespace HomeHub.Api.Meals;

/// <summary>
/// A week the household saved to use again (KITCHEN_LOOP_ADDENDUM §6, panel `3a`).
/// </summary>
/// <remarks>
/// <para>
/// Paprika saves meal plans as reusable Menus and MealBoard has templates; the market study lists
/// this as table stakes and notes it is "what makes a planner survive month three". Households cook
/// in rhythms, and re-picking the same six dinners every Sunday is the friction that gets a planner
/// abandoned.
/// </para>
/// <para>
/// <b>Applying one writes plan entries and nothing else.</b> It re-settles claims, because what is
/// planned changed — but it never touches stock, never deducts, and never adds to the list. A
/// template is a shortcut for the picking, not a claim about what happened.
/// </para>
/// </remarks>
public class MealPlanTemplate
{
    public int Id { get; set; }

    /// <summary>What the household calls it — "Usual week", "Half term".</summary>
    public string Name { get; set; } = string.Empty;

    public List<MealPlanTemplateEntry> Entries { get; set; } = [];

    public DateTime CreatedUtc { get; set; }
    public int? CreatedByProfileId { get; set; }
}

/// <summary>
/// One night of a saved week, stored as an offset rather than a date.
/// </summary>
/// <remarks>
/// <see cref="DayOffset"/> is days from the start of the template, so applying it to any week lands
/// the same shape. Storing real dates would make a saved week usable exactly once.
/// </remarks>
public class MealPlanTemplateEntry
{
    public int Id { get; set; }

    public int TemplateId { get; set; }
    public MealPlanTemplate? Template { get; set; }

    /// <summary>Days from the template's first day. Zero is the day it is applied to.</summary>
    public int DayOffset { get; set; }

    public MealSlot Slot { get; set; } = MealSlot.Dinner;
    public int Position { get; set; }
    public MealRole Role { get; set; } = MealRole.Main;

    /// <summary>
    /// The recipe, when there was one.
    /// </summary>
    /// <remarks>
    /// Nullable and not cascaded: a template outlives a recipe somebody later deleted, and applying
    /// it then simply skips that night rather than failing whole. A saved week that stops working
    /// because one dish was archived would be worse than one with a gap in it.
    /// </remarks>
    public int? RecipeId { get; set; }

    public string? FreeText { get; set; }
    public int? ServingsOverride { get; set; }
}
