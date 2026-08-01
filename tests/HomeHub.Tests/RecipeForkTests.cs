namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Meals;

/// <summary>
/// Forking (MEALS_FORK): keep the original, save your changes as a recipe in its own right.
/// </summary>
public class RecipeForkTests
{
    private static async Task<RecipeDto> OriginalAsync(HttpClient client) =>
        (await (await client.PostAsJsonAsync("/api/recipes", new RecipeInput(
            "Chicken Piccata",
            SourceUrl: "https://www.seriouseats.com/chicken-piccata",
            SourceName: "Serious Eats",
            Servings: 4,
            TotalMinutes: 45,
            PrepNote: "Pound the cutlets the night before",
            LeadMinutes: 720,
            Ingredients: [
                new RecipeIngredientInput("4 chicken cutlets", 4, "ea", "chicken cutlets"),
                new RecipeIngredientInput("1/4 cup capers", 0.25m, "cup", "capers"),
            ],
            Steps: [new RecipeStepInput("Pound them thin."), new RecipeStepInput("Sear and sauce.")],
            Tags: ["cuisine:italian", "quick"])))
            .Content.ReadFromJsonAsync<RecipeDto>())!;

    private static Task<HttpResponseMessage> ForkAsync(HttpClient client, int id, ForkRecipeInput input) =>
        client.PostAsJsonAsync($"/api/recipes/{id}/fork", input);

    /// <summary>§6: the fork carries steps, source, cuisine and tags, and reads NEVER COOKED.</summary>
    [Fact]
    public async Task A_fork_copies_provenance_but_not_history()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var original = await OriginalAsync(client);

        // Cook the original twice, so it has history worth *not* inheriting.
        foreach (var offset in new[] { -10, -4 })
        {
            var date = DateOnly.FromDateTime(DateTime.Now).AddDays(offset);
            await client.PutAsJsonAsync("/api/meals/plan", new MealPlanInput(date, MealSlot.Dinner, RecipeId: original.Id));
            await client.PutAsJsonAsync("/api/meals/plan/eaten", new MealEatenInput(date, MealSlot.Dinner, true));
        }

        var fork = await (await ForkAsync(client, original.Id, new ForkRecipeInput(
            "Chicken Piccata - our version",
            Ingredients: [
                new RecipeIngredientInput("6 chicken cutlets", 6, "ea", "chicken cutlets"),
                new RecipeIngredientInput("1/2 cup capers", 0.5m, "cup", "capers"),
            ])))
            .Content.ReadFromJsonAsync<RecipeDto>();

        // Provenance survives — it still came from there.
        Assert.Equal("Serious Eats", fork!.SourceName);
        Assert.Equal(original.SourceUrl, fork.SourceUrl);
        Assert.Equal(2, fork.Steps.Count);
        Assert.Contains("cuisine:italian", fork.Tags);
        Assert.Contains("quick", fork.Tags);
        Assert.Equal("Pound the cutlets the night before", fork.PrepNote);
        Assert.Equal(720, fork.LeadMinutes);
        Assert.Equal(original.Id, fork.ForkedFrom);
        Assert.Equal("Chicken Piccata", fork.ForkedFromTitle);
        Assert.Equal("6 chicken cutlets", fork.Ingredients[0].RawText);

        // History does not. Inheriting the parent's cooked count is exactly what would make the
        // folder's NOT LATELY sort start lying about a version nobody has cooked.
        var summaries = (await client.GetFromJsonAsync<List<RecipeSummaryDto>>("/api/recipes"))!;
        Assert.Equal(0, summaries.Single(r => r.Id == fork.Id).TimesCooked);
        Assert.Null(summaries.Single(r => r.Id == fork.Id).LastCookedDate);
        Assert.Equal(2, summaries.Single(r => r.Id == original.Id).TimesCooked);
    }

    /// <summary>§6's first criterion: the original comes out exactly as it went in.</summary>
    [Fact]
    public async Task Forking_leaves_the_original_untouched()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var original = await OriginalAsync(client);

        await ForkAsync(client, original.Id, new ForkRecipeInput(
            "Doubled",
            Ingredients: [new RecipeIngredientInput("8 chicken cutlets", 8, "ea", "chicken cutlets")],
            Servings: 8));

        var after = await client.GetFromJsonAsync<RecipeDto>($"/api/recipes/{original.Id}");

        Assert.Equal(original.Title, after!.Title);
        Assert.Equal(original.Servings, after.Servings);
        Assert.Equal(original.Version, after.Version);
        Assert.Equal(original.Ingredients.Count, after.Ingredients.Count);
        Assert.Equal("4 chicken cutlets", after.Ingredients[0].RawText);
        Assert.Null(after.ForkedFrom);
    }

    /// <summary>Unchecking the box makes a clean unlinked copy — a choice, not a default.</summary>
    [Fact]
    public async Task A_fork_without_the_link_keeps_nothing_pointing_back()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var original = await OriginalAsync(client);

        var fork = await (await ForkAsync(client, original.Id, new ForkRecipeInput("Clean copy", KeepLink: false)))
            .Content.ReadFromJsonAsync<RecipeDto>();

        Assert.Null(fork!.ForkedFrom);
        Assert.Null(fork.ForkedFromTitle);
        // Everything else still came across.
        Assert.Equal("Serious Eats", fork.SourceName);
        Assert.Equal(2, fork.Steps.Count);
    }

    /// <summary>
    /// §6: deleting the original leaves the variation intact with an unlinked lineage strip. No
    /// cascade in either direction — which is precisely why ForkedFrom is not a foreign key.
    /// </summary>
    [Fact]
    public async Task Deleting_the_original_leaves_the_variation_whole()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var original = await OriginalAsync(client);
        var fork = await (await ForkAsync(client, original.Id, new ForkRecipeInput("Ours")))
            .Content.ReadFromJsonAsync<RecipeDto>();

        await client.DeleteAsync($"/api/recipes/{original.Id}");

        var after = await client.GetFromJsonAsync<RecipeDto>($"/api/recipes/{fork!.Id}");
        Assert.NotNull(after);
        Assert.Equal(2, after!.Steps.Count);
        // The id is kept; the title can no longer be resolved, which the strip renders as a name
        // with no link rather than as an error.
        Assert.Equal(original.Id, after.ForkedFrom);
        Assert.Null(after.ForkedFromTitle);
    }

    /// <summary>And the other direction: deleting the variation cannot touch the original.</summary>
    [Fact]
    public async Task Deleting_the_variation_leaves_the_original_whole()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var original = await OriginalAsync(client);
        var fork = await (await ForkAsync(client, original.Id, new ForkRecipeInput("Ours")))
            .Content.ReadFromJsonAsync<RecipeDto>();

        await client.DeleteAsync($"/api/recipes/{fork!.Id}");

        var after = await client.GetFromJsonAsync<RecipeDto>($"/api/recipes/{original.Id}");
        Assert.NotNull(after);
        Assert.Equal("Chicken Piccata", after!.Title);
    }

    /// <summary>§6: forking a variation works and points at its immediate parent, not the root.</summary>
    [Fact]
    public async Task A_variation_can_itself_be_forked()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var original = await OriginalAsync(client);
        var first = await (await ForkAsync(client, original.Id, new ForkRecipeInput("Ours")))
            .Content.ReadFromJsonAsync<RecipeDto>();

        var second = await (await ForkAsync(client, first!.Id, new ForkRecipeInput("Ours, weeknight")))
            .Content.ReadFromJsonAsync<RecipeDto>();

        Assert.Equal(first.Id, second!.ForkedFrom);
        Assert.Equal("Ours", second.ForkedFromTitle);
    }

    /// <summary>An unnamed fork is worse than a badly named one (§3).</summary>
    [Fact]
    public async Task A_fork_needs_a_name()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var original = await OriginalAsync(client);

        Assert.Equal(HttpStatusCode.BadRequest, (await ForkAsync(client, original.Id, new ForkRecipeInput("   "))).StatusCode);
    }

    [Fact]
    public async Task Forking_a_recipe_that_does_not_exist_is_404()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        Assert.Equal(HttpStatusCode.NotFound, (await ForkAsync(client, 999, new ForkRecipeInput("X"))).StatusCode);
    }

    /// <summary>A fork with no amount edits is still a complete recipe, not an empty one.</summary>
    [Fact]
    public async Task A_fork_with_no_edits_still_carries_the_ingredients()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var original = await OriginalAsync(client);

        var fork = await (await ForkAsync(client, original.Id, new ForkRecipeInput("Untouched copy")))
            .Content.ReadFromJsonAsync<RecipeDto>();

        Assert.Equal(2, fork!.Ingredients.Count);
        Assert.Equal("4 chicken cutlets", fork.Ingredients[0].RawText);
    }
}
