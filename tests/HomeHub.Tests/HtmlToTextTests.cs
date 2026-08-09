using HomeHub.Api.Meals;

namespace HomeHub.Tests;

/// <summary>
/// Flattening a fetched page into the text a person would have copied off it.
/// </summary>
/// <remarks>
/// This exists so a page that fetches fine but publishes no schema.org markup can still be read —
/// personal blogs, older sites, anything not built on a recipe plugin. It is the second reading of
/// bytes the panel already holds, never a second fetch, and never a way to a page that was refused.
/// </remarks>
public class HtmlToTextTests
{
    /// <summary>
    /// List items must become lines.
    /// </summary>
    /// <remarks>
    /// The single most important thing here: an ingredient list is one `li` per ingredient, and a
    /// flattener that loses those boundaries welds nine ingredients into one unreadable line that
    /// parses as nothing.
    /// </remarks>
    [Fact]
    public void List_items_become_their_own_lines()
    {
        var text = HtmlToText.Flatten("<ul><li>2 cups flour</li><li>1 tsp salt</li></ul>")!;

        Assert.Equal(["2 cups flour", "1 tsp salt"], text.Split('\n'));
    }

    [Theory]
    [InlineData("<p>One</p><p>Two</p>")]
    [InlineData("<div>One</div><div>Two</div>")]
    [InlineData("One<br>Two")]
    [InlineData("<h2>One</h2><h3>Two</h3>")]
    public void Block_elements_break_the_line(string html)
    {
        Assert.Equal(["One", "Two"], HtmlToText.Flatten(html)!.Split('\n'));
    }

    /// <summary>
    /// A nav full of `li` would otherwise arrive as a very convincing ingredient list.
    /// </summary>
    [Fact]
    public void Navigation_and_scripts_are_dropped_whole()
    {
        const string html = """
            <nav><ul><li>Home</li><li>Recipes</li></ul></nav>
            <script>var recipe = "not this";</script>
            <style>.x{content:"nor this"}</style>
            <main><h1>Pancakes</h1><ul><li>2 cups flour</li></ul></main>
            <footer><p>Copyright 2026</p></footer>
            """;

        var text = HtmlToText.Flatten(html)!;

        Assert.Contains("Pancakes", text);
        Assert.Contains("2 cups flour", text);
        Assert.DoesNotContain("not this", text);
        Assert.DoesNotContain("nor this", text);
        Assert.DoesNotContain("Copyright", text);
        // The nav's own list items must not survive as ingredients.
        Assert.DoesNotContain("Recipes", text);
    }

    [Fact]
    public void Entities_are_decoded_and_inline_tags_do_not_weld_words()
    {
        var text = HtmlToText.Flatten("<p>Fry <b>hot</b>&nbsp;&amp; fast. Use &frac12; tsp.</p>")!;

        Assert.Equal("Fry hot & fast. Use ½ tsp.", text);
    }

    [Fact]
    public void Comments_cannot_smuggle_markup_through()
    {
        var text = HtmlToText.Flatten("<p>Real</p><!-- <li>ghost ingredient</li> --><p>Also real</p>")!;

        Assert.DoesNotContain("ghost", text);
        Assert.Equal(["Real", "Also real"], text.Split('\n'));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("<div></div><p>  </p>")]
    [InlineData("<script>only()</script>")]
    public void A_page_with_no_text_flattens_to_nothing(string? html)
    {
        Assert.Null(HtmlToText.Flatten(html));
    }

    /// <summary>
    /// End to end: markup with no JSON-LD anywhere still yields a scalable recipe.
    /// </summary>
    /// <remarks>
    /// The pairing this was built for — the flattener hands the paste parser exactly the shape it
    /// already knows how to read, so nothing new had to learn about recipes.
    /// </remarks>
    [Fact]
    public void A_page_with_no_structured_data_still_parses_into_a_recipe()
    {
        const string html = """
            <html><head><title>Blog</title></head><body>
            <nav><ul><li>Home</li><li>About</li></ul></nav>
            <article>
              <h1>Buttermilk Pancakes</h1>
              <p>Serves 4</p>
              <h2>Ingredients</h2>
              <ul>
                <li>2 cups plain flour</li>
                <li>2 tbsp caster sugar</li>
                <li>300 ml buttermilk</li>
              </ul>
              <h2>Method</h2>
              <ol>
                <li>Whisk the dry ingredients together in a large bowl and make a well in the centre.</li>
                <li>Pour in the buttermilk and whisk from the middle outwards until the batter is smooth.</li>
              </ol>
            </article>
            <footer><p>Nutrition Facts</p><p>Calories 250</p></footer>
            </body></html>
            """;

        var result = PastedRecipeImporter.Parse(HtmlToText.Flatten(html)!, "https://example.test/pancakes");

        Assert.Equal(ImportConfidence.Complete, result.Confidence);
        Assert.Equal("Buttermilk Pancakes", result.Recipe!.Title);
        Assert.Equal(4, result.Recipe.Servings);
        Assert.Equal(3, result.Recipe.Ingredients!.Count);
        Assert.Equal(2, result.Recipe.Steps!.Count);
        // The point of all of it: the amounts came through, so the recipe scales.
        Assert.All(result.Recipe.Ingredients, i => Assert.NotNull(i.Quantity));
    }

    /// <summary>
    /// A refusal body is not a recipe, and must not be read as one.
    /// </summary>
    /// <remarks>
    /// This is what allrecipes returns — six hundred bytes of licensing notice behind a 402. The
    /// fetcher stops before the fallback ever sees it, but if that ever changed, the fallback must
    /// still decline rather than name a recipe after the first sentence of the notice.
    /// </remarks>
    [Fact]
    public void A_licensing_notice_does_not_become_a_recipe()
    {
        const string html = """
            <p>If you are a reader experiencing an access issue, please contact
            <a href="mailto:support@people.inc">support@people.inc</a>.</p>
            <p>If you would like to access our content for licensing, please contact
            <a href="mailto:contentlicensing@people.inc">contentlicensing@people.inc</a>.</p>
            """;

        var result = PastedRecipeImporter.Parse(HtmlToText.Flatten(html)!, "https://www.allrecipes.com/recipe/1/x/");

        Assert.Equal(ImportConfidence.Empty, result.Confidence);
        Assert.Null(result.Recipe);
    }
}
