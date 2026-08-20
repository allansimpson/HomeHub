namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Meals;
using HomeHub.Api.Pantry;

/// <summary>
/// Cooking produces stock (KITCHEN_LOOP_ADDENDUM §5, COOKING_AND_AFTER §3).
/// </summary>
/// <remarks>
/// This is the step that closes the ring. The planner has always been able to put "Leftovers" on a
/// night; until the pantry knows those leftovers exist, that row is a note to the household rather
/// than something the list and the check understand.
/// </remarks>
public class LeftoversTests
{
    private static readonly DateOnly Monday = new(2026, 8, 17);

    /// <summary>
    /// A recipe with one line, and that line on a shelf.
    /// </summary>
    /// <remarks>
    /// Both halves matter: the receipt (9f) does not appear at all when a night deducts nothing, so
    /// a recipe with no matched ingredients would never reach the leftovers card no matter how many
    /// portions were spare.
    /// </remarks>
    private static async Task<RecipeDto> RecipeAsync(HttpClient client, string title, int servings)
    {
        await client.PostAsJsonAsync("/api/pantry", new PantryItemInput(
            "chopped tomatoes", "Cupboard", "Counted", 20, "tins", null, ProfileId: 1));

        return (await (await client.PostAsJsonAsync("/api/recipes", new RecipeInput(
            title,
            Servings: servings,
            Ingredients: [new RecipeIngredientInput("1 tins chopped tomatoes", 1, "tins", "chopped tomatoes")])))
            .Content.ReadFromJsonAsync<RecipeDto>())!;
    }

    private static async Task<int> PlanAsync(HttpClient client, DateOnly date, int recipeId, int servings)
    {
        var res = await client.PutAsJsonAsync("/api/meals/plan",
            new MealPlanInput(date, MealSlot.Dinner, RecipeId: recipeId, ServingsOverride: servings));
        return (await res.Content.ReadFromJsonAsync<MealPlanEntryDto>())!.Id;
    }

    /// <summary>Say the night was eaten, optionally by fewer people than were cooked for.</summary>
    private static Task<HttpResponseMessage> AteAsync(HttpClient client, DateOnly date, int? portions = null) =>
        client.PutAsJsonAsync("/api/meals/plan/eaten",
            new MealEatenInput(date, MealSlot.Dinner, true, portions));

    private static Task<HttpResponseMessage> DecideAsync(
        HttpClient client, int entryId, string decision, int? portions = null) =>
        client.PostAsJsonAsync($"/api/pantry/deduct/{entryId}/produced",
            new ProducedDecisionInput(decision, portions));

    /// <summary>
    /// §5: cooking for six when four sat down leaves two portions, and the receipt offers them.
    /// </summary>
    [Fact]
    public async Task A_night_that_fed_fewer_than_it_cooked_for_offers_the_rest()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var recipe = await RecipeAsync(client, "Chicken Piccata", servings: 4);
        var entryId = await PlanAsync(client, Monday, recipe.Id, servings: 6);
        await AteAsync(client, Monday, portions: 4);

        var receipt = await Deduct(client, entryId);

        Assert.NotNull(receipt!.Produced);
        Assert.Equal("Leftover Chicken Piccata", receipt.Produced!.SuggestedName);
        Assert.Equal(2, receipt.Produced.SuggestedPortions);
        Assert.Equal(nameof(PantryLocation.Fridge), receipt.Produced.Location);
    }

    private static async Task<DeductionReceiptDto?> Deduct(HttpClient client, int entryId) =>
        await (await client.PostAsync($"/api/pantry/deduct?planEntryId={entryId}", null))
            .Content.ReadFromJsonAsync<DeductionReceiptDto>();

    /// <summary>
    /// §5: a plain "yes, we ate it" means everyone sat down — nothing spare, and so no card.
    /// </summary>
    /// <remarks>
    /// Offering a card for zero portions would make the household dismiss a question about nothing
    /// after every meal, which is the surest way to teach them to ignore it.
    /// </remarks>
    [Fact]
    public async Task Eating_all_of_it_offers_nothing()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var recipe = await RecipeAsync(client, "Carbonara", servings: 4);
        var entryId = await PlanAsync(client, Monday, recipe.Id, servings: 4);
        await AteAsync(client, Monday);

        var receipt = await Deduct(client, entryId);

        Assert.Null(receipt?.Produced);
    }

    /// <summary>
    /// §5: choosing a home creates an <b>ordinary counted item</b> measured in portions — not a
    /// special row — so everything downstream treats it like any other stock.
    /// </summary>
    [Fact]
    public async Task Putting_them_away_creates_ordinary_counted_stock()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var recipe = await RecipeAsync(client, "Ragu", servings: 4);
        var entryId = await PlanAsync(client, Monday, recipe.Id, servings: 8);
        await AteAsync(client, Monday, portions: 5);
        await Deduct(client, entryId);

        (await DecideAsync(client, entryId, "Fridge")).EnsureSuccessStatusCode();

        var pantry = await client.GetFromJsonAsync<PantryListDto>("/api/pantry");
        var leftovers = pantry!.Items.Single(i => i.Name == "Leftover Ragu");

        Assert.Equal(nameof(TrackingClass.Counted), leftovers.Tracking);
        Assert.Equal("portions", leftovers.Unit);
        Assert.Equal(3m, leftovers.Quantity);
        Assert.Equal(nameof(PantryLocation.Fridge), leftovers.Location);
    }

    /// <summary>§5: the freezer is the other button, and it is honoured.</summary>
    [Fact]
    public async Task The_freezer_is_offered_as_well_as_the_fridge()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var recipe = await RecipeAsync(client, "Ragu", servings: 4);
        var entryId = await PlanAsync(client, Monday, recipe.Id, servings: 8);
        await AteAsync(client, Monday, portions: 6);
        await Deduct(client, entryId);

        await DecideAsync(client, entryId, "Freezer");

        var pantry = await client.GetFromJsonAsync<PantryListDto>("/api/pantry");
        Assert.Equal(nameof(PantryLocation.Freezer),
            pantry!.Items.Single(i => i.Name == "Leftover Ragu").Location);
    }

    /// <summary>`NONE LEFT` writes nothing — the third answer is a real one.</summary>
    [Fact]
    public async Task None_left_puts_nothing_on_a_shelf()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var recipe = await RecipeAsync(client, "Ragu", servings: 4);
        var entryId = await PlanAsync(client, Monday, recipe.Id, servings: 8);
        await AteAsync(client, Monday, portions: 5);
        await Deduct(client, entryId);

        await DecideAsync(client, entryId, "None");

        var pantry = await client.GetFromJsonAsync<PantryListDto>("/api/pantry");
        Assert.DoesNotContain(pantry!.Items, i => i.Name == "Leftover Ragu");
    }

    /// <summary>
    /// §5: "Undo removes the produced item with the rest of the receipt."
    /// </summary>
    /// <remarks>
    /// Leaving it behind would put leftovers in the fridge for a night the household has just said
    /// did not happen — and a later night would then claim them.
    /// </remarks>
    [Fact]
    public async Task Undoing_the_receipt_takes_the_leftovers_with_it()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var recipe = await RecipeAsync(client, "Ragu", servings: 4);
        var entryId = await PlanAsync(client, Monday, recipe.Id, servings: 8);
        await AteAsync(client, Monday, portions: 5);
        await Deduct(client, entryId);
        await DecideAsync(client, entryId, "Fridge");

        await client.PostAsync($"/api/pantry/deduct/{entryId}/undo", null);

        var pantry = await client.GetFromJsonAsync<PantryListDto>("/api/pantry");
        Assert.DoesNotContain(pantry!.Items, i => i.Name == "Leftover Ragu");
    }

    /// <summary>
    /// Answering the card twice is answering it once. Two boxes of Tuesday's leftovers is a fiction
    /// the fridge will not back up.
    /// </summary>
    [Fact]
    public async Task Answering_twice_does_not_make_two_boxes()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var recipe = await RecipeAsync(client, "Ragu", servings: 4);
        var entryId = await PlanAsync(client, Monday, recipe.Id, servings: 8);
        await AteAsync(client, Monday, portions: 5);
        await Deduct(client, entryId);

        await DecideAsync(client, entryId, "Fridge");
        await DecideAsync(client, entryId, "Freezer");

        var pantry = await client.GetFromJsonAsync<PantryListDto>("/api/pantry");
        var box = Assert.Single(pantry!.Items, i => i.Name == "Leftover Ragu");
        Assert.Equal(nameof(PantryLocation.Freezer), box.Location);
    }

    /// <summary>Three answers, and anything else is the caller's mistake rather than the server's.</summary>
    [Fact]
    public async Task An_answer_that_is_not_one_of_the_three_is_refused()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var recipe = await RecipeAsync(client, "Ragu", servings: 4);
        var entryId = await PlanAsync(client, Monday, recipe.Id, servings: 8);

        var res = await DecideAsync(client, entryId, "Compost");

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }
}
