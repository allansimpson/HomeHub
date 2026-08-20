namespace HomeHub.Tests;

using System.Net.Http.Json;
using HomeHub.Api.Meals;
using HomeHub.Api.Pantry;

/// <summary>
/// Opening something is observable; expiry is not (KITCHEN_LOOP_ADDENDUM §4).
/// </summary>
/// <remarks>
/// The market study found Cooklist and KitchenPal both pushing expiry alerts built on barcode
/// lookups that resolve roughly a third of products. This section ranks by the one fact it can
/// actually see — how long a thing has been open — and these tests hold it to the two rules that
/// makes bearable: nothing is inferred, and nothing warns.
/// </remarks>
public class DueScoreTests
{
    private static async Task<PantryItemDto> ShelfAsync(HttpClient client, string name) =>
        (await (await client.PostAsJsonAsync("/api/pantry", new PantryItemInput(
            name, "Fridge", "Counted", 1, "ea", null, ProfileId: 1)))
            .Content.ReadFromJsonAsync<PantryItemDto>())!;

    private static Task<HttpResponseMessage> OpenAsync(HttpClient client, int id, bool finished = false) =>
        client.PostAsync($"/api/pantry/{id}/opened{(finished ? "?finished=true" : "")}", null);

    private static async Task<RecipeDto> RecipeAsync(HttpClient client, string title, params string[] ingredients) =>
        (await (await client.PostAsJsonAsync("/api/recipes", new RecipeInput(
            title,
            Servings: 4,
            Ingredients: ingredients.Select(i => new RecipeIngredientInput($"1 {i}", 1, null, i)).ToList())))
            .Content.ReadFromJsonAsync<RecipeDto>())!;

    /// <summary>§4: opening is one tap, and it records when.</summary>
    [Fact]
    public async Task Opening_records_when_without_touching_the_count()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var item = await ShelfAsync(client, "double cream");
        var opened = await (await OpenAsync(client, item.Id)).Content.ReadFromJsonAsync<PantryItemDto>();

        Assert.NotNull(opened!.OpenedAtUtc);
        // The whole point: opening says nothing about how much there is.
        Assert.Equal(item.Quantity, opened.Quantity);
    }

    /// <summary>
    /// §4: <b>never inferred.</b> Deducting an item to nothing does not open it — the two facts are
    /// independent, and conflating them would move a date nobody set.
    /// </summary>
    [Fact]
    public async Task Cooking_does_not_open_anything_by_itself()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var item = await ShelfAsync(client, "double cream");
        var recipe = await RecipeAsync(client, "Dal", "double cream");

        var entry = await (await client.PutAsJsonAsync("/api/meals/plan",
            new MealPlanInput(new DateOnly(2026, 8, 17), MealSlot.Dinner, RecipeId: recipe.Id)))
            .Content.ReadFromJsonAsync<MealPlanEntryDto>();
        await client.PutAsJsonAsync("/api/meals/plan/eaten",
            new MealEatenInput(new DateOnly(2026, 8, 17), MealSlot.Dinner, true));
        await client.PostAsync($"/api/pantry/deduct?planEntryId={entry!.Id}", null);

        var after = (await client.GetFromJsonAsync<PantryListDto>("/api/pantry"))!
            .Items.Single(i => i.Id == item.Id);

        Assert.Null(after.OpenedAtUtc);
    }

    /// <summary>Marking it finished closes the window rather than leaving a stale date behind.</summary>
    [Fact]
    public async Task Finishing_something_closes_the_window()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var item = await ShelfAsync(client, "double cream");
        await OpenAsync(client, item.Id);
        var finished = await (await OpenAsync(client, item.Id, finished: true))
            .Content.ReadFromJsonAsync<PantryItemDto>();

        Assert.Null(finished!.OpenedAtUtc);
    }

    /// <summary>
    /// §4: a recipe that uses open things outranks one that does not.
    /// </summary>
    [Fact]
    public async Task A_recipe_that_uses_open_things_ranks_first()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var cream = await ShelfAsync(client, "double cream");
        await ShelfAsync(client, "rice");
        await OpenAsync(client, cream.Id);

        await RecipeAsync(client, "Dal", "double cream");
        await RecipeAsync(client, "Plain rice", "rice");

        var due = await client.GetFromJsonAsync<List<DueRecipeDto>>("/api/pantry/due");

        // Only the one with something open is ranked at all; the other is listed elsewhere.
        var first = Assert.Single(due!);
        Assert.Equal("Dal", first.Title);
        Assert.Contains("double cream", first.Uses);
    }

    /// <summary>
    /// §4: an unopened item is ignored rather than scored zero, so a recipe of cupboard staples
    /// cannot outrank the one using what is actually turning.
    /// </summary>
    [Fact]
    public async Task Nothing_open_means_nothing_is_ranked()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await ShelfAsync(client, "rice");
        await RecipeAsync(client, "Plain rice", "rice");

        var due = await client.GetFromJsonAsync<List<DueRecipeDto>>("/api/pantry/due");

        // An empty band, not a screen telling the household off about nothing.
        Assert.Empty(due!);
    }

    /// <summary>The score names what it would use up, so the card can say which things are turning.</summary>
    [Fact]
    public async Task The_ranking_names_what_it_would_use()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var cream = await ShelfAsync(client, "double cream");
        var spinach = await ShelfAsync(client, "spinach");
        await OpenAsync(client, cream.Id);
        await OpenAsync(client, spinach.Id);

        await RecipeAsync(client, "Dal with spinach", "double cream", "spinach");

        var due = await client.GetFromJsonAsync<List<DueRecipeDto>>("/api/pantry/due");

        Assert.Equal(["double cream", "spinach"], due!.Single().Uses.OrderBy(u => u));
    }
}
