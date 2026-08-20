namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Meals;

/// <summary>
/// The cuisine a recipe is filed under: how it is spelled, and how a household overrules the
/// importer's guess.
/// </summary>
/// <remarks>
/// The folder groups by this, so the failures are structural rather than cosmetic — two spellings
/// of one cuisine are two headings, and a second cuisine tag on one recipe puts it under both.
/// Neither throws, and neither is visible until the folder is full enough to sort.
/// </remarks>
public class RecipeCuisineTests
{
    private static RecipeInput Simple(string title, params string[] tags) => new(
        Title: title,
        Ingredients: [new RecipeIngredientInput("2 tbsp olive oil")],
        Steps: [new RecipeStepInput("Heat the oil.")],
        Tags: tags);

    private static async Task<RecipeDto> CreateAsync(HttpClient client, RecipeInput input) =>
        (await (await client.PostAsJsonAsync("/api/recipes", input)).Content.ReadFromJsonAsync<RecipeDto>())!;

    // ---- the spelling ----

    /// <summary>
    /// One spelling each. The importer reads this off a page and the household types it by hand, and
    /// if those two normalised differently the folder would grow two headings for one cuisine.
    /// </summary>
    [Theory]
    [InlineData("Italian", "cuisine:italian")]
    [InlineData("ITALIAN", "cuisine:italian")]
    [InlineData("  italian  ", "cuisine:italian")]
    [InlineData("Middle Eastern", "cuisine:middle-eastern")]
    // Collapsed rather than mapped one-to-one: a stray key must not make its own folder group.
    [InlineData("middle   eastern", "cuisine:middle-eastern")]
    public void Every_spelling_lands_on_one_tag(string typed, string expected)
    {
        Assert.Equal(expected, Cuisines.Tag(typed));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void Nothing_typed_is_no_cuisine(string? typed)
    {
        Assert.Null(Cuisines.Tag(typed));
    }

    /// <summary>A name that cannot fit the column is refused rather than silently truncated.</summary>
    [Fact]
    public void A_cuisine_too_long_for_the_column_is_not_a_tag()
    {
        Assert.Null(Cuisines.Tag(new string('x', MealFieldLimits.Tag)));
    }

    // ---- overruling the guess ----

    /// <summary>The whole point: what the importer guessed can be changed afterwards.</summary>
    [Fact]
    public async Task Setting_a_cuisine_replaces_the_imported_one()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var recipe = await CreateAsync(client, Simple("Tacos", "cuisine:italian", "quick"));

        var updated = await (await client.PutAsJsonAsync(
            $"/api/recipes/{recipe.Id}/cuisine", new RecipeCuisineInput("Mexican")))
            .Content.ReadFromJsonAsync<RecipeDto>();

        Assert.Contains("cuisine:mexican", updated!.Tags);
        Assert.DoesNotContain("cuisine:italian", updated.Tags);
        // Exactly one cuisine survives — a recipe carrying two appears under both headings, which is
        // a double count rather than a richer answer.
        Assert.Single(updated.Tags, t => t.StartsWith("cuisine:", StringComparison.OrdinalIgnoreCase));
        // And the plain tags are untouched. This is why it is its own endpoint: a screen that only
        // wanted to say "this is Mexican" must not be able to drop the rest by omission.
        Assert.Contains("quick", updated.Tags);
        Assert.Equal(2, updated.Version);
    }

    /// <summary>Clearing it is a supported answer — the `UNCATEGORISED` case, reached on purpose.</summary>
    [Fact]
    public async Task Clearing_a_cuisine_leaves_the_other_tags_alone()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var recipe = await CreateAsync(client, Simple("Toast", "cuisine:british", "quick"));

        var updated = await (await client.PutAsJsonAsync(
            $"/api/recipes/{recipe.Id}/cuisine", new RecipeCuisineInput(null)))
            .Content.ReadFromJsonAsync<RecipeDto>();

        Assert.DoesNotContain(updated!.Tags, t => t.StartsWith("cuisine:", StringComparison.OrdinalIgnoreCase));
        Assert.Equal(["quick"], updated.Tags);
    }

    /// <summary>
    /// Setting what it already says writes nothing. Tapping the chip somebody else already set must
    /// not read as an edit on the folder, or the attribution strip starts reporting non-events.
    /// </summary>
    [Fact]
    public async Task Setting_the_cuisine_it_already_has_is_not_an_edit()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var recipe = await CreateAsync(client, Simple("Pasta", "cuisine:italian"));

        var updated = await (await client.PutAsJsonAsync(
            $"/api/recipes/{recipe.Id}/cuisine", new RecipeCuisineInput("Italian")))
            .Content.ReadFromJsonAsync<RecipeDto>();

        Assert.Equal(1, updated!.Version);
        Assert.Equal(recipe.ModifiedByProfileId, updated.ModifiedByProfileId);
        Assert.Equal(recipe.ModifiedAtUtc, updated.ModifiedAtUtc);
    }

    /// <summary>A user edit persists through an ordinary amend, which sends the tag list back whole.</summary>
    [Fact]
    public async Task A_chosen_cuisine_survives_a_later_edit()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var recipe = await CreateAsync(client, Simple("Tacos", "cuisine:italian"));

        var chosen = await (await client.PutAsJsonAsync(
            $"/api/recipes/{recipe.Id}/cuisine", new RecipeCuisineInput("Mexican")))
            .Content.ReadFromJsonAsync<RecipeDto>();

        var amended = await (await client.PutAsJsonAsync(
            $"/api/recipes/{recipe.Id}",
            new RecipeInput("Tacos", Servings: 6, Tags: chosen!.Tags)))
            .Content.ReadFromJsonAsync<RecipeDto>();

        Assert.Contains("cuisine:mexican", amended!.Tags);
    }

    /// <summary>A fork carries the household's choice, not the page's — provenance survives (§2).</summary>
    [Fact]
    public async Task A_fork_inherits_the_chosen_cuisine()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var recipe = await CreateAsync(client, Simple("Tacos", "cuisine:italian"));

        await client.PutAsJsonAsync($"/api/recipes/{recipe.Id}/cuisine", new RecipeCuisineInput("Mexican"));
        var fork = await (await client.PostAsJsonAsync(
            $"/api/recipes/{recipe.Id}/fork", new ForkRecipeInput("Our tacos")))
            .Content.ReadFromJsonAsync<RecipeDto>();

        Assert.Contains("cuisine:mexican", fork!.Tags);
        Assert.DoesNotContain("cuisine:italian", fork.Tags);
    }

    /// <summary>
    /// A stale <c>baseVersion</c> loses, and the 409 carries the current recipe so the screen can
    /// re-render from what is actually stored rather than from what was tapped.
    /// </summary>
    [Fact]
    public async Task A_stale_write_is_refused_with_the_current_recipe()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var recipe = await CreateAsync(client, Simple("Tacos"));

        await client.PutAsJsonAsync($"/api/recipes/{recipe.Id}/cuisine", new RecipeCuisineInput("Mexican"));
        var stale = await client.PutAsJsonAsync(
            $"/api/recipes/{recipe.Id}/cuisine?baseVersion={recipe.Version}", new RecipeCuisineInput("Thai"));

        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
        var current = await stale.Content.ReadFromJsonAsync<RecipeDto>();
        Assert.Contains("cuisine:mexican", current!.Tags);
    }

    /// <summary>Overlong prose in the box is a refusal, not a silent clear.</summary>
    [Fact]
    public async Task An_unstorable_cuisine_is_refused()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var recipe = await CreateAsync(client, Simple("Tacos", "cuisine:mexican"));

        var res = await client.PutAsJsonAsync(
            $"/api/recipes/{recipe.Id}/cuisine", new RecipeCuisineInput(new string('x', 200)));

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        var unchanged = await client.GetFromJsonAsync<RecipeDto>($"/api/recipes/{recipe.Id}");
        Assert.Contains("cuisine:mexican", unchanged!.Tags);
    }
}
