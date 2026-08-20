namespace HomeHub.Api.Pantry;

using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// Which recipes the household could cook right now (RECIPES §1).
/// </summary>
/// <remarks>
/// <para>
/// The folder is divided by <b>cookability, not by cuisine</b>, because that is the question people
/// arrive with. Alphabetical or by-cuisine folders both make the reader do the sorting.
/// </para>
/// <para>
/// The honest third state is the one that matters. A recipe whose lines never matched anything sits
/// in <c>EVERYTHING ELSE</c> reading <c>can't say</c> — <b>never</b> in the ready band. A false
/// "ready" at seven in the evening costs the household's trust; an admitted gap costs a minute
/// (MATCHING_AND_ALIASES §1).
/// </para>
/// <para>
/// Batched deliberately: one matcher and one pass over the shelves for the whole folder. Running the
/// per-night stock check once per recipe would be a query per row on a screen that lists dozens.
/// </para>
/// </remarks>
public sealed class CookabilityService
{
    private readonly HomeHubDbContext _db;

    public CookabilityService(HomeHubDbContext db) => _db = db;

    /// <summary>Which band a recipe belongs in, and why.</summary>
    public enum Band
    {
        /// <summary>Nothing missing. `COOK IT TONIGHT`.</summary>
        Ready = 0,

        /// <summary>Something is genuinely short — a countable gap the household could go and fix.</summary>
        Short = 1,

        /// <summary>At least one line cannot be resolved at all. Listed, never ranked as ready.</summary>
        CantSay = 2,
    }

    public sealed record RecipeStanding(
        int RecipeId,
        Band Band,
        /// <summary>How many lines are short. Zero on a `CantSay` recipe — it is not a shortfall count.</summary>
        int ShortCount,
        /// <summary>How many lines nothing on the shelves answers to.</summary>
        int UnmatchedCount);

    /// <summary>Stand every non-archived recipe against the shelves, in one pass.</summary>
    public async Task<IReadOnlyList<RecipeStanding>> StandingAsync(CancellationToken ct)
    {
        var recipes = await _db.Recipes
            .Where(r => !r.IsArchived)
            .Include(r => r.Ingredients)
            .ToListAsync(ct);

        var matcher = await PantryMatcher.LoadAsync(_db, ct);
        var standings = new List<RecipeStanding>(recipes.Count);

        foreach (var recipe in recipes)
        {
            var shortCount = 0;
            var unmatched = 0;

            foreach (var ingredient in recipe.Ingredients)
            {
                var item = matcher.Match(ingredient);
                if (item is null) { unmatched++; continue; }

                // A staple is never a problem and never listed as one.
                if (item.Tracking == TrackingClass.NotCounted) continue;

                var verdict = StockCheckService.Verdict(item, ingredient, factor: 1m);
                switch (verdict)
                {
                    case StockStatus.Short:
                    case StockStatus.Gone:
                        shortCount++;
                        break;
                    case StockStatus.Unknown:
                        // Matched, but the amounts cannot be compared. Not short — the panel does
                        // not know — so it counts toward the same honest silence as no match at all.
                        unmatched++;
                        break;
                }
            }

            // Unmatched outranks short: a recipe the panel cannot fully read must not be presented
            // as one that merely needs a shop, because the household would act on a wrong list.
            var band = unmatched > 0 ? Band.CantSay
                : shortCount > 0 ? Band.Short
                : Band.Ready;

            standings.Add(new RecipeStanding(recipe.Id, band, shortCount, unmatched));
        }

        return standings;
    }
}
