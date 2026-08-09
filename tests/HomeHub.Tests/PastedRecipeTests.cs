using HomeHub.Api.Meals;

namespace HomeHub.Tests;

/// <summary>
/// The paste path, which exists because the fetcher cannot read every publisher.
/// </summary>
/// <remarks>
/// allrecipes, Serious Eats and Simply Recipes all answer <c>402</c> to any client. The household
/// reads the page in their own browser and pastes what they see; these tests use the shape that copy
/// actually produces, headings, `Step 1` markers, furniture and all.
/// </remarks>
public class PastedRecipeTests
{
    /// <summary>What a straight copy off an allrecipes page looks like on the clipboard.</summary>
    private const string AllrecipesBlock = """
        Taco Seasoning I

        Prep Time: 5 mins
        Total Time: 5 mins
        Servings: 5

        Ingredients

        1 tablespoon chili powder
        ¼ teaspoon garlic powder
        ¼ teaspoon onion powder
        ¼ teaspoon crushed red pepper flakes
        ¼ teaspoon dried oregano
        ½ teaspoon paprika
        1 ½ teaspoons ground cumin
        1 teaspoon sea salt
        1 teaspoon black pepper

        Directions

        Step 1
        Combine chili powder, garlic powder, onion powder, red pepper flakes, oregano, paprika, cumin, salt, and pepper in a small bowl; mix well.

        Step 2
        Store in an airtight container.

        Nutrition Facts
        Calories 21
        """;

    /// <summary>
    /// What a <b>whole-page</b> copy looks like — select-all rather than a tidy selection.
    /// </summary>
    /// <remarks>
    /// This is what people actually do, and it drags the nav, the ad slots and the rating widget in
    /// ahead of the recipe.
    /// </remarks>
    private const string WholePageBlock = """
        Skip to content
        Allrecipes
        Search
        Log In
        My Account
        Ad
        Taco Seasoning I
        4.6
        (1,234)
        1,234 Ratings
        Submitted by Bill Echols
        Updated on March 4, 2024
        Save
        Rate
        Print
        Share
        Add Photo
        Prep Time: 5 mins
        Total Time: 5 mins
        Servings: 5
        Ingredients
        1 tablespoon chili powder
        ¼ teaspoon garlic powder
        1 ½ teaspoons ground cumin
        1 teaspoon sea salt
        Directions
        Step 1
        Combine chili powder, garlic powder, cumin, and salt in a small bowl; mix well.
        Nutrition Facts
        Calories 21
        """;

    /// <summary>
    /// The bug this was reported for: a whole-page copy named the recipe `Ad`.
    /// </summary>
    /// <remarks>
    /// `Ad` sits directly above the title on allrecipes, and "the first line that is not an amount"
    /// picked it. Two characters, no punctuation, no quantity — it looked exactly like a name.
    /// </remarks>
    [Fact]
    public void A_whole_page_copy_is_not_named_after_an_ad_slot()
    {
        var recipe = PastedRecipeImporter.Parse(WholePageBlock).Recipe!;

        Assert.Equal("Taco Seasoning I", recipe.Title);
    }

    [Fact]
    public void A_whole_page_copy_still_finds_the_recipe_inside_it()
    {
        var result = PastedRecipeImporter.Parse(WholePageBlock);

        Assert.Equal(ImportConfidence.Complete, result.Confidence);
        Assert.Equal(4, result.Recipe!.Ingredients!.Count);
        Assert.Single(result.Recipe.Steps!);
        Assert.Equal(5, result.Recipe.Servings);
        Assert.All(result.Recipe.Ingredients, i => Assert.NotNull(i.Quantity));
    }

    /// <summary>The rating widget is numbers; the ingredient parser would read them as amounts.</summary>
    [Fact]
    public void The_rating_widget_does_not_become_an_ingredient()
    {
        var recipe = PastedRecipeImporter.Parse(WholePageBlock).Recipe!;

        Assert.DoesNotContain(recipe.Ingredients!, i => i.RawText.Contains("1,234"));
        Assert.DoesNotContain(recipe.Ingredients!, i => i.RawText.StartsWith("4.6", StringComparison.Ordinal));
        Assert.DoesNotContain(recipe.Steps!, s => s.Text.Contains("Ratings"));
    }

    /// <summary>
    /// Chrome is matched whole, never as a prefix.
    /// </summary>
    /// <remarks>
    /// `Save`, `Share` and `Rate` are buttons on their own line and ordinary English at the start of
    /// an instruction. Prefix-matching them — which the first cut of this did — silently deleted
    /// steps.
    /// </remarks>
    [Fact]
    public void A_step_beginning_with_a_chrome_word_survives()
    {
        const string block = """
            Pan Sauce
            Ingredients
            2 tbsp butter
            1 cup stock
            Directions
            Save the pan drippings, then pour off all but a tablespoon of the rendered fat.
            Share among four warmed bowls and finish each with a knob of the cold butter.
            Rate the heat down to low before the cream goes anywhere near the pan.
            """;

        var steps = PastedRecipeImporter.Parse(block).Recipe!.Steps!;

        Assert.Equal(3, steps.Count);
        Assert.StartsWith("Save the pan drippings", steps[0].Text);
        Assert.StartsWith("Share among four", steps[1].Text);
        Assert.StartsWith("Rate the heat down", steps[2].Text);
    }

    /// <summary>
    /// The print view, which is the tidier way to copy and so the one worth getting right.
    /// </summary>
    /// <remarks>
    /// Print CSS drops the nav and the comments, but brings its own shape: checkbox glyphs beside
    /// every ingredient, `8 servings` rather than `Servings: 8`, the page's address in the footer,
    /// and `Nutrition Facts (per serving)` — four words longer than the whole-line heading that was
    /// meant to cut the tail off.
    /// </remarks>
    private const string PrintViewBlock = """
        Allrecipes

        Slider-Style Mini Burgers

        Prep Time: 20 mins
        Cook Time: 15 mins
        Total Time: 35 mins
        8 servings

        Ingredients
        ▢ 1 pound ground beef
        ▢ ½ teaspoon salt
        ▢ 1 tablespoon Worcestershire sauce
        • 8 slider buns, split

        Directions
        1. Preheat a grill for medium-high heat and lightly oil the grate before cooking.
        2. Mix beef, salt, and Worcestershire sauce in a bowl until evenly combined.

        Nutrition Facts (per serving)
        Calories 310
        Total Fat 18g
        https://www.allrecipes.com/recipe/178295/slider-style-mini-burgers/
        © 2026 Allrecipes. All rights reserved.
        """;

    [Fact]
    public void A_print_view_paste_reads_as_a_complete_recipe()
    {
        var result = PastedRecipeImporter.Parse(PrintViewBlock);

        Assert.Equal(ImportConfidence.Complete, result.Confidence);
        Assert.Equal("Slider-Style Mini Burgers", result.Recipe!.Title);
        Assert.Equal(4, result.Recipe.Ingredients!.Count);
        Assert.Equal(2, result.Recipe.Steps!.Count);
    }

    /// <summary>
    /// Checkbox glyphs must come off before the amount is read, or nothing scales.
    /// </summary>
    /// <remarks>
    /// To the ingredient parser `▢ 1 pound ground beef` has no leading amount at all — it bails, and
    /// the line is saved raw. The recipe would look perfect and scale not one line.
    /// </remarks>
    [Fact]
    public void Checkbox_and_bullet_markers_do_not_stop_the_amounts_being_read()
    {
        var ingredients = PastedRecipeImporter.Parse(PrintViewBlock).Recipe!.Ingredients!;

        Assert.All(ingredients, i => Assert.NotNull(i.Quantity));
        Assert.DoesNotContain(ingredients, i => i.RawText.StartsWith('▢') || i.RawText.StartsWith('•'));

        var beef = ingredients.Single(i => i.RawText.Contains("ground beef"));
        Assert.Equal(1m, beef.Quantity);
        Assert.Equal("lb", beef.Unit);
    }

    /// <summary>`8 servings`, not `Servings: 8` — the print view sets it the other way round.</summary>
    [Fact]
    public void Servings_are_read_in_either_order()
    {
        Assert.Equal(8, PastedRecipeImporter.Parse(PrintViewBlock).Recipe!.Servings);
    }

    /// <summary>
    /// `Nutrition Facts (per serving)` has to cut the tail off just as the bare heading does.
    /// </summary>
    [Fact]
    public void The_print_views_nutrition_table_and_footer_are_cut_off()
    {
        var recipe = PastedRecipeImporter.Parse(PrintViewBlock).Recipe!;

        Assert.DoesNotContain(recipe.Steps!, s => s.Text.Contains("Calories"));
        Assert.DoesNotContain(recipe.Steps!, s => s.Text.Contains("Total Fat"));
        Assert.DoesNotContain(recipe.Steps!, s => s.Text.Contains("rights reserved"));
        Assert.DoesNotContain(recipe.Ingredients!, i => i.RawText.Contains("Calories"));
    }

    /// <summary>
    /// The print view prints the page's address, and the link box will be empty — it is the link
    /// that refused to import in the first place.
    /// </summary>
    [Fact]
    public void The_address_in_the_footer_becomes_the_recipes_source()
    {
        var recipe = PastedRecipeImporter.Parse(PrintViewBlock).Recipe!;

        Assert.Equal("https://www.allrecipes.com/recipe/178295/slider-style-mini-burgers/", recipe.SourceUrl);
        Assert.Equal("allrecipes.com", recipe.SourceName);
        // …and it is provenance, not content.
        Assert.DoesNotContain(recipe.Ingredients!, i => i.RawText.Contains("http"));
        Assert.DoesNotContain(recipe.Steps!, s => s.Text.Contains("http"));
    }

    /// <summary>A supplied link still wins — the box is the household saying which page this is.</summary>
    [Fact]
    public void A_supplied_link_beats_one_found_in_the_text()
    {
        var recipe = PastedRecipeImporter
            .Parse(PrintViewBlock, "https://www.budgetbytes.com/sliders/").Recipe!;

        Assert.Equal("https://www.budgetbytes.com/sliders/", recipe.SourceUrl);
    }

    /// <summary>
    /// Short end-headings are matched whole, because they are ordinary words in a method.
    /// </summary>
    /// <remarks>
    /// `Tips` ends a recipe; `Tips of the asparagus should be trimmed` is step three. Prefix-matching
    /// the short ones would have thrown away the rest of the method.
    /// </remarks>
    [Fact]
    public void A_step_beginning_with_an_end_heading_word_does_not_truncate_the_recipe()
    {
        const string block = """
            Roast Asparagus
            Ingredients
            500 g asparagus
            2 tbsp olive oil
            Directions
            Tips of the asparagus should be trimmed and the woody ends snapped off before roasting.
            Notes about seasoning: hold the salt back until the spears come out of the oven.
            Roast for twelve minutes until the spears have taken a little colour at the edges.
            """;

        var steps = PastedRecipeImporter.Parse(block).Recipe!.Steps!;

        Assert.Equal(3, steps.Count);
        Assert.StartsWith("Tips of the asparagus", steps[0].Text);
    }

    [Fact]
    public void An_allrecipes_paste_reads_as_a_complete_recipe()
    {
        var result = PastedRecipeImporter.Parse(
            AllrecipesBlock, "https://www.allrecipes.com/recipe/46653/taco-seasoning-i/");

        Assert.Equal(ImportConfidence.Complete, result.Confidence);
        Assert.NotNull(result.Recipe);
        Assert.Equal("Taco Seasoning I", result.Recipe!.Title);
        Assert.Equal(9, result.Recipe.Ingredients!.Count);
        Assert.Equal(2, result.Recipe.Steps!.Count);
    }

    /// <summary>
    /// The whole reason this exists: pasted ingredients must carry amounts, or they cannot scale.
    /// </summary>
    /// <remarks>
    /// The paste box that predated this stored every line as raw text with null quantities. It read
    /// perfectly and scaled not at all — doubling the recipe left every line untouched.
    /// </remarks>
    [Fact]
    public void Pasted_ingredients_carry_amounts_so_the_recipe_scales()
    {
        var ingredients = PastedRecipeImporter.Parse(AllrecipesBlock).Recipe!.Ingredients!;

        var chilli = ingredients.Single(i => i.RawText.Contains("chili powder"));
        Assert.Equal(1m, chilli.Quantity);
        Assert.Equal("tbsp", chilli.Unit);
        Assert.Equal("chili powder", chilli.Name);

        // The vulgar fraction and the mixed number are the two shapes recipe sites emit most.
        Assert.Equal(0.25m, ingredients.Single(i => i.RawText.Contains("garlic")).Quantity);
        Assert.Equal(1.5m, ingredients.Single(i => i.RawText.Contains("cumin")).Quantity);

        // Every line scaled, not most of them.
        Assert.All(ingredients, i => Assert.NotNull(i.Quantity));
    }

    [Fact]
    public void Servings_and_times_come_off_the_metadata_rows()
    {
        var recipe = PastedRecipeImporter.Parse(AllrecipesBlock).Recipe!;

        Assert.Equal(5, recipe.Servings);
        Assert.Equal(5, recipe.PrepMinutes);
        Assert.Equal(5, recipe.TotalMinutes);
    }

    /// <summary>Those rows sit between the title and the ingredients — they must not become lines.</summary>
    [Fact]
    public void Metadata_rows_do_not_become_ingredients_or_steps()
    {
        var recipe = PastedRecipeImporter.Parse(AllrecipesBlock).Recipe!;

        Assert.DoesNotContain(recipe.Ingredients!, i => i.RawText.Contains("Time", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(recipe.Ingredients!, i => i.RawText.Contains("Servings", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(recipe.Steps!, s => s.Text.Contains("Servings", StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// `Step 1` is the page's list markup. Left in, the cook view numbers every step twice.
    /// </summary>
    [Fact]
    public void Step_numbering_is_stripped()
    {
        var recipe = PastedRecipeImporter.Parse(AllrecipesBlock).Recipe!;

        Assert.StartsWith("Combine chili powder", recipe.Steps![0].Text);
        Assert.StartsWith("Store in an airtight", recipe.Steps[1].Text);
        Assert.DoesNotContain(recipe.Steps, s => s.Text.StartsWith("Step", StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>The article carries on past the recipe; the copy nearly always drags some of it in.</summary>
    [Fact]
    public void The_tail_of_the_article_is_cut_off()
    {
        var recipe = PastedRecipeImporter.Parse(AllrecipesBlock).Recipe!;

        Assert.DoesNotContain(recipe.Steps!, s => s.Text.Contains("Calories"));
        Assert.DoesNotContain(recipe.Ingredients!, i => i.RawText.Contains("Calories"));
    }

    /// <summary>Inline numbering is as common as `Step 1`, and means the same thing.</summary>
    [Fact]
    public void Inline_numbering_is_stripped_too()
    {
        const string block = """
            Ingredients
            2 cups flour
            1 cup milk
            Method
            1. Whisk the flour and the milk together until no lumps remain in the batter.
            2. Rest the batter for thirty minutes, then cook in a hot buttered pan.
            """;

        var recipe = PastedRecipeImporter.Parse(block).Recipe!;

        Assert.Equal(2, recipe.Steps!.Count);
        Assert.StartsWith("Whisk the flour", recipe.Steps[0].Text);
        Assert.StartsWith("Rest the batter", recipe.Steps[1].Text);
    }

    /// <summary>
    /// With no headings at all, the split is where short amount-led lines give way to prose.
    /// </summary>
    [Fact]
    public void A_block_with_no_headings_splits_on_shape()
    {
        const string block = """
            Buttermilk Pancakes
            2 cups plain flour
            2 tbsp caster sugar
            1 tsp baking powder
            300 ml buttermilk
            Whisk the dry ingredients together in a large bowl and make a well in the centre.
            Pour in the buttermilk and whisk from the middle outwards until the batter is smooth.
            """;

        var result = PastedRecipeImporter.Parse(block);

        Assert.Equal("Buttermilk Pancakes", result.Recipe!.Title);
        Assert.Equal(4, result.Recipe.Ingredients!.Count);
        Assert.Equal(2, result.Recipe.Steps!.Count);
    }

    /// <summary>
    /// A long ingredient is still an ingredient.
    /// </summary>
    /// <remarks>
    /// The shape split cannot key on length alone: "2 pounds beef chuck, cut into 1-inch cubes and
    /// patted thoroughly dry" is longer than plenty of steps. A line the ingredient parser can read
    /// an amount from is never the start of the method.
    /// </remarks>
    [Fact]
    public void A_long_ingredient_does_not_start_the_method()
    {
        const string block = """
            Beef Stew
            2 pounds beef chuck, cut into 1-inch cubes and patted thoroughly dry before browning
            1 tbsp oil
            Brown the beef in batches, taking care not to crowd the pan at any point.
            Add the stock and simmer gently for two hours until the meat gives way completely.
            """;

        var recipe = PastedRecipeImporter.Parse(block).Recipe!;

        Assert.Equal(2, recipe.Ingredients!.Count);
        Assert.Contains(recipe.Ingredients, i => i.RawText.StartsWith("2 pounds beef chuck", StringComparison.Ordinal));
        Assert.Equal(2, recipe.Steps!.Count);
    }

    /// <summary>`For the sauce:` groups the lines under it, which the edit screen already renders.</summary>
    [Fact]
    public void Sub_headings_group_the_ingredients_under_them()
    {
        const string block = """
            Lasagne
            Ingredients
            For the ragu:
            500 g beef mince
            1 onion, finely diced
            For the white sauce:
            50 g butter
            50 g plain flour
            Directions
            Brown the mince, then add the onion and cook until it has softened completely.
            """;

        var recipe = PastedRecipeImporter.Parse(block).Recipe!;

        Assert.Equal(4, recipe.Ingredients!.Count);
        Assert.Equal("For the ragu", recipe.Ingredients[0].SectionHeading);
        Assert.Equal("For the white sauce", recipe.Ingredients[2].SectionHeading);
        // The heading lines themselves are not ingredients.
        Assert.DoesNotContain(recipe.Ingredients, i => i.RawText.StartsWith("For the", StringComparison.Ordinal));
    }

    /// <summary>`1 hr 25 mins` is the shape allrecipes prints; minutes are what the panel stores.</summary>
    [Fact]
    public void Compound_durations_become_minutes()
    {
        const string block = """
            Slow Roast Pork
            Prep Time: 20 mins
            Cook Time: 3 hrs 30 mins
            Ingredients
            2 kg pork shoulder
            1 tbsp salt
            Directions
            Roast low and slow until the meat pulls away from the bone without any resistance.
            """;

        var recipe = PastedRecipeImporter.Parse(block).Recipe!;

        Assert.Equal(20, recipe.PrepMinutes);
        Assert.Equal(210, recipe.CookMinutes);
        // Not stated, so derived from the two halves rather than left null.
        Assert.Equal(230, recipe.TotalMinutes);
    }

    /// <summary>Missing halves are named, not guessed at — the same contract as the URL importer.</summary>
    [Fact]
    public void A_block_with_no_method_saves_partial_and_says_so()
    {
        const string block = """
            Spice Rub
            Ingredients
            2 tbsp paprika
            1 tbsp black pepper
            """;

        var result = PastedRecipeImporter.Parse(block);

        Assert.Equal(ImportConfidence.Partial, result.Confidence);
        Assert.Equal(2, result.Recipe!.Ingredients!.Count);
        Assert.Contains("method", result.Reason);
    }

    [Fact]
    public void Text_that_is_not_a_recipe_is_refused_rather_than_saved()
    {
        var result = PastedRecipeImporter.Parse("hello there");

        Assert.Equal(ImportConfidence.Empty, result.Confidence);
        Assert.Null(result.Recipe);
        Assert.Contains("doesn't look like a recipe", result.Reason);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("\n\n\n")]
    public void An_empty_paste_is_refused(string text)
    {
        Assert.Equal(ImportConfidence.Empty, PastedRecipeImporter.Parse(text).Confidence);
    }

    /// <summary>The link is kept for attribution. It is never fetched — that is the point.</summary>
    [Fact]
    public void The_source_link_is_kept_as_provenance()
    {
        var recipe = PastedRecipeImporter
            .Parse(AllrecipesBlock, "https://www.allrecipes.com/recipe/46653/taco-seasoning-i/").Recipe!;

        Assert.Equal("https://www.allrecipes.com/recipe/46653/taco-seasoning-i/", recipe.SourceUrl);
        Assert.Equal("allrecipes.com", recipe.SourceName);
    }

    /// <summary>A title typed into the box wins over anything guessed off the top of the block.</summary>
    [Fact]
    public void A_supplied_title_wins()
    {
        var recipe = PastedRecipeImporter.Parse(AllrecipesBlock, null, "Nana's taco mix").Recipe!;
        Assert.Equal("Nana's taco mix", recipe.Title);
    }

    /// <summary>Copied pages bring their furniture; none of it is an ingredient.</summary>
    [Fact]
    public void Page_furniture_is_dropped()
    {
        const string block = """
            Quick Salsa
            Add all ingredients to shopping list
            Ingredients
            2 tomatoes, diced
            1 tsp salt
            Cook Mode
            Prevent your screen from going dark
            Directions
            Stir everything together in a bowl and leave it to sit for ten minutes before serving.
            """;

        var recipe = PastedRecipeImporter.Parse(block).Recipe!;

        Assert.Equal(2, recipe.Ingredients!.Count);
        Assert.DoesNotContain(recipe.Ingredients, i => i.RawText.Contains("shopping list"));
        Assert.DoesNotContain(recipe.Ingredients, i => i.RawText.Contains("screen"));
    }
}
