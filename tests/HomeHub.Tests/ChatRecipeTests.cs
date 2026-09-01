namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Meals;

/// <summary>
/// Saving a recipe out of a chat: the reading, and the write that follows a yes.
/// </summary>
/// <remarks>
/// The transcripts here are the shape an agent actually replies in — markdown headings, bold, a
/// fenced block, a table — because that is the whole difficulty. The parser matches its section
/// headings whole, so <c>## Ingredients</c> is not the word `ingredients` to it, and a reply left
/// unflattened reads as one unsectioned list.
/// </remarks>
public class ChatRecipeTests
{
    /// <summary>What Barnaby says when he has been asked to take the dairy out of something.</summary>
    private const string AdaptedReply = """
        Here's the version with the dairy taken out:

        ## Chicken Katsu Curry

        Serves 4

        ### Ingredients

        - 4 chicken breasts
        - 100 g panko breadcrumbs
        - 2 tbsp olive oil
        - 1 onion, diced
        - 2 carrots, chopped
        - 2 tbsp curry powder
        - 400 ml coconut milk
        - 1 tbsp soy sauce

        ### Method

        1. Flatten the chicken breasts and coat them in panko.
        2. Fry until golden, about six minutes a side.
        3. Soften the onion and carrot in the oil.
        4. Stir in the curry powder, then the coconut milk and soy.
        5. Simmer for twenty minutes, then blend it smooth.
        6. Slice the chicken and pour the sauce over.
        """;

    /// <summary>The member's own turn, with the recipe they found pasted underneath it.</summary>
    private const string PastedOriginal = """
        Can you take the dairy out of this one? From https://example.com/katsu

        Chicken Katsu Curry

        Serves 4

        Ingredients

        4 chicken breasts
        100 g panko breadcrumbs
        2 tbsp butter
        1 onion, diced
        2 carrots, chopped
        2 tbsp curry powder
        400 ml single cream
        1 tbsp soy sauce

        Method

        Flatten the chicken breasts and coat them in panko.
        Fry until golden, about six minutes a side.
        Soften the onion and carrot in the butter.
        Stir in the curry powder, then the cream and soy.
        Simmer for twenty minutes, then blend it smooth.
        Slice the chicken and pour the sauce over.
        """;

    private static Task<HttpResponseMessage> ReadAsync(HttpClient client, params string[] messages) =>
        client.PostAsJsonAsync("/api/recipes/read-conversation", new RecipeConversationInput(messages));

    private static async Task<RecipeConversationReadingDto> ReadingAsync(HttpClient client, params string[] messages) =>
        (await (await ReadAsync(client, messages)).Content.ReadFromJsonAsync<RecipeConversationReadingDto>())!;

    /// <summary>
    /// The reply is read through its markdown, and the member's command is not mistaken for it.
    /// </summary>
    [Fact]
    public async Task A_markdown_reply_reads_as_a_complete_recipe()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var reading = await ReadingAsync(client, "save this recipe", AdaptedReply, PastedOriginal);

        Assert.True(reading.Found);
        Assert.Equal("Complete", reading.Confidence);
        // Message 0 is the command — too short to be a recipe, and never the thing somebody means.
        Assert.Equal(1, reading.Message);
        Assert.Equal("Chicken Katsu Curry", reading.Title);
        Assert.Equal(4, reading.Servings);
        Assert.Equal(8, reading.IngredientCount);
        Assert.Equal(6, reading.StepCount);
        Assert.Null(reading.Existing);
    }

    /// <summary>
    /// <b>Newest first, so the adaptation wins.</b> Both messages are complete recipes with the same
    /// name; the one the household means is the one that came out of the conversation, not the one
    /// they pasted into it.
    /// </summary>
    [Fact]
    public async Task The_newest_complete_reading_is_the_one_offered()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var reading = await ReadingAsync(client, AdaptedReply, PastedOriginal);

        Assert.Equal(0, reading.Message);
        // The dairy-free one. Its ingredient list is what a save would write.
        var saved = await SaveAsync(client, AdaptedReply);
        Assert.Contains(saved.Ingredients, i => i.RawText.Contains("coconut milk", StringComparison.Ordinal));
        Assert.DoesNotContain(saved.Ingredients, i => i.RawText.Contains("cream", StringComparison.Ordinal));
    }

    /// <summary>
    /// A message that lists only what changed is a correction, not a recipe — so the richest partial
    /// reading wins rather than the newest one.
    /// </summary>
    [Fact]
    public async Task A_fragment_does_not_outrank_a_fuller_reading()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        const string fragment = """
            Two swaps and it's dairy-free:

            Ingredients

            - 2 tbsp olive oil, in place of the butter
            - 400 ml coconut milk, in place of the cream
            """;

        var reading = await ReadingAsync(client, fragment, AdaptedReply);

        Assert.Equal(1, reading.Message);
        Assert.Equal(8, reading.IngredientCount);
    }

    /// <summary>
    /// Nothing to read. The link is handed back instead, so the panel has something to offer — and
    /// nothing is fetched here.
    /// </summary>
    [Fact]
    public async Task A_chat_with_only_a_link_says_so_and_hands_the_link_back()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var reading = await ReadingAsync(
            client,
            "save this recipe",
            "That looks like a good one — it's a katsu curry with a coconut milk sauce rather than a cream one.",
            "Have a look at https://example.com/katsu-curry and tell me what you think of it");

        Assert.False(reading.Found);
        Assert.Equal("Empty", reading.Confidence);
        Assert.Equal("https://example.com/katsu-curry", reading.Link);
        Assert.Equal(0, reading.IngredientCount);
        Assert.NotNull(reading.Reason);
    }

    /// <summary>An empty transcript is a bad request, not an empty reading.</summary>
    [Fact]
    public async Task Nothing_to_read_is_refused()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var response = await ReadAsync(client);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    /// <summary>
    /// A recipe already in the folder under that name is named back, so the offer can ask whether
    /// this is a variation of it rather than quietly making a second one.
    /// </summary>
    [Fact]
    public async Task A_name_the_folder_already_holds_comes_back_with_the_reading()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var existing = await ExistingAsync(client);

        var reading = await ReadingAsync(client, AdaptedReply);

        Assert.NotNull(reading.Existing);
        Assert.Equal(existing.Id, reading.Existing!.Id);
        Assert.Equal("Chicken Katsu Curry", reading.Existing.Title);
    }

    /// <summary>
    /// Saying yes writes the recipe, and the write is the same parse of the same message — the
    /// reading's counts and the saved recipe's agree line for line.
    /// </summary>
    [Fact]
    public async Task Saving_writes_what_the_reading_described()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var reading = await ReadingAsync(client, "save this recipe", AdaptedReply);
        var saved = await SaveAsync(client, AdaptedReply);

        Assert.Equal(reading.Title, saved.Title);
        Assert.Equal(reading.IngredientCount, saved.Ingredients.Count);
        Assert.Equal(reading.StepCount, saved.Steps.Count);
        // Parsed, not just stored as lines — a recipe out of a chat scales like every other one.
        Assert.Contains(saved.Ingredients, i => i.Name == "coconut milk" && i is { Quantity: 400m, Unit: not null });
        Assert.Equal("Complete", saved.Completeness);
        Assert.Null(saved.ForkedFrom);
    }

    /// <summary>
    /// Saved as a variation: it keeps its own method and amounts, takes the cuisine and the source
    /// from the recipe it came from, and says which one that was.
    /// </summary>
    [Fact]
    public async Task A_variation_keeps_its_own_body_and_inherits_provenance()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var original = await ExistingAsync(client);

        var saved = await SaveAsync(client, AdaptedReply, forkOf: original.Id);

        Assert.Equal(original.Id, saved.ForkedFrom);
        Assert.Equal("Chicken Katsu Curry", saved.ForkedFromTitle);
        // Its own body — a chat changes the method as readily as the amounts.
        Assert.Equal(6, saved.Steps.Count);
        Assert.Contains(saved.Ingredients, i => i.RawText.Contains("coconut milk", StringComparison.Ordinal));
        // The parent's, because the block could not say either for itself.
        Assert.Contains("cuisine:japanese", saved.Tags);
        Assert.Equal("https://example.com/katsu", saved.SourceUrl);
        // Untouched, which is the first thing MEALS_FORK asks of a variation.
        var parent = await client.GetFromJsonAsync<RecipeDto>($"/api/recipes/{original.Id}");
        Assert.Equal(original.Version, parent!.Version);
        Assert.Contains(parent.Ingredients, i => i.RawText.Contains("cream", StringComparison.Ordinal));
    }

    /// <summary>
    /// A variation of a recipe that is no longer there is refused rather than saved unlinked: the
    /// household asked for the link, and a copy arriving quietly without one is the duplicate the
    /// offer existed to prevent.
    /// </summary>
    [Fact]
    public async Task A_variation_of_a_recipe_that_is_gone_is_refused()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var response = await client.PostAsJsonAsync(
            "/api/recipes/import/text", new RecipePasteInput(AdaptedReply, ForkOf: 9999));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    /// <summary>
    /// The paste path reads markdown now, which is what a recipe out of a chat is made of. A block
    /// whose headings are `##` used to arrive as one unsectioned list with no method at all.
    /// </summary>
    [Fact]
    public async Task Markdown_headings_section_a_pasted_block()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var saved = await SaveAsync(client, AdaptedReply);

        Assert.Equal(6, saved.Steps.Count);
        Assert.StartsWith("Flatten the chicken", saved.Steps[0].Text, StringComparison.Ordinal);
        // The bold and the bullets came off; the line reads as it was written.
        Assert.DoesNotContain(saved.Ingredients, i => i.RawText.StartsWith('-'));
    }

    /// <summary>An ingredient table is the other way an agent lays a list out. Same lines.</summary>
    [Fact]
    public async Task An_ingredient_table_reads_as_ingredients()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        const string tabled = """
            **Buttered leeks**

            | Amount | Ingredient |
            |---|---|
            | 4 | leeks, sliced |
            | 2 tbsp | butter |
            | 1 tsp | thyme leaves |

            **Method**

            1. Sweat the leeks in the butter for ten minutes.
            2. Add the thyme and a splash of water, then cover.
            """;

        var saved = await SaveAsync(client, tabled);

        Assert.Equal("Buttered leeks", saved.Title);
        Assert.Equal(3, saved.Ingredients.Count);
        Assert.Equal(2, saved.Steps.Count);
        Assert.Contains(saved.Ingredients, i => i.RawText.Contains("leeks, sliced", StringComparison.Ordinal));
    }

    /// <summary>The recipe the household already had, with dairy in it and a cuisine on it.</summary>
    private static async Task<RecipeDto> ExistingAsync(HttpClient client) =>
        (await (await client.PostAsJsonAsync("/api/recipes", new RecipeInput(
            "Chicken Katsu Curry",
            SourceUrl: "https://example.com/katsu",
            SourceName: "example.com",
            Servings: 4,
            Ingredients: [
                new RecipeIngredientInput("2 tbsp butter", 2, "tbsp", "butter"),
                new RecipeIngredientInput("400 ml single cream", 400, "ml", "single cream"),
            ],
            Steps: [new RecipeStepInput("Soften the onion in the butter.")],
            Tags: ["cuisine:japanese"])))
            .Content.ReadFromJsonAsync<RecipeDto>())!;

    private static async Task<RecipeDto> SaveAsync(HttpClient client, string message, int? forkOf = null)
    {
        var response = await client.PostAsJsonAsync(
            "/api/recipes/import/text", new RecipePasteInput(message, ForkOf: forkOf));
        response.EnsureSuccessStatusCode();
        var import = await response.Content.ReadFromJsonAsync<RecipeImportResponse>();
        Assert.NotNull(import!.Recipe);
        return import.Recipe!;
    }
}
