namespace HomeHub.Tests;

using System.Net.Http.Json;
using HomeHub.Api.Meals;
using HomeHub.Api.Pantry;

/// <summary>
/// The plan reserves stock (KITCHEN_LOOP_ADDENDUM §1).
/// </summary>
/// <remarks>
/// The defect being fixed is documented in Grocy's own issue tracker and reproduced in
/// <c>KITCHEN_MARKET_STUDY.md</c> §3: with no reservation, two planned nights each believe they can
/// consume the same single tin, both read as covered, and the shopping list under-buys. Every test
/// here is one of the rules §1 states, so a regression names the rule it broke.
/// </remarks>
public class PlanClaimTests
{
    private static readonly DateOnly Monday = new(2026, 8, 17);

    private static async Task<PantryItemDto> ShelfAsync(
        HttpClient client, string name, decimal? quantity, string? unit,
        string tracking = "Counted", string? estimate = null) =>
        (await (await client.PostAsJsonAsync("/api/pantry", new PantryItemInput(
            name, "Cupboard", tracking, quantity, unit, estimate, ProfileId: 1)))
            .Content.ReadFromJsonAsync<PantryItemDto>())!;

    /// <summary>A recipe for four, asking for one line.</summary>
    private static async Task<RecipeDto> RecipeAsync(
        HttpClient client, string title, string ingredient, decimal quantity, string? unit) =>
        (await (await client.PostAsJsonAsync("/api/recipes", new RecipeInput(
            title,
            Servings: 4,
            Ingredients: [new RecipeIngredientInput(
                $"{quantity} {unit} {ingredient}".Trim(), quantity, unit, ingredient)])))
            .Content.ReadFromJsonAsync<RecipeDto>())!;

    private static Task<HttpResponseMessage> PlanAsync(
        HttpClient client, DateOnly date, int recipeId, int? servings = null,
        MealSlot slot = MealSlot.Dinner) =>
        client.PutAsJsonAsync("/api/meals/plan",
            new MealPlanInput(date, slot, RecipeId: recipeId, ServingsOverride: servings));

    private static async Task<List<MealPlanEntryDto>> WeekAsync(HttpClient client, DateOnly start) =>
        (await client.GetFromJsonAsync<MealWeekDto>($"/api/meals/week?start={start:yyyy-MM-dd}"))!
            .Days.SelectMany(d => d.Entries).ToList();

    /// <summary>
    /// §1's headline: one tin, two nights that want it, and the <i>earlier</i> night gets it.
    /// </summary>
    /// <remarks>
    /// Without claims both nights read Covered — which is precisely the under-buy the addendum was
    /// written to stop.
    /// </remarks>
    [Fact]
    public async Task Two_nights_cannot_both_claim_the_same_tin()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await ShelfAsync(client, "chopped tomatoes", quantity: 1, unit: "tins");
        var recipe = await RecipeAsync(client, "Ragu", "chopped tomatoes", 1, "tins");

        await PlanAsync(client, Monday, recipe.Id);
        await PlanAsync(client, Monday.AddDays(1), recipe.Id);

        var week = await WeekAsync(client, Monday);
        var monday = week.Single(e => e.Date == Monday);
        var tuesday = week.Single(e => e.Date == Monday.AddDays(1));

        Assert.Equal(nameof(PlanStockSummary.Covered), monday.StockSummary);
        Assert.Equal(nameof(PlanStockSummary.Short), tuesday.StockSummary);
    }

    /// <summary>
    /// §1: claims settle in cooking order — date, then slot. Lunch eats before dinner does, so
    /// lunch is the night that gets the last of it.
    /// </summary>
    [Fact]
    public async Task The_earlier_slot_on_a_day_claims_first()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await ShelfAsync(client, "eggs", quantity: 2, unit: "ea");
        var recipe = await RecipeAsync(client, "Omelette", "eggs", 2, "ea");

        // Planned dinner first, so insertion order is the opposite of cooking order — which is what
        // makes this a test of the sort rather than of the sequence of writes.
        await PlanAsync(client, Monday, recipe.Id, slot: MealSlot.Dinner);
        await PlanAsync(client, Monday, recipe.Id, slot: MealSlot.Lunch);

        var week = await WeekAsync(client, Monday);

        Assert.Equal(nameof(PlanStockSummary.Covered),
            week.Single(e => e.Slot == nameof(MealSlot.Lunch)).StockSummary);
        Assert.Equal(nameof(PlanStockSummary.Short),
            week.Single(e => e.Slot == nameof(MealSlot.Dinner)).StockSummary);
    }

    /// <summary>
    /// §1: an <c>Estimated</c> item is claimed without a quantity — first claimant covered, later
    /// ones unknown, <b>never short</b>.
    /// </summary>
    /// <remarks>
    /// PLAN_WEEK §2 states the rule the other way round and just as firmly: "an `about` item can
    /// never read as short". The panel does not know how much is in the jar, so it must not claim
    /// that two nights will run it out.
    /// </remarks>
    [Fact]
    public async Task An_estimated_item_is_never_short_only_unknown()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await ShelfAsync(client, "capers", quantity: null, unit: "jar",
            tracking: "Estimated", estimate: "Plenty");
        var recipe = await RecipeAsync(client, "Piccata", "capers", 2, "tbsp");

        await PlanAsync(client, Monday, recipe.Id);
        await PlanAsync(client, Monday.AddDays(1), recipe.Id);

        var week = await WeekAsync(client, Monday);

        Assert.Equal(nameof(PlanStockSummary.Covered),
            week.Single(e => e.Date == Monday).StockSummary);
        Assert.Equal(nameof(PlanStockSummary.Unknown),
            week.Single(e => e.Date == Monday.AddDays(1)).StockSummary);
    }

    /// <summary>§1: <c>NotCounted</c> is never claimed, so a staple never makes a night short.</summary>
    [Fact]
    public async Task A_staple_is_never_claimed()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await ShelfAsync(client, "salt", quantity: null, unit: null, tracking: "NotCounted");
        var recipe = await RecipeAsync(client, "Anything", "salt", 1, "tsp");

        await PlanAsync(client, Monday, recipe.Id);
        await PlanAsync(client, Monday.AddDays(1), recipe.Id);

        var week = await WeekAsync(client, Monday);

        Assert.All(week, e => Assert.Equal(nameof(PlanStockSummary.Covered), e.StockSummary));
    }

    /// <summary>
    /// §1: a night that is not cooking claims nothing. <c>Out — Rosa's</c> is a plan, not a gap
    /// (PLAN_WEEK §1), and it must not reserve anything on its way past.
    /// </summary>
    [Fact]
    public async Task A_night_out_claims_nothing()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await ShelfAsync(client, "chopped tomatoes", quantity: 1, unit: "tins");
        var recipe = await RecipeAsync(client, "Ragu", "chopped tomatoes", 1, "tins");

        await client.PutAsJsonAsync("/api/meals/plan",
            new MealPlanInput(Monday, MealSlot.Dinner, FreeText: "Out — Rosa's"));
        await PlanAsync(client, Monday.AddDays(1), recipe.Id);

        var week = await WeekAsync(client, Monday);

        Assert.Equal(nameof(PlanStockSummary.NoClaim),
            week.Single(e => e.Date == Monday).StockSummary);
        // Tuesday still gets the tin: Monday reserved nothing on its way past.
        Assert.Equal(nameof(PlanStockSummary.Covered),
            week.Single(e => e.Date == Monday.AddDays(1)).StockSummary);
    }

    /// <summary>
    /// §3: servings live on the night and <b>drive the arithmetic</b>, not just the label. Cooking
    /// for eight from a recipe for four wants twice as much, and the claim has to say so.
    /// </summary>
    [Fact]
    public async Task Servings_on_the_night_scale_what_it_claims()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await ShelfAsync(client, "chopped tomatoes", quantity: 3, unit: "tins");
        var recipe = await RecipeAsync(client, "Ragu", "chopped tomatoes", 2, "tins");

        // For 4 it wants 2 tins and Tuesday would still have one. For 8 it wants 4 — more than the
        // shelf holds — so Monday itself is short before Tuesday is even considered.
        await PlanAsync(client, Monday, recipe.Id, servings: 8);
        await PlanAsync(client, Monday.AddDays(1), recipe.Id);

        var week = await WeekAsync(client, Monday);

        Assert.Equal(nameof(PlanStockSummary.Short),
            week.Single(e => e.Date == Monday).StockSummary);
        Assert.Equal(nameof(PlanStockSummary.Short),
            week.Single(e => e.Date == Monday.AddDays(1)).StockSummary);
    }

    /// <summary>
    /// §1: <b>nothing is deducted at claim time.</b> A claim is a note; the shelves are untouched
    /// until someone says they ate it.
    /// </summary>
    [Fact]
    public async Task Claiming_deducts_nothing()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var tin = await ShelfAsync(client, "chopped tomatoes", quantity: 3, unit: "tins");
        var recipe = await RecipeAsync(client, "Ragu", "chopped tomatoes", 2, "tins");

        await PlanAsync(client, Monday, recipe.Id);
        await WeekAsync(client, Monday);

        var after = (await client.GetFromJsonAsync<PantryListDto>("/api/pantry"))!
            .Items.Single(i => i.Id == tin.Id);

        Assert.Equal(3m, after.Quantity);
    }

    /// <summary>
    /// §1: the check reads a line that is present but spoken for as <c>ClaimedAway</c>, naming the
    /// night that has it — not as <c>Short</c>.
    /// </summary>
    /// <remarks>
    /// The distinction is the point. "You have none" and "you have one and Saturday is having it"
    /// call for different answers, and one word for both hides the fact that tells you which.
    /// </remarks>
    [Fact]
    public async Task A_spoken_for_line_reads_claimed_away_and_names_the_night()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await ShelfAsync(client, "chopped tomatoes", quantity: 1, unit: "tins");
        var recipe = await RecipeAsync(client, "Ragu", "chopped tomatoes", 1, "tins");

        await PlanAsync(client, Monday, recipe.Id);
        await PlanAsync(client, Monday.AddDays(1), recipe.Id);

        var week = await WeekAsync(client, Monday);
        var mondayId = week.Single(e => e.Date == Monday).Id;
        var tuesdayId = week.Single(e => e.Date == Monday.AddDays(1)).Id;

        var check = await client.GetFromJsonAsync<StockCheckDto>(
            $"/api/pantry/check?recipeId={recipe.Id}&planEntryId={tuesdayId}");

        var line = Assert.Single(check!.Lines);
        Assert.Equal(nameof(StockStatus.ClaimedAway), line.Status);
        Assert.Equal(mondayId, line.ClaimedByEntryId);
        Assert.Equal(1m, line.ClaimedQuantity);
    }

    /// <summary>
    /// §1: "moving a night re-sorts every claim in the week". Push the earlier night later and the
    /// hold moves with it, rather than staying where it was first settled.
    /// </summary>
    [Fact]
    public async Task Moving_a_night_re_sorts_the_claims()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await ShelfAsync(client, "chopped tomatoes", quantity: 1, unit: "tins");
        var recipe = await RecipeAsync(client, "Ragu", "chopped tomatoes", 1, "tins");

        await PlanAsync(client, Monday, recipe.Id);
        await PlanAsync(client, Monday.AddDays(2), recipe.Id);

        // Wednesday now cooks first.
        await client.DeleteAsync($"/api/meals/plan?date={Monday:yyyy-MM-dd}&slot={MealSlot.Dinner}");
        await PlanAsync(client, Monday.AddDays(3), recipe.Id);

        var week = await WeekAsync(client, Monday);

        Assert.Equal(nameof(PlanStockSummary.Covered),
            week.Single(e => e.Date == Monday.AddDays(2)).StockSummary);
        Assert.Equal(nameof(PlanStockSummary.Short),
            week.Single(e => e.Date == Monday.AddDays(3)).StockSummary);
    }

    /// <summary>
    /// PANTRY_SHELVES §2: the item sheet knows it is spoken for, and names the night.
    /// </summary>
    /// <remarks>
    /// This is what stops the household counting the same tin twice across two screens — the shelf
    /// says three, and the row says one of them is Saturday's.
    /// </remarks>
    [Fact]
    public async Task An_item_knows_which_nights_have_spoken_for_it()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var tin = await ShelfAsync(client, "chopped tomatoes", quantity: 3, unit: "tins");
        var recipe = await RecipeAsync(client, "Ragu", "chopped tomatoes", 1, "tins");

        // Dated forward from the real today rather than from the class's fixed Monday: this test is
        // about the still-to-be-cooked window, so it has to sit inside it whenever it is run.
        var soon = DateOnly.FromDateTime(DateTime.UtcNow).AddDays(1);
        await PlanAsync(client, soon, recipe.Id);
        await PlanAsync(client, soon.AddDays(1), recipe.Id);

        var claims = await client.GetFromJsonAsync<List<ItemClaimDto>>($"/api/pantry/{tin.Id}/claims");

        Assert.Equal(2, claims!.Count);
        Assert.Equal(soon, claims[0].Date);
        Assert.Equal("Ragu", claims[0].DishName);
        Assert.Equal(1m, claims[0].Quantity);
    }

    /// <summary>
    /// A night older than the settler's own lookback stops holding anything: past that the walk no
    /// longer re-settles it, so what is left in the table is residue rather than a reservation.
    /// </summary>
    [Fact]
    public async Task A_night_beyond_the_lookback_no_longer_holds_a_claim_on_the_sheet()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var tin = await ShelfAsync(client, "chopped tomatoes", quantity: 3, unit: "tins");
        var recipe = await RecipeAsync(client, "Ragu", "chopped tomatoes", 1, "tins");

        // Well in the past relative to any real "today".
        await PlanAsync(client, new DateOnly(2020, 1, 6), recipe.Id);

        var claims = await client.GetFromJsonAsync<List<ItemClaimDto>>($"/api/pantry/{tin.Id}/claims");

        Assert.Empty(claims!);
    }

    /// <summary>
    /// A night that passed without anybody answering is <b>still holding its tin</b>.
    /// </summary>
    /// <remarks>
    /// The sheet used to hide these on the date alone, which reads as stock being free when it is
    /// not: nothing has come off the shelf, because deduction waits on somebody saying they ate it.
    /// </remarks>
    [Fact]
    public async Task A_night_that_passed_unanswered_is_still_holding_its_tin()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var tin = await ShelfAsync(client, "chopped tomatoes", quantity: 3, unit: "tins");
        var recipe = await RecipeAsync(client, "Ragu", "chopped tomatoes", 1, "tins");

        var yesterday = DateOnly.FromDateTime(DateTime.UtcNow).AddDays(-1);
        await PlanAsync(client, yesterday, recipe.Id);

        var claims = await client.GetFromJsonAsync<List<ItemClaimDto>>($"/api/pantry/{tin.Id}/claims");

        Assert.Single(claims!);
        Assert.Equal(yesterday, claims![0].Date);
    }

    /// <summary>
    /// <b>A cooked night claims nothing.</b> Its ingredients are already off the shelf, so holding a
    /// claim as well would reserve stock that is provably gone — and every later night inside the
    /// lookback would read short by twice the amount.
    /// </summary>
    [Fact]
    public async Task A_night_already_eaten_stops_claiming()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var tin = await ShelfAsync(client, "chopped tomatoes", quantity: 2, unit: "tins");
        var recipe = await RecipeAsync(client, "Ragu", "chopped tomatoes", 1, "tins");

        var yesterday = DateOnly.FromDateTime(DateTime.UtcNow).AddDays(-1);
        var tomorrow = DateOnly.FromDateTime(DateTime.UtcNow).AddDays(1);
        await PlanAsync(client, yesterday, recipe.Id);
        await PlanAsync(client, tomorrow, recipe.Id);

        // Yesterday happened, so its tin came off the shelf through the ledger.
        var lastNight = (await WeekAsync(client, yesterday)).Single(e => e.Date == yesterday);
        await client.PutAsJsonAsync("/api/meals/plan/eaten",
            new MealEatenInput(yesterday, MealSlot.Dinner, true, null));
        await client.PostAsync($"/api/pantry/deduct?planEntryId={lastNight.Id}", null);

        // Re-settle, which is what any later plan write would do.
        await PlanAsync(client, tomorrow, recipe.Id);

        var claims = await client.GetFromJsonAsync<List<ItemClaimDto>>($"/api/pantry/{tin.Id}/claims");

        Assert.Single(claims!);
        Assert.Equal(tomorrow, claims![0].Date);
    }

    /// <summary>
    /// The same rule from the week's side: an eaten night carries no verdict to argue with, because
    /// it is no longer a question about stock.
    /// </summary>
    [Fact]
    public async Task An_eaten_night_reads_as_no_claim()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await ShelfAsync(client, "chopped tomatoes", quantity: 1, unit: "tins");
        var recipe = await RecipeAsync(client, "Ragu", "chopped tomatoes", 1, "tins");

        await PlanAsync(client, Monday, recipe.Id);
        await PlanAsync(client, Monday.AddDays(1), recipe.Id);

        await client.PutAsJsonAsync("/api/meals/plan/eaten",
            new MealEatenInput(Monday, MealSlot.Dinner, true, null));

        var week = await WeekAsync(client, Monday);

        Assert.Equal(
            nameof(PlanStockSummary.NoClaim),
            week.Single(e => e.Date == Monday).StockSummary);
        // And Tuesday inherits the tin Monday is no longer holding.
        Assert.Equal(
            nameof(PlanStockSummary.Covered),
            week.Single(e => e.Date == Monday.AddDays(1)).StockSummary);
    }
}
