namespace HomeHub.Tests;

using System.Net.Http.Json;
using HomeHub.Api.Meals;
using HomeHub.Api.Pantry;

/// <summary>
/// Which recipes could be cooked right now — the folder's division (RECIPES §1).
/// </summary>
/// <remarks>
/// The band is the folder's organising principle, so the rules about which one a recipe lands in
/// are the whole feature. The one that matters most is the third band: a recipe the panel cannot
/// fully read says so rather than joining either of the confident answers.
/// </remarks>
public class CookabilityTests
{
    private static Task<HttpResponseMessage> ShelfAsync(
        HttpClient client, string name, decimal quantity, string tracking = "Counted") =>
        client.PostAsJsonAsync("/api/pantry", new PantryItemInput(
            name, "Cupboard", tracking, quantity, "ea", null, ProfileId: 1));

    private static Task<HttpResponseMessage> RecipeAsync(
        HttpClient client, string title, params (string Name, decimal Qty)[] lines) =>
        client.PostAsJsonAsync("/api/recipes", new RecipeInput(
            title,
            Servings: 4,
            Ingredients: lines
                .Select(l => new RecipeIngredientInput($"{l.Qty} ea {l.Name}", l.Qty, "ea", l.Name))
                .ToList()));

    private static async Task<CookabilityDto> StandingAsync(HttpClient client, string title)
    {
        var recipes = await client.GetFromJsonAsync<List<RecipeSummaryDto>>("/api/recipes");
        var id = recipes!.Single(r => r.Title == title).Id;
        var standing = await client.GetFromJsonAsync<List<CookabilityDto>>("/api/pantry/cookable");
        return standing!.Single(s => s.RecipeId == id);
    }

    /// <summary>Everything on a shelf and enough of it — `COOK IT TONIGHT`.</summary>
    [Fact]
    public async Task A_recipe_with_everything_in_is_ready()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await ShelfAsync(client, "eggs", 6);
        await RecipeAsync(client, "Omelette", ("eggs", 3));

        var standing = await StandingAsync(client, "Omelette");

        Assert.Equal("Ready", standing.Band);
        Assert.Equal(0, standing.ShortCount);
    }

    /// <summary>A countable gap the household could go and fix.</summary>
    [Fact]
    public async Task A_recipe_missing_something_countable_is_short()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await ShelfAsync(client, "eggs", 1);
        await RecipeAsync(client, "Omelette", ("eggs", 3));

        var standing = await StandingAsync(client, "Omelette");

        Assert.Equal("Short", standing.Band);
        Assert.Equal(1, standing.ShortCount);
    }

    /// <summary>
    /// §1: a recipe whose lines never matched sits in `EVERYTHING ELSE` reading <c>can't say</c> —
    /// <b>never</b> in the ready band.
    /// </summary>
    /// <remarks>
    /// This is the promise the whole matching spec exists to keep. A false "ready" at seven in the
    /// evening costs the household's trust; an admitted gap costs a minute.
    /// </remarks>
    [Fact]
    public async Task An_unmatched_line_keeps_a_recipe_out_of_the_ready_band()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await ShelfAsync(client, "eggs", 6);
        await RecipeAsync(client, "Omelette", ("eggs", 3), ("saffron", 1));

        var standing = await StandingAsync(client, "Omelette");

        Assert.Equal("CantSay", standing.Band);
        Assert.Equal(1, standing.UnmatchedCount);
    }

    [Fact]
    public async Task An_unmatched_line_is_not_reported_as_a_shortfall()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await ShelfAsync(client, "eggs", 6);
        await RecipeAsync(client, "Omelette", ("eggs", 3), ("saffron", 1));

        var standing = await StandingAsync(client, "Omelette");

        // Nothing is short: the panel does not know what saffron is, which is a different problem
        // and would send somebody shopping for the wrong reason.
        Assert.Equal(0, standing.ShortCount);
    }

    /// <summary>
    /// Unmatched outranks short. A recipe the panel cannot fully read must not be presented as one
    /// that merely needs a shop, or the household acts on a list that is wrong.
    /// </summary>
    [Fact]
    public async Task Cannot_say_outranks_short()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await ShelfAsync(client, "eggs", 1);
        await RecipeAsync(client, "Omelette", ("eggs", 3), ("saffron", 1));

        Assert.Equal("CantSay", (await StandingAsync(client, "Omelette")).Band);
    }

    /// <summary>A staple is never a problem and never keeps a recipe out of the ready band.</summary>
    [Fact]
    public async Task A_staple_never_holds_a_recipe_back()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await ShelfAsync(client, "eggs", 6);
        await ShelfAsync(client, "salt", 0, tracking: "NotCounted");
        await RecipeAsync(client, "Omelette", ("eggs", 3), ("salt", 1));

        Assert.Equal("Ready", (await StandingAsync(client, "Omelette")).Band);
    }

    /// <summary>
    /// Teaching the match moves the recipe out of `can't say` — the fix the panel offers actually
    /// changes the folder.
    /// </summary>
    [Fact]
    public async Task Teaching_the_match_moves_it_into_a_confident_band()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await ShelfAsync(client, "eggs", 6);
        var saffron = await (await ShelfAsync(client, "saffron threads", 1))
            .Content.ReadFromJsonAsync<PantryItemDto>();
        await RecipeAsync(client, "Omelette", ("eggs", 3), ("saffron", 1));

        Assert.Equal("CantSay", (await StandingAsync(client, "Omelette")).Band);

        await client.PostAsJsonAsync("/api/pantry/matching/teach",
            new TeachMatchInput("saffron", saffron!.Id, ProfileId: 1));

        Assert.Equal("Ready", (await StandingAsync(client, "Omelette")).Band);
    }
}
