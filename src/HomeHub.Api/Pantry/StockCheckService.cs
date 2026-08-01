namespace HomeHub.Api.Pantry;

using HomeHub.Api.Data;
using HomeHub.Api.Meals;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// A plan entry whose stock check has been dismissed with "Leave it, I'll sort it".
/// </summary>
/// <remarks>
/// Per plan entry, not per recipe: the same recipe next week is a new night and deserves the check
/// again. PANTRY_BEHAVIOURS §5 also requires the check to <i>re-run</i> when the entry is edited
/// (servings changed, recipe swapped) unless it was dismissed — which is why this records the entry
/// rather than suppressing the recipe.
/// </remarks>
public class StockCheckDismissal
{
    public int Id { get; set; }
    public int PlanEntryId { get; set; }
    public DateTime AtUtc { get; set; }
    public int? ByProfileId { get; set; }
}

/// <summary>
/// Works out what a night probably needs (9b), server-side because the aliases live there.
/// </summary>
/// <remarks>
/// <b>Nothing this returns is a gate</b> (PANTRY_BEHAVIOURS §1). The plan entry is already written
/// before the caller asks, and a shortfall never prevents assigning, cooking or confirming. The
/// service is also deliberately silent about what it cannot resolve in only one direction: an
/// ingredient with no alias comes back <see cref="StockStatus.NoMatch"/> and is listed, never
/// folded into "fine". Silence about a line you cannot resolve is how the check starts lying
/// (DECISIONS PG6).
/// </remarks>
public sealed class StockCheckService
{
    private readonly HomeHubDbContext _db;
    private readonly PantryLedger _ledger;

    public StockCheckService(HomeHubDbContext db, PantryLedger ledger)
    {
        _db = db;
        _ledger = ledger;
    }

    /// <summary>Check a recipe's lines against the shelves at a given number of servings.</summary>
    public async Task<StockCheckDto?> CheckAsync(int recipeId, int? servings, CancellationToken ct)
    {
        var recipe = await _db.Recipes
            .Include(r => r.Ingredients)
            .FirstOrDefaultAsync(r => r.Id == recipeId, ct);
        if (recipe is null) return null;

        var target = servings ?? recipe.Servings ?? 0;
        // Scale exactly as the recipe screen does: from the base the stored amounts make. A line the
        // parser could not read has no quantity to scale and is simply asked about as written.
        var factor = recipe.Servings is > 0 && target > 0 ? (decimal)target / recipe.Servings.Value : 1m;

        var items = await _db.PantryItems.Where(i => !i.IsArchived).ToListAsync(ct);
        var lastSeen = await _ledger.LastSeenAsync(items.Select(i => i.Id).ToList(), ct);

        var aliases = await _db.IngredientAliases
            .Where(a => !a.Item!.IsArchived)
            .ToDictionaryAsync(a => a.Alias, a => a.PantryItemId, ct);

        // The pantry's own names are aliases too, and free ones — an item called "Chicken breasts"
        // answers to "chicken breast" without anyone having taught it that.
        var byName = new Dictionary<string, int>();
        foreach (var item in items)
        {
            var key = IngredientNormaliser.Normalise(item.Name);
            if (key.Length > 0) byName.TryAdd(key, item.Id);
        }

        var lines = new List<StockCheckLineDto>();
        var notCounted = new List<string>();

        foreach (var ingredient in recipe.Ingredients.OrderBy(i => i.Position))
        {
            var key = IngredientNormaliser.Normalise(ingredient.Name ?? ingredient.RawText);
            var itemId = key.Length == 0
                ? (int?)null
                : aliases.TryGetValue(key, out var viaAlias) ? viaAlias
                : byName.TryGetValue(key, out var viaName) ? viaName
                : null;

            var item = itemId is null ? null : items.FirstOrDefault(i => i.Id == itemId);
            var needed = NeededText(ingredient, factor);

            if (item is null)
            {
                lines.Add(new StockCheckLineDto(
                    ingredient.Id, DisplayName(ingredient), needed,
                    nameof(StockStatus.NoMatch), null, null, null, null, null));
                continue;
            }

            var seenAt = lastSeen.TryGetValue(item.Id, out var at) ? at : (DateTime?)null;

            if (item.Tracking == TrackingClass.NotCounted)
            {
                notCounted.Add(item.Name);
                lines.Add(new StockCheckLineDto(
                    ingredient.Id, DisplayName(ingredient), needed,
                    nameof(StockStatus.NotCounted), item.Id, null, item.Unit, null, seenAt));
                continue;
            }

            var status = Verdict(item, ingredient, factor);
            lines.Add(new StockCheckLineDto(
                ingredient.Id, DisplayName(ingredient), needed, status.ToString(), item.Id,
                item.Quantity, item.Unit, item.EstimateState?.ToString(), seenAt));
        }

        var flagged = lines.Count(l => IsFlagged(l.Status));

        return new StockCheckDto(
            recipe.Id, recipe.Title, target, lines, flagged, lines.Count,
            notCounted, await UsualDeliveryWeekdayAsync(ct));
    }

    /// <summary>Which statuses 9b lists under `WORTH A LOOK`.</summary>
    public static bool IsFlagged(string status) =>
        status is nameof(StockStatus.Short) or nameof(StockStatus.Gone)
            or nameof(StockStatus.Unknown) or nameof(StockStatus.NoMatch);

    /// <summary>
    /// The verdict for one matched line.
    /// </summary>
    /// <remarks>
    /// The <see cref="StockStatus.Unknown"/> branch is the important one and it is reached often, by
    /// design: a counted item whose unit cannot be compared to the recipe's ("4 tbsp" against "1
    /// jar") is <i>not</i> short and <i>not</i> fine, and saying either would be a confident guess
    /// about the thing the section exists to be honest about.
    /// </remarks>
    internal static StockStatus Verdict(PantryItem item, RecipeIngredient ingredient, decimal factor)
    {
        if (item.Tracking == TrackingClass.NotCounted) return StockStatus.NotCounted;

        if (item.Tracking == TrackingClass.Estimated)
        {
            return item.EstimateState switch
            {
                EstimateState.None => StockStatus.Gone,
                // "There's a jar, marked low. No way to tell if that's four spoons." — a question,
                // not a warning, which is exactly how the copy rules want it worded.
                EstimateState.Low => StockStatus.Unknown,
                _ => StockStatus.Fine,
            };
        }

        var have = item.Quantity ?? 0;
        if (have <= 0) return StockStatus.Gone;

        if (ingredient.Quantity is not { } quantity) return StockStatus.Unknown;
        var scaled = quantity * factor;

        var comparable = UnitConversion.Convert(scaled, ingredient.Unit, item.Unit);
        if (comparable is null) return StockStatus.Unknown;

        return have < comparable.Value ? StockStatus.Short : StockStatus.Fine;
    }

    /// <summary>`needs 4 tbsp`, `needs 6` — what the line asks for at the chosen servings.</summary>
    private static string? NeededText(RecipeIngredient ingredient, decimal factor)
    {
        if (ingredient.Quantity is not { } quantity) return null;
        var scaled = quantity * factor;
        var rounded = decimal.Round(scaled, 2);
        var number = rounded == decimal.Truncate(rounded)
            ? decimal.Truncate(rounded).ToString(System.Globalization.CultureInfo.InvariantCulture)
            : rounded.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture);
        return string.IsNullOrWhiteSpace(ingredient.Unit) ? number : $"{number} {ingredient.Unit}";
    }

    private static string DisplayName(RecipeIngredient ingredient) =>
        !string.IsNullOrWhiteSpace(ingredient.Name) ? ingredient.Name! : ingredient.RawText;

    /// <summary>
    /// The weekday deliveries usually land on. <b>Null below three imports</b> — §3 says omit the
    /// clause entirely rather than describe a rhythm from one delivery.
    /// </summary>
    private async Task<string?> UsualDeliveryWeekdayAsync(CancellationToken ct)
    {
        var recent = await _db.OrderImports
            .Where(i => i.DeliveredAtUtc != null && i.Status == OrderImportStatus.Applied)
            .OrderByDescending(i => i.DeliveredAtUtc)
            .Take(3)
            .Select(i => i.DeliveredAtUtc!.Value)
            .ToListAsync(ct);
        if (recent.Count < 3) return null;

        var days = recent.Select(d => d.DayOfWeek).OrderBy(d => (int)d).ToList();
        return days[1].ToString();
    }
}
