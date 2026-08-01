namespace HomeHub.Api.Meals;

/// <summary>
/// A saved meal as the folder list sees it (MEALS_GROUPS §4.4).
/// </summary>
/// <remarks>
/// Component titles ride along deliberately. The folder's meta line for a meal names its parts —
/// "SPAGHETTI BOLOGNESE + GARLIC TOAST" — and §6.2 requires that render without N extra fetches,
/// because the alternative is a request per row on a screen that polls.
/// </remarks>
public record MealSummaryDto(
    int Id,
    string Name,
    int? Servings,
    string? PrepNote,
    string? Cuisine,
    bool IsArchived,
    /// <summary>Component titles in position order, for the meta line.</summary>
    IReadOnlyList<string> RecipeTitles,
    int RecipeCount,
    /// <summary>Sum of the components' cook times, for `47 MIN TOTAL`. Null when none of them say.</summary>
    int? TotalMinutes,
    /// <summary>Cooked history for the meal <b>as a unit</b> (MEALS_GROUPS §5).</summary>
    DateOnly? LastCookedDate,
    int TimesCooked,
    int Version);

/// <summary>The full meal, for the detail screen.</summary>
public record MealDto(
    int Id,
    string Name,
    int? Servings,
    string? PrepNote,
    string? Cuisine,
    bool IsArchived,
    IReadOnlyList<MealComponentDto> Components,
    int? TotalMinutes,
    DateOnly? LastCookedDate,
    int TimesCooked,
    int? ModifiedByProfileId,
    string? ModifiedByName,
    DateTime? ModifiedAtUtc,
    int Version);

/// <summary>One recipe inside a meal, carrying just enough to render the row and the schedule.</summary>
public record MealComponentDto(
    int RecipeId,
    string Title,
    string Role,
    int Position,
    int? TotalMinutes,
    int? Servings,
    string? SourceName);

/// <summary>
/// Create/replace payload. Components are sent whole and replace what was stored, matching how a
/// recipe's ingredients are edited — one document, no partial-update shape to get wrong.
/// </summary>
public record MealInput(
    string Name,
    IReadOnlyList<MealComponentInput>? Components = null,
    int? Servings = null,
    string? PrepNote = null,
    string? Cuisine = null,
    bool IsArchived = false,
    int? ModifiedByProfileId = null);

public record MealComponentInput(int RecipeId, MealRole Role = MealRole.Main);

/// <summary>
/// Put a saved meal on a night. Expands into one plan entry per component (MEALS_GROUPS §6.2) —
/// the night does not reference the meal, so editing the template later never rewrites a night that
/// has already been planned.
/// </summary>
public record AssignMealInput(DateOnly Date, MealSlot Slot, int MealId, int? ServingsOverride = null);

/// <summary>
/// A set of recipes the household has actually cooked together, and how often (MEALS_GROUPS §6.3).
/// </summary>
/// <remarks>
/// Counted from confirmed nights only. Offering to name a pairing the household merely *planned*
/// three times — and skipped every time — would be the panel noticing a habit that does not exist.
/// </remarks>
public record CoOccurrenceDto(IReadOnlyList<int> RecipeIds, IReadOnlyList<string> Titles, int Times);
