namespace HomeHub.Tests;

using System.Net.Http.Json;
using HomeHub.Api.Meals;
using HomeHub.Api.Pantry;

/// <summary>
/// Packages: the size of one, the count of them, and the difference between the two.
/// </summary>
/// <remarks>
/// Every failure in here is a plausible-looking number. Five 3 oz pots read as "5 oz", or as "15 oz"
/// on a row nobody can check against the fridge, or as five separate rows saying 3 oz — none of them
/// throws, and all of them look like a shelf list until somebody counts.
/// </remarks>
public class PantryPackTests
{
    private static async Task<PantryItemDto> AddAsync(
        HttpClient client, string name, decimal quantity, decimal? packSize = null,
        string? packUnit = null, string? unit = null) =>
        (await (await client.PostAsJsonAsync("/api/pantry", new PantryItemInput(
            name, "Fridge", "Counted", quantity, unit, null, ProfileId: 1,
            PackSize: packSize, PackUnit: packUnit))).Content.ReadFromJsonAsync<PantryItemDto>())!;

    // ---- the arithmetic ----

    /// <summary>Five 3 oz pots is fifteen ounces, and the unit compared against is the pack's.</summary>
    [Fact]
    public void A_packaged_shelf_holds_the_count_times_the_size()
    {
        var item = new PantryItem { Quantity = 5, PackSize = 3, PackUnit = "oz", Unit = "containers" };

        Assert.True(PantryAmounts.IsPackaged(item));
        Assert.Equal(15m, PantryAmounts.OnHand(item));
        // `Unit` names the container. Comparing "4 oz" against a count of containers is the
        // conversion that has no honest answer, so it is never the one offered.
        Assert.Equal("oz", PantryAmounts.MeasureUnit(item));
    }

    /// <summary>A loose row behaves exactly as it did before packages existed.</summary>
    [Fact]
    public void A_loose_shelf_is_read_as_it_always_was()
    {
        var item = new PantryItem { Quantity = 500, Unit = "g" };

        Assert.False(PantryAmounts.IsPackaged(item));
        Assert.Equal(500m, PantryAmounts.OnHand(item));
        Assert.Equal("g", PantryAmounts.MeasureUnit(item));
    }

    /// <summary>
    /// An amount comes back as packs, fractions and all. Rounding up would report a pot gone that is
    /// still more than half full — and then offer to put it on the shopping list.
    /// </summary>
    [Fact]
    public void An_amount_converts_back_into_a_fraction_of_a_package()
    {
        var item = new PantryItem { Quantity = 5, PackSize = 3, PackUnit = "oz" };

        Assert.Equal(4m / 3m, PantryAmounts.ToQuantity(item, 4m), precision: 6);
        Assert.Equal(4m, PantryAmounts.ToQuantity(new PantryItem { Quantity = 5, Unit = "oz" }, 4m));
    }

    /// <summary>
    /// Size is part of what the row is. A 3 oz pot and a 32 oz tub share a name and are two
    /// different things to run out of.
    /// </summary>
    [Fact]
    public void Two_sizes_of_one_product_are_not_the_same_product()
    {
        var pot = new PantryItem { Name = "Yogurt", PackSize = 3, PackUnit = "oz" };

        Assert.True(PantryAmounts.SameProduct(pot, "yogurt", 3, "oz"));
        Assert.False(PantryAmounts.SameProduct(pot, "Yogurt", 32, "oz"));
        Assert.False(PantryAmounts.SameProduct(pot, "Yogurt", null, null));
    }

    // ---- over HTTP ----

    [Fact]
    public async Task A_package_size_is_kept_apart_from_the_count()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var item = await AddAsync(client, "Yogurt container", quantity: 5, packSize: 3, packUnit: "Ounces");

        Assert.Equal(5m, item.Quantity);
        Assert.Equal(3m, item.PackSize);
        // Through the same unit table as everything else, so a recipe asking in oz can meet it.
        Assert.Equal("oz", item.PackUnit);
    }

    /// <summary>Clearing the size clears its unit — "3 of nothing" is not a state.</summary>
    [Fact]
    public async Task Dropping_the_package_size_drops_its_unit_with_it()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var item = await AddAsync(client, "Yogurt container", quantity: 5, packSize: 3, packUnit: "oz");

        var loose = await (await client.PatchAsJsonAsync(
            $"/api/pantry/{item.Id}?baseVersion={item.Version}",
            new PantryItemInput("Yogurt container", "Fridge", "Counted", 5, "ea", null, 1)))
            .Content.ReadFromJsonAsync<PantryItemDto>();

        Assert.Null(loose!.PackSize);
        Assert.Null(loose.PackUnit);
    }

    /// <summary>Zero is what a stepper wound down past one produces, and it means loose.</summary>
    [Fact]
    public async Task A_package_of_nothing_is_not_a_package()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var item = await AddAsync(client, "Lemons", quantity: 6, packSize: 0, packUnit: "oz");

        Assert.Null(item.PackSize);
        Assert.Null(item.PackUnit);
    }

    /// <summary>
    /// The headline: scanning the same pack again increments the count instead of starting a row.
    /// </summary>
    [Fact]
    public async Task Scanning_the_same_product_again_counts_it_rather_than_duplicating_it()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var run = Guid.NewGuid();

        await client.PostAsJsonAsync("/api/pantry/catalogue", new CatalogueInput(
            "0000000000017", null, "Yogurt container", "oz", "Fridge", "Counted", PackSize: 3, ProfileId: 1));

        for (var i = 0; i < 5; i++)
        {
            var res = await client.PostAsJsonAsync("/api/pantry/scan", new ScanInput(
                "0000000000017", null, 1, "Fridge", run, i, 1));
            res.EnsureSuccessStatusCode();
        }

        var list = await client.GetFromJsonAsync<PantryListDto>("/api/pantry");
        var row = Assert.Single(list!.Items, i => i.Name == "Yogurt Container");

        // Five packages on one row — not five rows, and not "15 oz" on one.
        Assert.Equal(5m, row.Quantity);
        Assert.Equal(3m, row.PackSize);
        Assert.Equal("oz", row.PackUnit);
    }

    /// <summary>
    /// A countable pack is a pack of one whatever net weight the catalogue also carries. A tin is a
    /// tin, and `4 tins` is a count somebody can check.
    /// </summary>
    [Fact]
    public async Task A_thing_counted_by_the_tin_is_not_given_a_package_size()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var run = Guid.NewGuid();

        await client.PostAsJsonAsync("/api/pantry/catalogue", new CatalogueInput(
            "0000000000024", null, "Chopped tomatoes", "tin", "Cupboard", "Counted", PackSize: 400, ProfileId: 1));
        await client.PostAsJsonAsync("/api/pantry/scan", new ScanInput(
            "0000000000024", null, 1, "Cupboard", run, 0, 1));

        var list = await client.GetFromJsonAsync<PantryListDto>("/api/pantry");
        var row = Assert.Single(list!.Items, i => i.Name == "Chopped Tomatoes");

        Assert.Null(row.PackSize);
        Assert.Equal("tin", row.Unit);
        Assert.Equal(1m, row.Quantity);
    }

    /// <summary>
    /// The stock check compares against what is actually on the shelf, so five 3 oz pots answer a
    /// recipe wanting four ounces.
    /// </summary>
    [Fact]
    public async Task The_stock_check_sees_the_whole_shelf_not_the_package_count()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await AddAsync(client, "Yogurt", quantity: 5, packSize: 3, packUnit: "oz");
        var recipe = await (await client.PostAsJsonAsync("/api/recipes", new RecipeInput(
            "Tzatziki",
            Servings: 4,
            Ingredients: [new RecipeIngredientInput("4 oz yogurt", 4, "oz", "yogurt")])))
            .Content.ReadFromJsonAsync<RecipeDto>();

        var check = await client.GetFromJsonAsync<StockCheckDto>($"/api/pantry/check?recipeId={recipe!.Id}");
        var line = Assert.Single(check!.Lines);

        // Five packs is a count of five; fifteen ounces is what is there. Comparing the recipe's
        // four ounces against the count would have called a full fridge short.
        Assert.Equal(nameof(StockStatus.Fine), line.Status);
    }

    /// <summary>And a shelf that genuinely cannot cover the line is still reported short.</summary>
    [Fact]
    public async Task A_packaged_shelf_that_is_short_is_still_short()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await AddAsync(client, "Yogurt", quantity: 1, packSize: 3, packUnit: "oz");
        var recipe = await (await client.PostAsJsonAsync("/api/recipes", new RecipeInput(
            "Tzatziki",
            Servings: 4,
            Ingredients: [new RecipeIngredientInput("10 oz yogurt", 10, "oz", "yogurt")])))
            .Content.ReadFromJsonAsync<RecipeDto>();

        var check = await client.GetFromJsonAsync<StockCheckDto>($"/api/pantry/check?recipeId={recipe!.Id}");

        Assert.Equal(nameof(StockStatus.Short), Assert.Single(check!.Lines).Status);
    }
}
