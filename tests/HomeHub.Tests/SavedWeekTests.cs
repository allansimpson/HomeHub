namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Meals;
using HomeHub.Api.Pantry;

/// <summary>
/// Weeks the household saved to use again (KITCHEN_LOOP_ADDENDUM §6).
/// </summary>
/// <remarks>
/// The market study calls this table stakes and says it is "what makes a planner survive month
/// three". The rules that matter are what it does <i>not</i> do: it writes plan entries, and it
/// touches no stock.
/// </remarks>
public class SavedWeekTests
{
    private static readonly DateOnly Monday = new(2026, 8, 17);

    private static async Task<RecipeDto> RecipeAsync(HttpClient client, string title) =>
        (await (await client.PostAsJsonAsync("/api/recipes", new RecipeInput(title, Servings: 4)))
            .Content.ReadFromJsonAsync<RecipeDto>())!;

    private static Task<HttpResponseMessage> PlanAsync(
        HttpClient client, DateOnly date, int recipeId, int? servings = null) =>
        client.PutAsJsonAsync("/api/meals/plan",
            new MealPlanInput(date, MealSlot.Dinner, RecipeId: recipeId, ServingsOverride: servings));

    private static async Task<MealPlanTemplateDto> SaveAsync(HttpClient client, string name, DateOnly start) =>
        (await (await client.PostAsJsonAsync("/api/meals/templates", new SaveWeekInput(name, start)))
            .Content.ReadFromJsonAsync<MealPlanTemplateDto>())!;

    private static async Task<List<MealPlanEntryDto>> WeekAsync(HttpClient client, DateOnly start) =>
        (await client.GetFromJsonAsync<MealWeekDto>($"/api/meals/week?start={start:yyyy-MM-dd}"))!
            .Days.SelectMany(d => d.Entries).ToList();

    /// <summary>§6: a saved week keeps its shape and can be applied to another week.</summary>
    [Fact]
    public async Task A_saved_week_lands_the_same_shape_on_another_week()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var ragu = await RecipeAsync(client, "Ragu");
        var dal = await RecipeAsync(client, "Dal");
        await PlanAsync(client, Monday, ragu.Id);
        await PlanAsync(client, Monday.AddDays(2), dal.Id);

        var saved = await SaveAsync(client, "Usual week", Monday);
        Assert.Equal(2, saved.NightCount);

        var next = Monday.AddDays(7);
        await client.PostAsync($"/api/meals/templates/{saved.Id}/apply?start={next:yyyy-MM-dd}", null);

        var week = await WeekAsync(client, next);
        Assert.Equal("Ragu", week.Single(e => e.Date == next).RecipeTitle);
        Assert.Equal("Dal", week.Single(e => e.Date == next.AddDays(2)).RecipeTitle);
    }

    /// <summary>Offsets, not dates — otherwise a saved week would be usable exactly once.</summary>
    [Fact]
    public async Task Applying_it_twice_lands_it_on_both_weeks()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var ragu = await RecipeAsync(client, "Ragu");
        await PlanAsync(client, Monday, ragu.Id);
        var saved = await SaveAsync(client, "Usual week", Monday);

        await client.PostAsync($"/api/meals/templates/{saved.Id}/apply?start={Monday.AddDays(7):yyyy-MM-dd}", null);
        await client.PostAsync($"/api/meals/templates/{saved.Id}/apply?start={Monday.AddDays(14):yyyy-MM-dd}", null);

        Assert.Single(await WeekAsync(client, Monday.AddDays(7)));
        Assert.Single(await WeekAsync(client, Monday.AddDays(14)));
    }

    /// <summary>§6: servings travel with the night — they are part of the week's shape.</summary>
    [Fact]
    public async Task Servings_travel_with_the_saved_night()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var ragu = await RecipeAsync(client, "Ragu");
        await PlanAsync(client, Monday, ragu.Id, servings: 8);
        var saved = await SaveAsync(client, "Big week", Monday);

        var next = Monday.AddDays(7);
        await client.PostAsync($"/api/meals/templates/{saved.Id}/apply?start={next:yyyy-MM-dd}", null);

        Assert.Equal(8, (await WeekAsync(client, next)).Single().ServingsOverride);
    }

    /// <summary>
    /// §6: applying <b>never touches stock</b>. It is a shortcut for the picking, not a claim about
    /// what was cooked.
    /// </summary>
    [Fact]
    public async Task Applying_a_saved_week_touches_no_stock()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var tin = (await (await client.PostAsJsonAsync("/api/pantry", new PantryItemInput(
            "chopped tomatoes", "Cupboard", "Counted", 3, "tins", null, ProfileId: 1)))
            .Content.ReadFromJsonAsync<PantryItemDto>())!;

        var ragu = await RecipeAsync(client, "Ragu");
        await PlanAsync(client, Monday, ragu.Id);
        var saved = await SaveAsync(client, "Usual week", Monday);

        await client.PostAsync($"/api/meals/templates/{saved.Id}/apply?start={Monday.AddDays(7):yyyy-MM-dd}", null);

        var after = (await client.GetFromJsonAsync<PantryListDto>("/api/pantry"))!
            .Items.Single(i => i.Id == tin.Id);
        Assert.Equal(3m, after.Quantity);
    }

    /// <summary>
    /// A night whose recipe was later deleted is skipped and counted, not failed — a saved week
    /// should not stop working because one dish was archived.
    /// </summary>
    [Fact]
    public async Task A_deleted_recipe_is_skipped_rather_than_failing_the_week()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var ragu = await RecipeAsync(client, "Ragu");
        var dal = await RecipeAsync(client, "Dal");
        await PlanAsync(client, Monday, ragu.Id);
        await PlanAsync(client, Monday.AddDays(1), dal.Id);
        var saved = await SaveAsync(client, "Usual week", Monday);

        await client.DeleteAsync($"/api/recipes/{dal.Id}");

        var next = Monday.AddDays(7);
        var result = await (await client.PostAsync(
            $"/api/meals/templates/{saved.Id}/apply?start={next:yyyy-MM-dd}", null))
            .Content.ReadFromJsonAsync<ApplyTemplateResultDto>();

        Assert.Equal(1, result!.Written);
        Assert.Equal(1, result.Skipped);
        Assert.Equal("Ragu", (await WeekAsync(client, next)).Single().RecipeTitle);
    }

    /// <summary>Saving an empty week is refused — there is no shape to keep.</summary>
    [Fact]
    public async Task An_empty_week_cannot_be_saved()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/meals/templates",
            new SaveWeekInput("Nothing", Monday));

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    /// <summary>
    /// §6 and §1 together: applying re-settles claims, so the applied week's nights carry their
    /// stock verdict straight away rather than after the next write.
    /// </summary>
    [Fact]
    public async Task Applying_re_settles_the_claims()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        // Three tins: the original week's two nights take one each, leaving exactly one for the
        // applied week — so the applied Monday is covered and the applied Tuesday is not. Settling
        // across the whole horizon rather than the requested week is what makes that visible.
        await client.PostAsJsonAsync("/api/pantry", new PantryItemInput(
            "chopped tomatoes", "Cupboard", "Counted", 3, "tins", null, ProfileId: 1));

        var ragu = (await (await client.PostAsJsonAsync("/api/recipes", new RecipeInput(
            "Ragu",
            Servings: 4,
            Ingredients: [new RecipeIngredientInput("1 tins chopped tomatoes", 1, "tins", "chopped tomatoes")])))
            .Content.ReadFromJsonAsync<RecipeDto>())!;

        await PlanAsync(client, Monday, ragu.Id);
        await PlanAsync(client, Monday.AddDays(1), ragu.Id);
        var saved = await SaveAsync(client, "Two nights", Monday);

        var next = Monday.AddDays(7);
        await client.PostAsync($"/api/meals/templates/{saved.Id}/apply?start={next:yyyy-MM-dd}", null);

        var week = await WeekAsync(client, next);
        Assert.Equal(nameof(PlanStockSummary.Covered), week.Single(e => e.Date == next).StockSummary);
        Assert.Equal(nameof(PlanStockSummary.Short), week.Single(e => e.Date == next.AddDays(1)).StockSummary);
    }
}
