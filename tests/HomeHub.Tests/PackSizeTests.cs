namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Meals;
using HomeHub.Api.Data;
using HomeHub.Api.Pantry;
using Microsoft.Extensions.DependencyInjection;

/// <summary>
/// Pack size, said in the direction people speak (KITCHEN_LOOP_ADDENDUM §2, panel `1d`).
/// </summary>
/// <remarks>
/// The mapping earns its place by unblocking something. A recipe asking for grams and a shelf
/// holding tins cannot be compared at all until somebody says how much is in a tin — and the whole
/// point of §2 is that they say it as "a tin is 400 g", never as a conversion factor.
/// </remarks>
public class PackSizeTests
{
    private static async Task<PantryItemDto> ShelfAsync(
        HttpClient client, string name, decimal quantity, string unit) =>
        (await (await client.PostAsJsonAsync("/api/pantry", new PantryItemInput(
            name, "Cupboard", "Counted", quantity, unit, null, ProfileId: 1)))
            .Content.ReadFromJsonAsync<PantryItemDto>())!;

    private static async Task<RecipeDto> RecipeAsync(
        HttpClient client, string ingredient, decimal quantity, string unit) =>
        (await (await client.PostAsJsonAsync("/api/recipes", new RecipeInput(
            "Ragu",
            Servings: 4,
            Ingredients: [new RecipeIngredientInput($"{quantity} {unit} {ingredient}", quantity, unit, ingredient)])))
            .Content.ReadFromJsonAsync<RecipeDto>())!;

    private static Task<HttpResponseMessage> SetPackAsync(
        HttpClient client, int itemId, decimal? size, string? unit, int? recipeId = null) =>
        client.PostAsJsonAsync(
            $"/api/pantry/{itemId}/pack-size{(recipeId is null ? "" : $"?recipeId={recipeId}")}",
            new PackSizeInput(size, unit, ProfileId: 1));

    /// <summary>
    /// Before the mapping the check cannot say; after it, it can. That is the whole feature.
    /// </summary>
    [Fact]
    public async Task A_pack_size_turns_cannot_say_into_an_answer()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var tins = await ShelfAsync(client, "chopped tomatoes", quantity: 3, unit: "tins");
        var recipe = await RecipeAsync(client, "chopped tomatoes", 800, "g");

        var before = await client.GetFromJsonAsync<StockCheckDto>($"/api/pantry/check?recipeId={recipe.Id}");
        Assert.Equal(nameof(StockStatus.Unknown), before!.Lines.Single().Status);

        var res = await SetPackAsync(client, tins.Id, 400, "g", recipe.Id);
        var result = await res.Content.ReadFromJsonAsync<PackSizeResultDto>();

        // Three tins of 400 g is 1200 g, and the recipe wants 800.
        Assert.Equal(nameof(StockStatus.Fine), result!.Recheck!.Lines.Single().Status);
    }

    /// <summary>
    /// §2: the mapping is re-run against what it was blocking, so the caller does not have to ask
    /// again to find out whether it helped.
    /// </summary>
    [Fact]
    public async Task Saving_a_mapping_re_runs_the_check_it_unblocked()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var tins = await ShelfAsync(client, "chopped tomatoes", quantity: 1, unit: "tins");
        var recipe = await RecipeAsync(client, "chopped tomatoes", 800, "g");

        var result = await (await SetPackAsync(client, tins.Id, 400, "g", recipe.Id))
            .Content.ReadFromJsonAsync<PackSizeResultDto>();

        // One tin is 400 g against 800 wanted — now genuinely short, where before it was unknowable.
        Assert.NotNull(result!.Recheck);
        Assert.Equal(nameof(StockStatus.Short), result.Recheck!.Lines.Single().Status);
    }

    /// <summary>
    /// §2: a size with no unit is not an amount. Storing "400" would read as a working mapping and
    /// leave the check to guess whether it meant grams or millilitres.
    /// </summary>
    [Fact]
    public async Task A_size_without_a_unit_is_refused()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var tins = await ShelfAsync(client, "chopped tomatoes", quantity: 3, unit: "tins");

        var res = await SetPackAsync(client, tins.Id, 400, null);

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    /// <summary>
    /// §2: the mapping carries provenance, because it silently changes what every recipe wanting
    /// that ingredient concludes.
    /// </summary>
    [Fact]
    public async Task The_mapping_records_who_saved_it()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var tins = await ShelfAsync(client, "chopped tomatoes", quantity: 3, unit: "tins");
        await SetPackAsync(client, tins.Id, 400, "g");

        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
        var saved = db.PantryItems.Single(i => i.Id == tins.Id);

        Assert.Equal(400m, saved.PackSize);
        Assert.Equal("g", saved.PackUnit);
        Assert.NotNull(saved.PackSizeAtUtc);
        Assert.NotNull(saved.PackSizeByProfileId);
    }

    /// <summary>Clearing the mapping puts the row back to a loose one, provenance and all.</summary>
    [Fact]
    public async Task Clearing_it_returns_the_row_to_loose()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var tins = await ShelfAsync(client, "chopped tomatoes", quantity: 3, unit: "tins");
        await SetPackAsync(client, tins.Id, 400, "g");
        await SetPackAsync(client, tins.Id, null, null);

        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
        var saved = db.PantryItems.Single(i => i.Id == tins.Id);

        Assert.Null(saved.PackSize);
        Assert.Null(saved.PackSizeByProfileId);
        Assert.Null(saved.PackSizeAtUtc);
    }

    /// <summary>
    /// §1 and §2 together: once a tin has a size, the plan reserves in that measure — so two nights
    /// wanting 800 g each out of three tins leaves the second one genuinely short.
    /// </summary>
    [Fact]
    public async Task Claims_settle_in_the_mapped_measure()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var tins = await ShelfAsync(client, "chopped tomatoes", quantity: 3, unit: "tins");
        var recipe = await RecipeAsync(client, "chopped tomatoes", 800, "g");
        await SetPackAsync(client, tins.Id, 400, "g");

        var monday = new DateOnly(2026, 8, 17);
        await client.PutAsJsonAsync("/api/meals/plan",
            new MealPlanInput(monday, MealSlot.Dinner, RecipeId: recipe.Id));
        await client.PutAsJsonAsync("/api/meals/plan",
            new MealPlanInput(monday.AddDays(1), MealSlot.Dinner, RecipeId: recipe.Id));

        var week = (await client.GetFromJsonAsync<MealWeekDto>($"/api/meals/week?start={monday:yyyy-MM-dd}"))!
            .Days.SelectMany(d => d.Entries).ToList();

        // 1200 g on the shelf: Monday takes 800, leaving 400 for a night that wants 800.
        Assert.Equal(nameof(PlanStockSummary.Covered), week.Single(e => e.Date == monday).StockSummary);
        Assert.Equal(nameof(PlanStockSummary.Short), week.Single(e => e.Date == monday.AddDays(1)).StockSummary);
    }
}
