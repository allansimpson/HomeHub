namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Meals;

/// <summary>
/// Stage M1 recipe folder over HTTP, against an isolated in-memory database. Recipes are owned
/// locally rather than cached from a provider (meals-planning.md D1), so these exercise the
/// controller and the EF model directly — there is no seam to stub.
/// </summary>
public class RecipesApiTests
{
    private static RecipeInput Simple(string title, params string[] tags) => new(
        Title: title,
        Ingredients: [new RecipeIngredientInput("2 tbsp olive oil"), new RecipeIngredientInput("1 onion, diced")],
        Steps: [new RecipeStepInput("Heat the oil."), new RecipeStepInput("Cook the onion.")],
        Tags: tags);

    private static async Task<RecipeDto> CreateAsync(HttpClient client, RecipeInput input) =>
        (await (await client.PostAsJsonAsync("/api/recipes", input)).Content.ReadFromJsonAsync<RecipeDto>())!;

    [Fact]
    public async Task Create_returns_the_recipe_with_ordered_children()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var created = await CreateAsync(client, Simple("Chicken Piccata", "quick", "weeknight"));

        Assert.True(created.Id > 0);
        Assert.Equal("Chicken Piccata", created.Title);
        Assert.Equal("Manual", created.ImportMethod);
        Assert.Equal("Complete", created.Completeness);
        Assert.Equal(1, created.Version);

        // Position comes from array order, not from the client.
        Assert.Equal(new[] { 0, 1 }, created.Ingredients.Select(i => i.Position));
        Assert.Equal("2 tbsp olive oil", created.Ingredients[0].RawText);
        Assert.Equal(new[] { 0, 1 }, created.Steps.Select(s => s.Position));
        Assert.Equal(new[] { "quick", "weeknight" }, created.Tags);

        // The parsed fields stay null until the Stage M2 parser fills them — never guessed here.
        Assert.All(created.Ingredients, i => Assert.Null(i.Quantity));
    }

    [Fact]
    public async Task Tags_are_trimmed_deduped_case_insensitively_and_blanks_dropped()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var created = await CreateAsync(client, Simple("Soup") with
        {
            Tags = ["  Quick ", "quick", "QUICK", "", "   ", "soup"],
        });

        Assert.Equal(new[] { "Quick", "soup" }, created.Tags);
    }

    [Fact]
    public async Task List_hides_archived_unless_asked_and_filters_by_tag_ignoring_case()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await CreateAsync(client, Simple("Weeknight Pasta", "quick"));
        await CreateAsync(client, Simple("Sunday Roast", "slow"));
        await CreateAsync(client, Simple("Retired Stew", "slow") with { IsArchived = true });

        var visible = await client.GetFromJsonAsync<List<RecipeSummaryDto>>("/api/recipes");
        Assert.Equal(new[] { "Sunday Roast", "Weeknight Pasta" }, visible!.Select(r => r.Title));

        var withArchived = await client.GetFromJsonAsync<List<RecipeSummaryDto>>("/api/recipes?includeArchived=true");
        Assert.Equal(3, withArchived!.Count);

        // The Chip filter sends whatever casing the tag row displayed; matching must not care.
        var slow = await client.GetFromJsonAsync<List<RecipeSummaryDto>>("/api/recipes?tag=SLOW");
        Assert.Single(slow!);
        Assert.Equal("Sunday Roast", slow![0].Title);
    }

    [Fact]
    public async Task Summary_counts_children_without_returning_them()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        await CreateAsync(client, Simple("Pasta"));

        var list = await client.GetFromJsonAsync<List<RecipeSummaryDto>>("/api/recipes");

        Assert.Equal(2, list![0].IngredientCount);
        Assert.Equal(2, list[0].StepCount);
        Assert.False(list[0].HasImage);
    }

    [Fact]
    public async Task Tag_counts_exclude_archived_recipes()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await CreateAsync(client, Simple("A", "quick"));
        await CreateAsync(client, Simple("B", "quick"));
        await CreateAsync(client, Simple("C", "quick") with { IsArchived = true });

        var tags = await client.GetFromJsonAsync<List<RecipeTagCountDto>>("/api/recipes/tags");

        var quick = Assert.Single(tags!);
        Assert.Equal("quick", quick.Tag);
        Assert.Equal(2, quick.Count);
    }

    [Fact]
    public async Task Replace_swaps_children_wholesale_and_bumps_the_version()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var created = await CreateAsync(client, Simple("Draft", "old"));

        var replaced = await (await client.PutAsJsonAsync($"/api/recipes/{created.Id}", new RecipeInput(
            Title: "Final",
            Servings: 4,
            Ingredients: [new RecipeIngredientInput("3 eggs")],
            Steps: [new RecipeStepInput("Whisk.")],
            Tags: ["new"]))).Content.ReadFromJsonAsync<RecipeDto>();

        Assert.Equal("Final", replaced!.Title);
        Assert.Equal(4, replaced.Servings);
        Assert.Equal(2, replaced.Version);
        // Replaced, not merged — the old lines are gone rather than appended to.
        Assert.Equal(new[] { "3 eggs" }, replaced.Ingredients.Select(i => i.RawText));
        Assert.Equal(new[] { "Whisk." }, replaced.Steps.Select(s => s.Text));
        Assert.Equal(new[] { "new" }, replaced.Tags);

        // And the orphaned children are really deleted, not left dangling.
        var reread = await client.GetFromJsonAsync<RecipeDto>($"/api/recipes/{created.Id}");
        Assert.Single(reread!.Ingredients);
        Assert.Single(reread.Steps);
    }

    [Fact]
    public async Task Conditional_write_conflicts_on_a_stale_version_and_reports_current_state()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var created = await CreateAsync(client, Simple("Stew"));

        // Someone else edits first, taking the version to 2.
        await client.PutAsJsonAsync($"/api/recipes/{created.Id}?baseVersion=1", Simple("Stew (theirs)"));

        var stale = await client.PutAsJsonAsync($"/api/recipes/{created.Id}?baseVersion=1", Simple("Stew (mine)"));

        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
        var current = await stale.Content.ReadFromJsonAsync<RecipeDto>();
        Assert.Equal("Stew (theirs)", current!.Title);
        Assert.Equal(2, current.Version);
    }

    [Fact]
    public async Task Omitting_baseVersion_is_last_write_wins()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var created = await CreateAsync(client, Simple("Stew"));
        await client.PutAsJsonAsync($"/api/recipes/{created.Id}", Simple("Once"));

        var again = await client.PutAsJsonAsync($"/api/recipes/{created.Id}", Simple("Twice"));

        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
        Assert.Equal("Twice", (await again.Content.ReadFromJsonAsync<RecipeDto>())!.Title);
    }

    [Fact]
    public async Task Missing_recipe_is_404_on_read_write_and_delete()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/recipes/999")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PutAsJsonAsync("/api/recipes/999", Simple("Ghost"))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.DeleteAsync("/api/recipes/999")).StatusCode);
    }

    [Fact]
    public async Task Rejects_a_recipe_with_no_title()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var blank = await client.PostAsJsonAsync("/api/recipes", new RecipeInput("   "));

        Assert.Equal(HttpStatusCode.BadRequest, blank.StatusCode);
    }

    [Fact]
    public async Task Delete_removes_the_recipe_and_its_children()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var created = await CreateAsync(client, Simple("Doomed"));

        var deleted = await client.DeleteAsync($"/api/recipes/{created.Id}");

        Assert.Equal(HttpStatusCode.NoContent, deleted.StatusCode);
        Assert.Empty((await client.GetFromJsonAsync<List<RecipeSummaryDto>>("/api/recipes"))!);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"/api/recipes/{created.Id}")).StatusCode);
    }

    [Theory]
    // Each of these exceeds its column by one character. On SQL Server an unchecked overflow is
    // "String or binary data would be truncated" wrapped in a DbUpdateException — a 500 naming
    // neither the field nor the limit. The in-memory provider these tests run on ignores
    // HasMaxLength entirely, so this asserts the controller's guard, not the database's.
    [InlineData("title")]
    [InlineData("description")]
    [InlineData("sourceUrl")]
    [InlineData("ingredient")]
    [InlineData("step")]
    [InlineData("tag")]
    public async Task Overlong_fields_are_refused_with_a_message_naming_the_field(string field)
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var input = field switch
        {
            "title" => new RecipeInput(new string('x', 301)),
            "description" => new RecipeInput("Fine", Description: new string('x', 2001)),
            "sourceUrl" => new RecipeInput("Fine", SourceUrl: new string('x', 1001)),
            "ingredient" => new RecipeInput("Fine", Ingredients: [new RecipeIngredientInput(new string('x', 501))]),
            "step" => new RecipeInput("Fine", Steps: [new RecipeStepInput(new string('x', 4001))]),
            _ => new RecipeInput("Fine", Tags: [new string('x', 41)]),
        };

        var res = await client.PostAsJsonAsync("/api/recipes", input);

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Contains("longer than", await res.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task A_field_at_exactly_its_limit_is_accepted()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        // The boundary matters: an off-by-one in the guard would reject valid recipes forever, which
        // is a worse failure than the 500 it replaced.
        var res = await client.PostAsJsonAsync("/api/recipes", new RecipeInput(new string('x', 300)));

        Assert.Equal(HttpStatusCode.Created, res.StatusCode);
    }

    [Fact]
    public async Task Blank_ingredient_and_step_lines_are_dropped_rather_than_stored_empty()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var created = await CreateAsync(client, new RecipeInput(
            Title: "Sparse",
            Ingredients: [new RecipeIngredientInput("1 egg"), new RecipeIngredientInput("   ")],
            Steps: [new RecipeStepInput(""), new RecipeStepInput("Fry it.")]));

        Assert.Equal(new[] { "1 egg" }, created.Ingredients.Select(i => i.RawText));
        // Positions still close up rather than leaving a gap where the blank was.
        Assert.Equal(new[] { "Fry it." }, created.Steps.Select(s => s.Text));
        Assert.Equal(0, created.Steps[0].Position);
    }

    // ---- Naming: what an added recipe ends up called ----

    /// <summary>A pasted block with the headings a real copy carries, so the parse is not the thing
    /// under test in the naming cases below.</summary>
    private const string PastedBlock = """
        Our Best-Ever Weeknight Chili

        Ingredients

        2 tablespoons chili powder
        1 teaspoon ground cumin

        Directions

        Combine in a small bowl and mix well.
        """;

    /// <summary>
    /// The name typed on the add screen is stored, over the one the parser reads off the block.
    /// </summary>
    /// <remarks>
    /// The parser-level rule is covered in <c>PastedRecipeTests</c>; this is the wire, because the
    /// override is only worth anything if the controller actually passes the field through.
    /// </remarks>
    [Fact]
    public async Task A_typed_name_beats_the_one_at_the_top_of_a_pasted_block()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync(
            "/api/recipes/import/text", new RecipePasteInput(PastedBlock, Title: "Nana's chili"));

        var imported = await res.Content.ReadFromJsonAsync<RecipeImportResponse>();
        Assert.Equal("Nana's chili", imported!.Recipe!.Title);
    }

    /// <summary>A blank name is not a name — the block's own title still stands.</summary>
    [Fact]
    public async Task A_blank_typed_name_leaves_the_pasted_one_alone()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync(
            "/api/recipes/import/text", new RecipePasteInput(PastedBlock, Title: "   "));

        var imported = await res.Content.ReadFromJsonAsync<RecipeImportResponse>();
        Assert.Equal("Our Best-Ever Weeknight Chili", imported!.Recipe!.Title);
    }

    /// <summary>
    /// An overlong typed name is a 400, and is caught before the fetcher is ever reached.
    /// </summary>
    /// <remarks>
    /// Both halves matter. A 400 rather than the endpoint's <c>Empty</c> response, because the page
    /// is fine and the name is the problem — "that page publishes no recipe data" would send someone
    /// to fix the wrong thing. And before the fetch, so a name nobody can store does not cost a
    /// round trip to the publisher: no network happens in this test, which is what proves it.
    /// </remarks>
    [Fact]
    public async Task An_overlong_typed_name_is_refused_without_fetching_the_page()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/recipes/import", new RecipeImportInput(
            Url: "https://example.com/recipes/chili",
            Title: new string('x', 301)));

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    /// <summary>
    /// Renaming later is a plain <c>PUT</c> — the edit screen's name field, at the wire.
    /// </summary>
    /// <remarks>
    /// The rest of the recipe has to survive it. A rename that quietly dropped the steps would be a
    /// perfectly plausible bug here, because the edit form sends the whole document back and the
    /// name is the only part it composes rather than echoes.
    /// </remarks>
    [Fact]
    public async Task Renaming_keeps_everything_else_and_bumps_the_version()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var created = await CreateAsync(client, Simple("Our Best-Ever Weeknight Chili", "weeknight"));

        var renamed = await (await client.PutAsJsonAsync(
            $"/api/recipes/{created.Id}?baseVersion={created.Version}",
            Simple("Nana's chili", "weeknight"))).Content.ReadFromJsonAsync<RecipeDto>();

        Assert.Equal("Nana's chili", renamed!.Title);
        Assert.Equal(created.Id, renamed.Id);
        Assert.Equal(2, renamed.Version);
        Assert.Equal(new[] { "2 tbsp olive oil", "1 onion, diced" }, renamed.Ingredients.Select(i => i.RawText));
        Assert.Equal(new[] { "Heat the oil.", "Cook the onion." }, renamed.Steps.Select(s => s.Text));
        Assert.Equal(new[] { "weeknight" }, renamed.Tags);
    }

    /// <summary>A rename to nothing is refused rather than storing an unnameable recipe.</summary>
    [Fact]
    public async Task Renaming_to_blank_is_refused()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var created = await CreateAsync(client, Simple("Chili"));

        var res = await client.PutAsJsonAsync($"/api/recipes/{created.Id}", Simple("   "));

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal("Chili", (await client.GetFromJsonAsync<RecipeDto>($"/api/recipes/{created.Id}"))!.Title);
    }
}
