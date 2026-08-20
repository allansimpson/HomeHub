namespace HomeHub.Api.Pantry;

using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// Where the household's matching stands, and what would move it (MATCHING_AND_ALIASES §4).
/// </summary>
/// <remarks>
/// Every ranked list in the Kitchen rests on knowing that <c>GV DICED TOMATOES 14.5 OZ</c> is the
/// tinned tomatoes a recipe wants. When that fails, a perfectly correct panel reads as broken — so
/// the section shows its own coverage rather than hiding it, and orders the remaining work by how
/// many recipes each gap unblocks. One number with a direction of travel is what makes the early
/// months feel like a young app rather than a broken one.
/// </remarks>
public sealed class MatchingService
{
    private readonly HomeHubDbContext _db;

    public MatchingService(HomeHubDbContext db) => _db = db;

    /// <summary>An unmatched ingredient, and what settling it would unblock.</summary>
    public sealed record Gap(string Name, int RecipesBlocked);

    /// <summary>The whole of M3 in one shape.</summary>
    public sealed record Coverage(
        int MatchedLines,
        int TotalLines,
        int Percent,
        IReadOnlyDictionary<string, int> BySource,
        IReadOnlyList<Gap> WorthSorting,
        int Undone);

    /// <summary>
    /// Coverage across the household's recipes, attributed, with the gaps ranked.
    /// </summary>
    /// <remarks>
    /// Counted over ingredient lines rather than recipes: a recipe with one unmatched line out of
    /// twelve is nearly solved, and counting it as a whole failure would make the number move in
    /// jumps that bear no relation to the work done.
    /// </remarks>
    public async Task<Coverage> CoverageAsync(CancellationToken ct)
    {
        var recipes = await _db.Recipes
            .Where(r => !r.IsArchived)
            .Include(r => r.Ingredients)
            .ToListAsync(ct);

        var matcher = await PantryMatcher.LoadAsync(_db, ct);

        var matched = 0;
        var total = 0;
        // Distinct recipes blocked per unmatched name — a name wanted twice in one recipe is one
        // recipe unblocked, not two.
        var blocked = new Dictionary<string, HashSet<int>>(StringComparer.OrdinalIgnoreCase);

        foreach (var recipe in recipes)
        {
            foreach (var ingredient in recipe.Ingredients)
            {
                var display = ingredient.Name ?? ingredient.RawText;
                if (string.IsNullOrWhiteSpace(display)) continue;

                total++;
                if (matcher.Match(ingredient) is not null) { matched++; continue; }

                if (!blocked.TryGetValue(display, out var set))
                {
                    set = [];
                    blocked[display] = set;
                }
                set.Add(recipe.Id);
            }
        }

        var bySource = await _db.IngredientAliases
            .GroupBy(a => a.Source)
            .Select(g => new { Source = g.Key, Count = g.Count() })
            .ToDictionaryAsync(x => x.Source.ToString(), x => x.Count, ct);

        var undone = await _db.AliasRejections.CountAsync(ct);

        return new Coverage(
            matched,
            total,
            total == 0 ? 0 : (int)Math.Round(100m * matched / total),
            bySource,
            // "Ordered by how many recipes each one unblocks" — what turns a vague chore into a
            // ranked five-minute job.
            blocked
                .Select(kv => new Gap(kv.Key, kv.Value.Count))
                .OrderByDescending(g => g.RecipesBlocked)
                .ThenBy(g => g.Name, StringComparer.OrdinalIgnoreCase)
                .ToList(),
            undone);
    }

    /// <summary>
    /// Candidates for one unmatched ingredient, best first (M2's `IS IT ONE OF THESE?`).
    /// </summary>
    /// <remarks>
    /// Ranked and finite, with <b>no free-text field anywhere</b>. Typing is what turns teaching a
    /// match into data entry; picking from three is what makes it a minute's work. Pairs the
    /// household has already refused are not offered again.
    /// </remarks>
    public async Task<IReadOnlyList<PantryItem>> CandidatesAsync(
        string ingredient, int take, CancellationToken ct)
    {
        var key = IngredientNormaliser.Normalise(ingredient);
        if (key.Length == 0) return [];

        var refused = await _db.AliasRejections
            .Where(r => r.CanonicalName == key)
            .Select(r => r.PantryItemId)
            .ToListAsync(ct);

        var items = await _db.PantryItems
            .Where(i => !i.IsArchived && !refused.Contains(i.Id))
            .ToListAsync(ct);

        // Shared words, longest first. Crude on purpose: the household is picking from a short list,
        // and a cleverer score that ranked the right answer second would be worse than an obvious
        // one that ranks it first.
        var words = key.Split(' ', StringSplitOptions.RemoveEmptyEntries).ToHashSet();

        return items
            .Select(i => new
            {
                Item = i,
                Score = IngredientNormaliser.Normalise(i.Name)
                    .Split(' ', StringSplitOptions.RemoveEmptyEntries)
                    .Count(words.Contains),
            })
            .Where(x => x.Score > 0)
            .OrderByDescending(x => x.Score)
            .ThenBy(x => x.Item.Name, StringComparer.OrdinalIgnoreCase)
            .Take(Math.Clamp(take, 1, 20))
            .Select(x => x.Item)
            .ToList();
    }
}
