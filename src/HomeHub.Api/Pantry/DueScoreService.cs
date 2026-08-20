namespace HomeHub.Api.Pantry;

using HomeHub.Api.Data;
using HomeHub.Api.Meals;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// Ranks recipes by how much of what is already open they would use up
/// (KITCHEN_LOOP_ADDENDUM §4).
/// </summary>
/// <remarks>
/// <para>
/// Grocy ranks by a Due Score over items with expiry dates, and Cooklist suggests recipes for
/// expiring items. HomeHub gets the same answer from a fact it can actually observe: how long
/// something has been open. That turns "what could I cook" into "what should I cook first" without
/// storing a single date the household would have had to guess at.
/// </para>
/// <para>
/// <b>The score is a sort, not a warning.</b> It changes the order of a list and nothing else — no
/// notification, no badge, no counter of things going off. A recipe with no open ingredients scores
/// zero, which means it is listed rather than ranked; it does not mean it is bad.
/// </para>
/// </remarks>
public sealed class DueScoreService
{
    private readonly HomeHubDbContext _db;
    private readonly TimeProvider _clock;

    public DueScoreService(HomeHubDbContext db, TimeProvider clock)
    {
        _db = db;
        _clock = clock;
    }

    /// <summary>One recipe's standing: how due it is, and what it would use up.</summary>
    public sealed record Ranked(int RecipeId, string Title, int Score, IReadOnlyList<string> Uses);

    /// <summary>
    /// Score every non-archived recipe by days-since-opened across the items it matches.
    /// </summary>
    /// <remarks>
    /// Items with no <see cref="PantryItem.OpenedAt"/> are ignored rather than scored zero — an
    /// unopened tin is not evidence about anything, and counting it would let a recipe of ten
    /// cupboard staples outrank the one that actually uses the open cream.
    /// </remarks>
    public async Task<IReadOnlyList<Ranked>> RankAsync(CancellationToken ct)
    {
        var recipes = await _db.Recipes
            .Where(r => !r.IsArchived)
            .Include(r => r.Ingredients)
            .ToListAsync(ct);

        var matcher = await PantryMatcher.LoadAsync(_db, ct);
        var today = DateOnly.FromDateTime(_clock.GetUtcNow().UtcDateTime);

        var ranked = new List<Ranked>();
        foreach (var recipe in recipes)
        {
            var score = 0;
            var uses = new List<string>();

            foreach (var ingredient in recipe.Ingredients)
            {
                var item = matcher.Match(ingredient);
                if (item?.OpenedAt is not { } opened) continue;

                var days = today.DayNumber - DateOnly.FromDateTime(opened).DayNumber;
                if (days < 0) continue;

                // Days open, plus one for being open at all.
                //
                // §4 states the score as days-since-opened, which on its own gives a jar opened this
                // morning a score of zero — indistinguishable from a recipe that uses nothing open,
                // and so filtered out of the very band it belongs at the top of. The +1 keeps the
                // ordering the spec asks for (longer open ranks higher) while letting "uses
                // something open" outrank "uses nothing open", which is what the band is for.
                score += days + 1;
                uses.Add(item.Name);
            }

            ranked.Add(new Ranked(recipe.Id, recipe.Title, score, uses));
        }

        // Highest score first; ties by title so the order is stable between requests rather than
        // shuffling under the reader on a screen that polls.
        return ranked
            .OrderByDescending(r => r.Score)
            .ThenBy(r => r.Title, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }
}
