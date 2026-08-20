namespace HomeHub.Api.Pantry;

using HomeHub.Api.Data;
using HomeHub.Api.Meals;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// Resolves a recipe's ingredient line to the pantry item it means, if any.
/// </summary>
/// <remarks>
/// <para>
/// Extracted so the stock check (9b) and the plan settler (<see cref="PlanClaimService"/>) cannot
/// disagree about what a line matches. They must not: the week says <c>ALL IN</c> from the
/// settler's answer and the night says <c>3 SHORT</c> from the check's, and two matchers that drift
/// apart would put those two words in conflict on screen with no way to tell which lied.
/// </para>
/// <para>
/// A line resolves by taught alias first, then by the item's own normalised name — an item called
/// "Chicken breasts" answers to "chicken breast" without anyone having taught it that. Anything
/// unresolved stays unresolved: <see cref="Match"/> returns null and the caller reports
/// <see cref="StockStatus.NoMatch"/>, never "fine". Silence about a line you cannot resolve is how
/// the check starts lying (DECISIONS PG6).
/// </para>
/// </remarks>
internal sealed class PantryMatcher
{
    private readonly Dictionary<string, int> _aliases;
    private readonly Dictionary<string, int> _byName;
    private readonly Dictionary<int, PantryItem> _byId;
    private readonly HashSet<(string Name, int ItemId)> _rejected;

    private PantryMatcher(
        Dictionary<string, int> aliases, Dictionary<string, int> byName, List<PantryItem> items,
        HashSet<(string, int)> rejected)
    {
        _aliases = aliases;
        _byName = byName;
        _byId = items.ToDictionary(i => i.Id);
        _rejected = rejected;
    }

    /// <summary>Every non-archived item the matcher can resolve to.</summary>
    public IReadOnlyCollection<PantryItem> Items => _byId.Values;

    /// <summary>Load the shelves and the alias table in one pass.</summary>
    public static async Task<PantryMatcher> LoadAsync(HomeHubDbContext db, CancellationToken ct)
    {
        var items = await db.PantryItems.Where(i => !i.IsArchived).ToListAsync(ct);

        var aliases = await db.IngredientAliases
            .Where(a => !a.Item!.IsArchived)
            .ToDictionaryAsync(a => a.Alias, a => a.PantryItemId, ct);

        var byName = new Dictionary<string, int>();
        foreach (var item in items)
        {
            var key = IngredientNormaliser.Normalise(item.Name);
            if (key.Length > 0) byName.TryAdd(key, item.Id);
        }

        // A pair the household has said is wrong stays wrong (MATCHING_AND_ALIASES §5).
        var rejected = (await db.AliasRejections
                .Select(r => new { r.CanonicalName, r.PantryItemId })
                .ToListAsync(ct))
            .Select(r => (r.CanonicalName, r.PantryItemId))
            .ToHashSet();

        return new PantryMatcher(aliases, byName, items, rejected);
    }

    /// <summary>The item this ingredient line means, or null when nothing on the shelves answers to it.</summary>
    public PantryItem? Match(RecipeIngredient ingredient)
    {
        var key = IngredientNormaliser.Normalise(ingredient.Name ?? ingredient.RawText);
        if (key.Length == 0) return null;

        var id = _aliases.TryGetValue(key, out var viaAlias) ? viaAlias
            : _byName.TryGetValue(key, out var viaName) ? viaName
            : (int?)null;

        if (id is not { } found) return null;

        // Refused pairings are not matches, however the name happens to normalise. The line falls
        // back to unmatched, which is the honest answer and the one that keeps asking.
        if (_rejected.Contains((key, found))) return null;

        return _byId.TryGetValue(found, out var item) ? item : null;
    }
}
