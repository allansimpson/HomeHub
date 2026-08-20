namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Meals;
using HomeHub.Api.Pantry;

/// <summary>
/// The one path that actually moves stock, and the two ways it used to move the wrong thing.
/// </summary>
/// <remarks>
/// Deduction is where a matching mistake costs something. Everywhere else a wrong match produces a
/// wrong <i>word</i> on a screen somebody can argue with; here it takes a tin off a shelf that is
/// still there, and nothing afterwards knows it was a guess (DECISIONS PG6).
/// </remarks>
public class DeductionMatchingTests
{
    private static readonly DateOnly Monday = new(2026, 8, 17);

    private static async Task<PantryItemDto> ShelfAsync(
        HttpClient client, string name, decimal quantity, string unit) =>
        (await (await client.PostAsJsonAsync("/api/pantry", new PantryItemInput(
            name, "Cupboard", "Counted", quantity, unit, null, ProfileId: 1)))
            .Content.ReadFromJsonAsync<PantryItemDto>())!;

    private static async Task<RecipeDto> RecipeAsync(
        HttpClient client, string title, string ingredient, int servings = 4) =>
        (await (await client.PostAsJsonAsync("/api/recipes", new RecipeInput(
            title,
            Servings: servings,
            Ingredients: [new RecipeIngredientInput($"1 tins {ingredient}", 1, "tins", ingredient)])))
            .Content.ReadFromJsonAsync<RecipeDto>())!;

    private static async Task<int> PlanAsync(
        HttpClient client, DateOnly date, int recipeId, int? servings = null) =>
        (await (await client.PutAsJsonAsync("/api/meals/plan",
            new MealPlanInput(date, MealSlot.Dinner, RecipeId: recipeId, ServingsOverride: servings)))
            .Content.ReadFromJsonAsync<MealPlanEntryDto>())!.Id;

    private static Task<HttpResponseMessage> AteAsync(
        HttpClient client, DateOnly date, int? portions = null) =>
        client.PutAsJsonAsync("/api/meals/plan/eaten",
            new MealEatenInput(date, MealSlot.Dinner, true, portions));

    private static Task<HttpResponseMessage> DeductAsync(HttpClient client, int entryId) =>
        client.PostAsync($"/api/pantry/deduct?planEntryId={entryId}", null);

    /// <summary>What the shelf says now. There is no single-item GET, so this reads the list.</summary>
    private static async Task<decimal?> OnShelfAsync(HttpClient client, int itemId) =>
        (await client.GetFromJsonAsync<PantryListDto>("/api/pantry"))!
            .Items.Single(i => i.Id == itemId).Quantity;

    /// <summary>
    /// <b>A refused pairing is refused here too.</b>
    /// </summary>
    /// <remarks>
    /// The deduction path used to carry its own alias-then-name lookup, which knew nothing about
    /// <see cref="AliasRejection"/>. The household could say "that jar is not what this recipe
    /// means", watch the check and the week honour it, and still have the jar emptied the moment
    /// somebody said they ate the dish.
    /// </remarks>
    [Fact]
    public async Task A_refused_pairing_is_not_deducted()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        // The names normalise to the same thing, so this resolves by name alone — no alias to drop.
        var jar = await ShelfAsync(client, "Beef stock", quantity: 5, unit: "tins");
        var recipe = await RecipeAsync(client, "Ragu", "beef stock");

        await client.PostAsJsonAsync("/api/pantry/matching/refuse",
            new RefuseMatchInput("beef stock", jar.Id, ProfileId: 1));

        var entryId = await PlanAsync(client, Monday, recipe.Id);
        await AteAsync(client, Monday);
        var res = await DeductAsync(client, entryId);

        // Nothing was deductible, so there is no receipt at all — which is the honest outcome for a
        // night whose only line matches nothing (PANTRY_BEHAVIOURS §7).
        Assert.Equal(HttpStatusCode.NoContent, res.StatusCode);
        Assert.Equal(5m, await OnShelfAsync(client, jar.Id));
    }

    /// <summary>The other half: an ordinary taught alias still deducts, so the swap lost nothing.</summary>
    [Fact]
    public async Task A_taught_alias_still_deducts()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var tin = await ShelfAsync(client, "chopped tomatoes", quantity: 5, unit: "tins");
        var recipe = await RecipeAsync(client, "Ragu", "tinned tomatoes");

        await client.PostAsJsonAsync("/api/pantry/matching/teach",
            new TeachMatchInput("tinned tomatoes", tin.Id, ProfileId: 1));

        var entryId = await PlanAsync(client, Monday, recipe.Id);
        await AteAsync(client, Monday);
        await DeductAsync(client, entryId);

        Assert.Equal(4m, await OnShelfAsync(client, tin.Id));
    }

    /// <summary>
    /// <b>A leftovers answer is not a deduction.</b>
    /// </summary>
    /// <remarks>
    /// <c>Produced</c> shares its <c>(SourceKind, SourceId)</c> pair with <c>Deducted</c>, so an
    /// unfiltered "has this night been dealt with?" guard counted the box of leftovers as evidence
    /// that the night had already come off the shelves. A night whose lines only started matching
    /// afterwards — because somebody bought the thing, or taught the match — could then never be
    /// deducted at all.
    /// </remarks>
    [Fact]
    public async Task A_leftovers_answer_does_not_stand_in_for_a_deduction()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        // Nothing on the shelves answers to the line yet, so this night deducts nothing.
        var recipe = await RecipeAsync(client, "Ragu", "chopped tomatoes");
        var entryId = await PlanAsync(client, Monday, recipe.Id, servings: 8);
        await AteAsync(client, Monday, portions: 5);
        Assert.Equal(HttpStatusCode.NoContent, (await DeductAsync(client, entryId)).StatusCode);

        // Three spare portions went in the fridge — a `Produced` event on this same night.
        await client.PostAsJsonAsync($"/api/pantry/deduct/{entryId}/produced",
            new ProducedDecisionInput("Fridge", null));

        // The tin turns up on the shelf afterwards. The night is still owed its deduction.
        var tin = await ShelfAsync(client, "chopped tomatoes", quantity: 5, unit: "tins");
        var res = await DeductAsync(client, entryId);

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(3m, await OnShelfAsync(client, tin.Id));
    }
}
