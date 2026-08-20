namespace HomeHub.Tests;

using System.Net.Http.Json;
using HomeHub.Api.Meals;
using HomeHub.Api.Pantry;

/// <summary>
/// Knowing what matches what (MATCHING_AND_ALIASES).
/// </summary>
/// <remarks>
/// The assumption most likely to embarrass the design: every ranked list in the Kitchen rests on it,
/// and when it fails a perfectly correct panel reads as broken. The spec's five-part answer comes
/// down to two testable promises — fail honestly rather than guess, and never ask the same refused
/// question twice.
/// </remarks>
public class MatchingTests
{
    private static async Task<PantryItemDto> ShelfAsync(HttpClient client, string name) =>
        (await (await client.PostAsJsonAsync("/api/pantry", new PantryItemInput(
            name, "Cupboard", "Counted", 1, "ea", null, ProfileId: 1)))
            .Content.ReadFromJsonAsync<PantryItemDto>())!;

    private static async Task<RecipeDto> RecipeAsync(HttpClient client, string title, params string[] ingredients) =>
        (await (await client.PostAsJsonAsync("/api/recipes", new RecipeInput(
            title,
            Servings: 4,
            Ingredients: ingredients.Select(i => new RecipeIngredientInput($"1 {i}", 1, null, i)).ToList())))
            .Content.ReadFromJsonAsync<RecipeDto>())!;

    private static Task<MatchingCoverageDto?> CoverageAsync(HttpClient client) =>
        client.GetFromJsonAsync<MatchingCoverageDto>("/api/pantry/matching");

    /// <summary>§4: one number, over lines rather than recipes.</summary>
    [Fact]
    public async Task Coverage_is_counted_over_lines()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await ShelfAsync(client, "beef mince");
        await RecipeAsync(client, "Shepherd's pie", "beef mince", "beef stock");

        var coverage = await CoverageAsync(client);

        Assert.Equal(2, coverage!.TotalLines);
        Assert.Equal(1, coverage.MatchedLines);
        Assert.Equal(50, coverage.Percent);
    }

    /// <summary>
    /// §4: `WORTH SORTING` is ordered by how many recipes each gap unblocks — what turns a vague
    /// chore into a ranked five-minute job.
    /// </summary>
    [Fact]
    public async Task Gaps_are_ranked_by_what_they_unblock()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await RecipeAsync(client, "Shepherd's pie", "beef stock");
        await RecipeAsync(client, "Stew", "beef stock");
        await RecipeAsync(client, "Cake", "caster sugar");

        var coverage = await CoverageAsync(client);

        Assert.Equal("beef stock", coverage!.WorthSorting[0].Name);
        Assert.Equal(2, coverage.WorthSorting[0].RecipesBlocked);
        Assert.Equal("caster sugar", coverage.WorthSorting[1].Name);
    }

    /// <summary>M2: candidates are ranked, finite, and offered without any free-text field.</summary>
    [Fact]
    public async Task Candidates_are_ranked_by_what_they_share()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await ShelfAsync(client, "beef stock cubes");
        await ShelfAsync(client, "chicken stock");
        await ShelfAsync(client, "plain flour");

        var candidates = await client.GetFromJsonAsync<List<PantryItemDto>>(
            "/api/pantry/matching/candidates?ingredient=beef%20stock");

        // Two shared words beats one; the flour shares nothing and is not offered at all.
        Assert.Equal("beef stock cubes", candidates![0].Name);
        Assert.Contains(candidates, c => c.Name == "chicken stock");
        Assert.DoesNotContain(candidates, c => c.Name == "plain flour");
    }

    /// <summary>M2: teaching a match settles it household-wide, for every recipe wanting it.</summary>
    [Fact]
    public async Task Teaching_a_match_settles_it_for_every_recipe()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var cubes = await ShelfAsync(client, "beef stock cubes");
        await RecipeAsync(client, "Shepherd's pie", "beef stock");
        await RecipeAsync(client, "Stew", "beef stock");

        Assert.Equal(0, (await CoverageAsync(client))!.MatchedLines);

        await client.PostAsJsonAsync("/api/pantry/matching/teach",
            new TeachMatchInput("beef stock", cubes.Id, ProfileId: 1));

        var after = await CoverageAsync(client);
        Assert.Equal(2, after!.MatchedLines);
        Assert.Equal(100, after.Percent);
    }

    /// <summary>
    /// §5: <b>a match undone is never suggested again for that pair.</b>
    /// </summary>
    /// <remarks>
    /// Without this the ranked list keeps offering chicken stock for beef stock every time the
    /// question comes round, and the household learns that saying no achieves nothing.
    /// </remarks>
    [Fact]
    public async Task A_refused_pairing_is_not_offered_again()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var chicken = await ShelfAsync(client, "chicken stock");

        await client.PostAsJsonAsync("/api/pantry/matching/refuse",
            new RefuseMatchInput("beef stock", chicken.Id, ProfileId: 1));

        var candidates = await client.GetFromJsonAsync<List<PantryItemDto>>(
            "/api/pantry/matching/candidates?ingredient=beef%20stock");

        Assert.DoesNotContain(candidates!, c => c.Id == chicken.Id);
        Assert.Equal(1, (await CoverageAsync(client))!.Undone);
    }

    /// <summary>
    /// §5: refusing a pair unmatches it. The line goes back to unmatched rather than being forced
    /// somewhere — not owning a thing is an answer too.
    /// </summary>
    [Fact]
    public async Task Refusing_a_match_unmatches_the_line()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var stock = await ShelfAsync(client, "beef stock");
        await RecipeAsync(client, "Stew", "beef stock");

        Assert.Equal(1, (await CoverageAsync(client))!.MatchedLines);

        await client.PostAsJsonAsync("/api/pantry/matching/refuse",
            new RefuseMatchInput("beef stock", stock.Id, ProfileId: 1));

        Assert.Equal(0, (await CoverageAsync(client))!.MatchedLines);
    }

    /// <summary>Saying yes is a newer answer than saying no — teaching clears an earlier refusal.</summary>
    [Fact]
    public async Task Teaching_overrides_an_earlier_refusal()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var cubes = await ShelfAsync(client, "beef stock cubes");
        await RecipeAsync(client, "Stew", "beef stock");

        await client.PostAsJsonAsync("/api/pantry/matching/refuse",
            new RefuseMatchInput("beef stock", cubes.Id, ProfileId: 1));
        await client.PostAsJsonAsync("/api/pantry/matching/teach",
            new TeachMatchInput("beef stock", cubes.Id, ProfileId: 1));

        var after = await CoverageAsync(client);
        Assert.Equal(1, after!.MatchedLines);
        Assert.Equal(0, after.Undone);
    }

    /// <summary>
    /// §5: a refused pair suppresses <b>that pair</b>, not the name. The ingredient stays matchable
    /// against everything else on the shelves.
    /// </summary>
    [Fact]
    public async Task Refusing_one_pairing_leaves_the_others_open()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var chicken = await ShelfAsync(client, "chicken stock");
        var beef = await ShelfAsync(client, "beef stock cubes");

        await client.PostAsJsonAsync("/api/pantry/matching/refuse",
            new RefuseMatchInput("beef stock", chicken.Id, ProfileId: 1));

        var candidates = await client.GetFromJsonAsync<List<PantryItemDto>>(
            "/api/pantry/matching/candidates?ingredient=beef%20stock");

        Assert.Contains(candidates!, c => c.Id == beef.Id);
    }

    /// <summary>§4: attribution, so the household can see it is being taught by shopping.</summary>
    [Fact]
    public async Task Coverage_says_how_it_was_learned()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var cubes = await ShelfAsync(client, "beef stock cubes");
        await client.PostAsJsonAsync("/api/pantry/matching/teach",
            new TeachMatchInput("beef stock", cubes.Id, ProfileId: 1));

        var coverage = await CoverageAsync(client);

        Assert.True(coverage!.BySource.TryGetValue(nameof(AliasSource.Manual), out var manual));
        Assert.Equal(1, manual);
    }
}
