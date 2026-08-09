namespace HomeHub.Tests;

using System.Net.Http.Json;
using HomeHub.Api.Meals;
using HomeHub.Api.Pantry;

/// <summary>
/// Canonical units: the fold, the seed table's own consistency, and the round trip through every
/// surface that takes a typed unit.
/// </summary>
/// <remarks>
/// The failures here are all silent ones. A pantry storing "ounces" beside a recipe storing "oz" is
/// not an error anywhere — it is a stock check that quietly cannot join the two and reports a
/// shortfall on a shelf that is full. Nothing throws, so nothing shows up without a test.
/// </remarks>
public class MeasurementUnitTests
{
    // ---- the fold ----

    [Theory]
    [InlineData("oz", "oz")]
    [InlineData("OZ", "oz")]
    [InlineData("Oz.", "oz")]
    [InlineData("  ounces  ", "ounces")]
    [InlineData("tsp.", "tsp")]
    [InlineData("fl.  oz.", "fl oz")]
    [InlineData("   ", "")]
    public void Folds_the_way_the_alias_table_is_keyed(string input, string expected)
    {
        Assert.Equal(expected, UnitRegistry.Fold(input));
    }

    // ---- the seed ----

    /// <summary>
    /// One spelling means one unit. A duplicate here would not fail the build — it would fail the
    /// <i>migration</i>, on somebody's live database, against a unique index.
    /// </summary>
    [Fact]
    public void No_spelling_is_claimed_by_two_units()
    {
        var duplicates = UnitSeed.Aliases
            .GroupBy(a => a.Alias, StringComparer.OrdinalIgnoreCase)
            .Where(g => g.Count() > 1)
            .Select(g => g.Key)
            .ToList();

        Assert.Empty(duplicates);
    }

    /// <summary>
    /// Every unit answers to its own spelling. Lookup goes through the alias table alone, so a
    /// canonical form missing from it is a unit that cannot be found by typing its own name — and
    /// would be adopted a second time as a duplicate row the moment somebody did.
    /// </summary>
    [Fact]
    public void Every_unit_answers_to_its_own_name()
    {
        foreach (var unit in UnitSeed.Units)
        {
            var folded = UnitRegistry.Fold(unit.Canonical);
            Assert.Contains(UnitSeed.Aliases, a => a.UnitId == unit.Id && a.Alias == folded);
        }
    }

    /// <summary>
    /// Naming a unit is not claiming it converts — but a seeded unit the conversion table has never
    /// heard of degrades every line that uses it, silently. The two tables are kept in step, and
    /// this says which way: anything countable or on a fixed ratio must be reachable.
    /// </summary>
    [Theory]
    [InlineData("fl oz")]
    [InlineData("gallon")]
    [InlineData("bottle")]
    [InlineData("loaf")]
    public void Seeded_units_the_conversion_table_should_know_are_reachable(string canonical)
    {
        Assert.True(
            UnitConversion.IsCountable(canonical) || UnitConversion.Convert(1m, canonical, canonical) is not null,
            $"{canonical} is offered but converts to nothing, so every line using it degrades.");
    }

    // ---- the round trip ----

    /// <summary>
    /// The headline: four spellings of one unit are stored once. Case, plurals and a trailing period
    /// all land on the same <c>oz</c>, so the list does not grow a second ounce.
    /// </summary>
    [Theory]
    [InlineData("ounces", "oz")]
    [InlineData("OZ", "oz")]
    [InlineData("Oz.", "oz")]
    [InlineData("pounds", "lb")]
    [InlineData("Grams", "g")]
    [InlineData("milliliters", "mL")]
    [InlineData("tablespoons", "tbsp")]
    [InlineData("each", "ea")]
    public async Task A_typed_unit_is_stored_canonically(string typed, string stored)
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/pantry", new PantryItemInput(
            "Butter, unsalted", "Fridge", "Counted", 2, typed, null, ProfileId: 1));
        res.EnsureSuccessStatusCode();
        var item = await res.Content.ReadFromJsonAsync<PantryItemDto>();

        Assert.Equal(stored, item!.Unit);
    }

    /// <summary>
    /// Free text is a normal answer, not a failure — and it joins the list, so the second person to
    /// reach for it is offered it rather than having to spell it the same way from memory.
    /// </summary>
    [Fact]
    public async Task A_unit_nobody_predefined_is_kept_and_offered_back()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await client.PostAsJsonAsync("/api/pantry", new PantryItemInput(
            "Digestives", "Cupboard", "Counted", 2, "Sleeves", null, ProfileId: 1));

        var units = await client.GetFromJsonAsync<List<MeasurementUnitDto>>("/api/units");
        var adopted = Assert.Single(units!, u => u.Canonical == "sleeves");

        Assert.False(adopted.IsSeeded);
        // No spelled-out form invented for it — "sleeves" is already the household's whole word.
        Assert.Null(adopted.DisplayName);
        // And it answers to itself, so typing it again finds this row rather than adding another.
        Assert.Contains("sleeves", adopted.Aliases);
    }

    /// <summary>
    /// The same new word on three lines of one recipe adds one unit, not three. Within a request the
    /// registry has to remember what it just adopted, because none of it is in the database yet.
    /// </summary>
    [Fact]
    public async Task The_same_new_unit_twice_in_one_save_is_one_unit()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/recipes", new RecipeInput(
            "Toast",
            Ingredients:
            [
                new RecipeIngredientInput("1 rasher bacon", 1, "rasher"),
                new RecipeIngredientInput("2 rashers bacon", 2, "Rashers"),
                new RecipeIngredientInput("3 rashers bacon", 3, "RASHER."),
            ]));
        res.EnsureSuccessStatusCode();

        var units = await client.GetFromJsonAsync<List<MeasurementUnitDto>>("/api/units");

        Assert.Single(units!, u => u.Canonical == "rasher");
        // "Rashers" is a different word, kept apart: the seed merges inflections it was told about,
        // never ones it guesses. What matters is that neither is stored twice.
        Assert.Single(units!, u => u.Canonical == "rashers");
    }

    /// <summary>
    /// The whole point, end to end: a shelf and a recipe that spell the unit differently arrive at
    /// the same stored word, which is what lets the stock check compare them at all.
    /// </summary>
    [Fact]
    public async Task A_recipe_and_a_shelf_spell_the_unit_the_same_way()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var shelf = await (await client.PostAsJsonAsync("/api/pantry", new PantryItemInput(
            "Parmesan", "Fridge", "Counted", 8, "Ounces", null, ProfileId: 1)))
            .Content.ReadFromJsonAsync<PantryItemDto>();

        var recipe = await (await client.PostAsJsonAsync("/api/recipes", new RecipeInput(
            "Cacio e pepe",
            Ingredients: [new RecipeIngredientInput("4 oz. parmesan", 4, "OZ.")])))
            .Content.ReadFromJsonAsync<RecipeDto>();

        Assert.Equal("oz", shelf!.Unit);
        Assert.Equal("oz", recipe!.Ingredients.Single().Unit);
        // And the conversion table, which is what the stock check actually asks, now has an answer.
        Assert.Equal(4m, UnitConversion.Convert(4m, recipe.Ingredients.Single().Unit, shelf.Unit));
    }

    /// <summary>A grocery line goes through the same normaliser as everything else.</summary>
    [Fact]
    public async Task A_grocery_line_stores_the_canonical_unit()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/grocery", new GroceryInput(
            "Flour", 2, "Pounds", null, null, null, null, null, 1));
        res.EnsureSuccessStatusCode();
        var line = await res.Content.ReadFromJsonAsync<GroceryLineDto>();

        Assert.Equal("lb", line!.Unit);
    }

    /// <summary>
    /// The list is offered predefined-first, in reach-for-it order rather than alphabetically — "ea,
    /// tsp, tbsp, cup" is a better opening hand than "bag, bottle, box, bunch".
    /// </summary>
    [Fact]
    public async Task The_list_is_offered_in_reach_for_it_order()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await client.PostAsJsonAsync("/api/pantry", new PantryItemInput(
            "Digestives", "Cupboard", "Counted", 2, "sleeve", null, ProfileId: 1));

        var units = await client.GetFromJsonAsync<List<MeasurementUnitDto>>("/api/units");

        Assert.Equal(["ea", "tsp", "tbsp", "cup"], units!.Take(4).Select(u => u.Canonical));
        Assert.Equal("sleeve", units![^1].Canonical);
    }

    /// <summary>
    /// Nothing typed is a real answer, not a missing one. Most of a pantry is counted in bare
    /// numbers — "2 eggs", "6 lemons" — and inventing a unit for them would put a word on the row
    /// that nobody chose.
    /// </summary>
    [Fact]
    public async Task No_unit_stays_no_unit()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/pantry", new PantryItemInput(
            "Lemons", "Fridge", "Counted", 6, "   ", null, ProfileId: 1));
        var item = await res.Content.ReadFromJsonAsync<PantryItemDto>();

        Assert.Null(item!.Unit);
        var units = await client.GetFromJsonAsync<List<MeasurementUnitDto>>("/api/units");
        Assert.DoesNotContain(units!, u => u.Canonical.Trim().Length == 0);
    }
}
