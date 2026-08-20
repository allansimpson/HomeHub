namespace HomeHub.Api.Pantry;

using HomeHub.Api.Data;
using HomeHub.Api.Meals;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// A planned night's hold on a pantry item — what Saturday's ragù has already spoken for by the
/// time Sunday goes looking (KITCHEN_LOOP_ADDENDUM §1).
/// </summary>
/// <remarks>
/// <para>
/// <b>Derived, never authored.</b> No user action writes a claim; the whole set for a horizon is
/// recomputed by <see cref="PlanClaimService"/> whenever the week, a recipe's ingredients or a
/// night's servings change. <see cref="SettledAtUtc"/> records when that recompute ran, not when
/// anybody decided anything.
/// </para>
/// <para>
/// The defect this exists to fix is documented in Grocy's own issue tracker and was reproduced in
/// the market study: a plan that makes no reservation lets two planned nights each believe they can
/// consume the same single tin, so both read as covered and the shopping list under-buys by one.
/// Claims settle in <b>cooking order</b> — date, then slot, then position — so the earlier night
/// takes what it needs and the later one is honestly short.
/// </para>
/// <para>
/// <b>A claim is a note, not a lock.</b> Nothing is deducted here; deduction stays where it is, on
/// <c>wasEaten</c> flipping true (COOKING_AND_AFTER). Moving a night simply re-sorts every claim in
/// the week, and a claim never prevents cooking, assigning or shopping.
/// </para>
/// </remarks>
public class PlanClaim
{
    public int Id { get; set; }

    /// <summary>The night doing the claiming.</summary>
    public int PlanEntryId { get; set; }

    /// <summary>The shelf item spoken for.</summary>
    public int PantryItemId { get; set; }

    /// <summary>
    /// How much, in the item's own measure unit. <b>Null for an <see cref="TrackingClass.Estimated"/>
    /// item</b>, which is claimed without a number because there is no honest number to claim — the
    /// first claimant reads as fine and later ones as unknown, never short.
    /// </summary>
    public decimal? Quantity { get; set; }

    /// <summary>The unit <see cref="Quantity"/> is expressed in, mirroring the item's measure unit.</summary>
    public string? Unit { get; set; }

    /// <summary>When the settle that produced this claim ran. Recomputed, not authored.</summary>
    public DateTime SettledAtUtc { get; set; }
}

/// <summary>
/// One night's verdict for the week screen — the single word every planned row carries
/// (PLAN_WEEK §1).
/// </summary>
/// <remarks>
/// Exists so the week can answer "can we actually cook this?" without running a stock check per
/// night, which is seven round trips for a screen that opens constantly (§1).
/// </remarks>
public enum PlanStockSummary
{
    /// <summary>Nothing to reserve — free text, takeaway, or a night marked as out.</summary>
    NoClaim = 0,

    /// <summary>Everything the night needs is on a shelf and unspoken-for. Renders <c>ALL IN</c>.</summary>
    Covered = 1,

    /// <summary>At least one line cannot be met from what is left after the earlier nights.</summary>
    Short = 2,

    /// <summary>Nothing short, but at least one line the panel cannot honestly compare.</summary>
    Unknown = 3,
}

/// <summary>
/// Settles what each planned night has spoken for, in cooking order.
/// </summary>
/// <remarks>
/// One walk produces both the persisted claims and the per-night summaries, deliberately: they are
/// the same arithmetic, and computing them separately is how the week's word and the night's detail
/// would start disagreeing.
/// </remarks>
public sealed class PlanClaimService
{
    private readonly HomeHubDbContext _db;
    private readonly TimeProvider _clock;

    public PlanClaimService(HomeHubDbContext db, TimeProvider clock)
    {
        _db = db;
        _clock = clock;
    }

    /// <summary>The outcome of one settle: what was claimed, and how each night reads.</summary>
    public sealed record Settlement(
        IReadOnlyList<PlanClaim> Claims,
        IReadOnlyDictionary<int, PlanStockSummary> Summaries);

    /// <summary>
    /// How far back a walk reaches before the window it was asked about.
    /// </summary>
    /// <remarks>
    /// A week's first night has to know what last week's nights already took, or the week screen
    /// would hand every Monday a full shelf. The horizon is finite because stock is replenished and
    /// an unbounded walk would re-settle the entire history of the plan to draw seven words.
    /// </remarks>
    public const int LookbackDays = 7;

    /// <summary>How far forward a write settles — comfortably past what any planner screen shows.</summary>
    private const int ForwardDays = 28;

    /// <summary>
    /// Re-settle around a night that just changed.
    /// </summary>
    /// <remarks>
    /// Called from every path that alters what is planned. A later night cannot change what an
    /// earlier one already claimed, but it can change what is left for the ones after it — so the
    /// walk starts before the change and runs forward.
    /// </remarks>
    public Task<Settlement> SettleAroundAsync(DateOnly changed, CancellationToken ct) =>
        SettleAsync(changed, changed.AddDays(ForwardDays), ct);

    /// <summary>
    /// Recompute claims across a horizon and persist them, replacing whatever was there.
    /// </summary>
    /// <remarks>
    /// Replace rather than merge: claims are a projection of the plan, so the plan is the only
    /// truth about which of them should exist. Merging would leave a claim behind when the night
    /// that made it was deleted.
    /// </remarks>
    public async Task<Settlement> SettleAsync(DateOnly from, DateOnly to, CancellationToken ct)
    {
        // One window for both the walk and the delete. If they disagreed, the lookback nights would
        // be re-claimed without their old claims being cleared and the shelf would look emptier on
        // every settle.
        var walkFrom = from.AddDays(-LookbackDays);
        var settlement = await WalkAsync(walkFrom, to, ct);

        var entryIds = await _db.MealPlanEntries
            .Where(e => e.Date >= walkFrom && e.Date <= to)
            .Select(e => e.Id)
            .ToListAsync(ct);

        var stale = await _db.PlanClaims.Where(c => entryIds.Contains(c.PlanEntryId)).ToListAsync(ct);
        _db.PlanClaims.RemoveRange(stale);
        _db.PlanClaims.AddRange(settlement.Claims);
        await _db.SaveChangesAsync(ct);

        return settlement;
    }

    /// <summary>
    /// The per-night words for a horizon, without writing anything.
    /// </summary>
    /// <remarks>
    /// The week screen is a read. It must not have a write as a side effect — a panel that settles
    /// the plan every time somebody glances at it would churn the table and make the claim
    /// timestamps meaningless.
    /// </remarks>
    public async Task<IReadOnlyDictionary<int, PlanStockSummary>> SummariseAsync(
        DateOnly from, DateOnly to, CancellationToken ct) =>
        (await WalkAsync(from.AddDays(-LookbackDays), to, ct)).Summaries;

    /// <summary>
    /// The walk itself: every planned night in cooking order, taking what it needs from what the
    /// earlier nights left.
    /// </summary>
    private async Task<Settlement> WalkAsync(DateOnly from, DateOnly to, CancellationToken ct)
    {
        var entries = await _db.MealPlanEntries
            .Where(e => e.Date >= from && e.Date <= to)
            .Include(e => e.Recipe!).ThenInclude(r => r.Ingredients)
            .ToListAsync(ct);

        // Cooking order, and it is load-bearing: it is the whole reason the earlier night wins.
        // MealSlot is declared in that order already (Breakfast, Lunch, Dinner, Other).
        entries = entries
            .OrderBy(e => e.Date)
            .ThenBy(e => (int)e.Slot)
            .ThenBy(e => e.Position)
            .ThenBy(e => e.Id)
            .ToList();

        var matcher = await PantryMatcher.LoadAsync(_db, ct);
        var now = _clock.GetUtcNow().UtcDateTime;

        // What is left of each counted item as the walk proceeds, and how many nights have already
        // laid a claim on each estimated one.
        var remaining = new Dictionary<int, decimal>();
        var estimatedClaimants = new Dictionary<int, int>();

        var claims = new List<PlanClaim>();
        var summaries = new Dictionary<int, PlanStockSummary>();

        foreach (var entry in entries)
        {
            // A night somebody has answered reserves nothing, and this is what the lookback is for.
            //
            // `yes` means the ledger has already taken those things off the shelf, so a claim as
            // well would hold stock that is provably gone and every later night would read short by
            // twice the amount. `no` means it was never cooked. Only the *unanswered* past nights
            // inside the horizon still hold what they were planned to use — which is exactly the
            // set `PantryController.Claims` shows, and the two must agree.
            if (entry.WasEaten is not null)
            {
                summaries[entry.Id] = PlanStockSummary.NoClaim;
                continue;
            }

            if (entry.Recipe is null)
            {
                // Free text, takeaway, a night out. A plan, but not one that reserves anything.
                summaries[entry.Id] = PlanStockSummary.NoClaim;
                continue;
            }

            var target = entry.ServingsOverride ?? entry.Recipe.Servings ?? 0;
            var factor = entry.Recipe.Servings is > 0 && target > 0
                ? (decimal)target / entry.Recipe.Servings.Value
                : 1m;

            var isShort = false;
            var isUnknown = false;

            foreach (var ingredient in entry.Recipe.Ingredients.OrderBy(i => i.Position))
            {
                var item = matcher.Match(ingredient);

                // Nothing on the shelves answers to this line. Listed by the check, never claimed,
                // and never quietly treated as covered.
                if (item is null) { isUnknown = true; continue; }

                // A staple. Never claimed, never a problem, never reported as one.
                if (item.Tracking == TrackingClass.NotCounted) continue;

                if (item.Tracking == TrackingClass.Estimated)
                {
                    // Claimed without a number. The first night to want it reads as covered; every
                    // later one reads unknown, because "there is a jar and two nights want it" is
                    // not evidence that either will go without.
                    var seen = estimatedClaimants.GetValueOrDefault(item.Id);
                    estimatedClaimants[item.Id] = seen + 1;

                    if (item.EstimateState == EstimateState.None) isShort = true;
                    else if (seen > 0) isUnknown = true;

                    claims.Add(new PlanClaim
                    {
                        PlanEntryId = entry.Id,
                        PantryItemId = item.Id,
                        Quantity = null,
                        Unit = null,
                        SettledAtUtc = now,
                    });
                    continue;
                }

                // Counted. Work out what this night needs in the item's own measure unit; a line the
                // parser could not read, or one whose unit will not convert, is a question rather
                // than a claim.
                if (!remaining.TryGetValue(item.Id, out var left))
                {
                    left = PantryAmounts.OnHand(item);
                    remaining[item.Id] = left;
                }

                if (ingredient.Quantity is not { } quantity) { isUnknown = true; continue; }

                var needed = UnitConversion.Convert(
                    quantity * factor, ingredient.Unit, PantryAmounts.MeasureUnit(item));
                if (needed is null) { isUnknown = true; continue; }

                var take = Math.Min(needed.Value, Math.Max(left, 0m));
                if (take < needed.Value) isShort = true;

                if (take > 0)
                {
                    remaining[item.Id] = left - take;
                    claims.Add(new PlanClaim
                    {
                        PlanEntryId = entry.Id,
                        PantryItemId = item.Id,
                        Quantity = take,
                        Unit = PantryAmounts.MeasureUnit(item),
                        SettledAtUtc = now,
                    });
                }
            }

            // Short outranks unknown: a night that is definitely missing something is not softened
            // by also having a line nobody can measure.
            summaries[entry.Id] = isShort ? PlanStockSummary.Short
                : isUnknown ? PlanStockSummary.Unknown
                : PlanStockSummary.Covered;
        }

        return new Settlement(claims, summaries);
    }
}
