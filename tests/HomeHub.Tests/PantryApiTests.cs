namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Meals;
using HomeHub.Api.Pantry;

/// <summary>
/// The Pantry end to end: the ledger, the stock check, auto-deduct, the grocery return trip and the
/// order import. These are BUILD_ORDER's acceptance criteria, one test apiece where they are
/// testable without a real panel.
/// </summary>
public class PantryApiTests
{
    private static async Task<PantryItemDto> AddAsync(
        HttpClient client, string name, string tracking = "Counted",
        decimal? quantity = null, string? unit = null, string location = "Cupboard",
        string? estimate = null)
    {
        var res = await client.PostAsJsonAsync("/api/pantry", new PantryItemInput(
            name, location, tracking, quantity, unit, estimate, ProfileId: 1));
        res.EnsureSuccessStatusCode();
        return (await res.Content.ReadFromJsonAsync<PantryItemDto>())!;
    }

    private static Task<PantryListDto?> ListAsync(HttpClient client) =>
        client.GetFromJsonAsync<PantryListDto>("/api/pantry");

    // ---- Stage 0 ----

    /// <summary>
    /// Stage 0 acceptance: an item can be created, amended and archived, and <b>every change writes
    /// a PantryEvent</b>. The ledger is not an audit trail beside the state — four screens read
    /// nothing else.
    /// </summary>
    [Fact]
    public async Task Every_change_writes_a_ledger_event()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var item = await AddAsync(client, "Cento whole peeled tomatoes", quantity: 3, unit: "tins");
        await client.PatchAsJsonAsync(
            $"/api/pantry/{item.Id}?baseVersion={item.Version}",
            new PantryItemInput("Cento whole peeled tomatoes", "Cupboard", "Counted", 5, "tins", null, 1));
        await client.DeleteAsync($"/api/pantry/{item.Id}?baseVersion={item.Version + 1}");

        var events = await client.GetFromJsonAsync<List<PantryEventDto>>($"/api/pantry/{item.Id}/events");

        // Create and amend each wrote one. Archiving does not move stock, so it writes none — the
        // shelf did not change, the list did.
        Assert.Equal(2, events!.Count);
        Assert.Contains(events, e => e.Kind == nameof(PantryEventKind.TypedIn));
        Assert.Contains(events, e => e.Kind == nameof(PantryEventKind.Corrected));
    }

    /// <summary>
    /// Stage 0 acceptance: <c>lastSeenAt</c> is read from the ledger, never written directly — and
    /// PANTRY_BEHAVIOURS §3 requires it to revert to the <i>previous</i> event's timestamp after an
    /// undo rather than jumping to now.
    /// </summary>
    [Fact]
    public async Task Undo_leaves_the_last_seen_age_honest()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var item = await AddAsync(client, "Chicken breasts", quantity: 2, unit: "ea", location: "Fridge");
        var afterCreate = (await ListAsync(client))!.Items.Single(i => i.Id == item.Id).LastSeenAtUtc;

        // A second event, then undo it.
        await client.PatchAsJsonAsync(
            $"/api/pantry/{item.Id}?baseVersion={item.Version}",
            new PantryItemInput("Chicken breasts", "Fridge", "Counted", 6, "ea", null, 1));
        var second = (await client.GetFromJsonAsync<List<PantryEventDto>>($"/api/pantry/{item.Id}/events"))!
            .First(e => e.Kind == nameof(PantryEventKind.Corrected));

        await client.PostAsync($"/api/pantry/events/{second.Id}/undo", null);

        var after = (await ListAsync(client))!.Items.Single(i => i.Id == item.Id);

        // The count is back to what it was...
        Assert.Equal(2, after.Quantity);
        // ...and so is the age. Not "now" — that would be the panel claiming it had just looked at
        // a shelf nobody looked at.
        Assert.Equal(afterCreate, after.LastSeenAtUtc);
    }

    /// <summary>
    /// Undoing an earlier event must not drag a later <i>observation</i> down with it. This is the
    /// case that makes replay-with-absolutes necessary rather than "subtract the delta".
    /// </summary>
    [Fact]
    public async Task An_absolute_count_survives_undoing_an_earlier_delivery()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var item = await AddAsync(client, "Lemons", quantity: 2, unit: "ea");

        // A delivery of four...
        var run = Guid.NewGuid();
        await client.PostAsJsonAsync("/api/pantry/catalogue", new CatalogueInput(
            "012345678905", null, "Lemons", "ea", "Cupboard", "Counted", null, 1));
        await client.PostAsJsonAsync("/api/pantry/scan", new ScanInput(
            "012345678905", null, 4, "Cupboard", run, 0, 1));

        // ...then somebody counts the bowl and says there are three.
        await client.PatchAsJsonAsync(
            $"/api/pantry/{item.Id}",
            new PantryItemInput("Lemons", "Cupboard", "Counted", 3, "ea", null, 1));

        var scan = (await client.GetFromJsonAsync<List<PantryEventDto>>($"/api/pantry/{item.Id}/events"))!
            .First(e => e.Kind == nameof(PantryEventKind.Scanned));
        await client.PostAsync($"/api/pantry/events/{scan.Id}/undo", null);

        // Still three. The delivery was reversed; the count somebody actually made was not.
        var after = (await ListAsync(client))!.Items.Single(i => i.Id == item.Id);
        Assert.Equal(3, after.Quantity);
    }

    // ---- Stage 1 ----

    /// <summary>
    /// §1.5: the tally is always hedged, and a clause at zero is omitted. The server supplies the
    /// counts so they cannot disagree with the rows beneath them.
    /// </summary>
    [Fact]
    public async Task The_tally_counts_low_and_out_separately()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await AddAsync(client, "Spaghetti", quantity: 4, unit: "boxes");      // fine
        await AddAsync(client, "Chicken breasts", quantity: 2, unit: "ea");   // low
        await AddAsync(client, "Heavy cream", quantity: 0, unit: "ea");       // out
        await AddAsync(client, "Capers", "Estimated", estimate: "Low");       // low
        await AddAsync(client, "Olive oil", "NotCounted");                    // never either

        var list = (await ListAsync(client))!;

        Assert.Equal(5, list.Total);
        Assert.Equal(2, list.ProbablyLow);
        Assert.Equal(1, list.ProbablyOut);
    }

    /// <summary>A staple is never counted as low or out — that is the whole definition (PG2).</summary>
    [Fact]
    public async Task Staples_are_never_low_and_never_out()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        await AddAsync(client, "Salt", "NotCounted");
        await AddAsync(client, "Olive oil", "NotCounted");

        var list = (await ListAsync(client))!;
        Assert.Equal(2, list.Total);
        Assert.Equal(0, list.ProbablyLow);
        Assert.Equal(0, list.ProbablyOut);
    }

    // ---- Stage 3 · the stock check ----

    /// <summary>
    /// The six statuses, on one recipe. The important one is <c>Unknown</c>: a counted item whose
    /// unit cannot be compared to the recipe's is not short and not fine, and saying either would be
    /// a confident guess about the one thing this section exists to hedge.
    /// </summary>
    [Fact]
    public async Task The_check_distinguishes_short_from_gone_from_unknown()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await AddAsync(client, "Chicken breasts", quantity: 2, unit: "ea", location: "Fridge");
        await AddAsync(client, "Heavy cream", quantity: 0, unit: "ea", location: "Fridge");
        await AddAsync(client, "Capers", "Estimated", estimate: "Low");
        await AddAsync(client, "Olive oil", "NotCounted");
        await AddAsync(client, "Spaghetti", quantity: 6, unit: "boxes");

        var recipe = await (await client.PostAsJsonAsync("/api/recipes", new RecipeInput(
            "Chicken Piccata", Servings: 4,
            Ingredients: [
                new RecipeIngredientInput("6 chicken breasts", 6, "ea", "chicken breasts"),
                new RecipeIngredientInput("1 cup heavy cream", 1, "cup", "heavy cream"),
                new RecipeIngredientInput("4 tbsp capers", 4, "tbsp", "capers"),
                new RecipeIngredientInput("olive oil", null, null, "olive oil"),
                new RecipeIngredientInput("1 box spaghetti", 1, "boxes", "spaghetti"),
                new RecipeIngredientInput("2 shallots", 2, "ea", "shallots"),
            ])))
            .Content.ReadFromJsonAsync<RecipeDto>();

        var check = await client.GetFromJsonAsync<StockCheckDto>($"/api/pantry/check?recipeId={recipe!.Id}&servings=4");
        var byName = check!.Lines.ToDictionary(l => l.Name, l => l.Status);

        Assert.Equal(nameof(StockStatus.Short), byName["chicken breasts"]);
        Assert.Equal(nameof(StockStatus.Gone), byName["heavy cream"]);
        Assert.Equal(nameof(StockStatus.Unknown), byName["capers"]);
        Assert.Equal(nameof(StockStatus.NotCounted), byName["olive oil"]);
        Assert.Equal(nameof(StockStatus.Fine), byName["spaghetti"]);
        // Nothing on the shelves answers to shallots — listed, never silently "fine" (PG6).
        Assert.Equal(nameof(StockStatus.NoMatch), byName["shallots"]);

        // `WORTH A LOOK` lists Short + Gone + Unknown + NoMatch, and names the staple in the tail.
        Assert.Equal(4, check.FlaggedCount);
        Assert.Equal(6, check.TotalLines);
        Assert.Contains("Olive oil", check.NotCountedNames);
    }

    /// <summary>
    /// Stage 3 acceptance: "we've got these" marks the items seen today, and re-running the check
    /// clears them.
    /// </summary>
    [Fact]
    public async Task Correcting_stock_clears_the_shortfall()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var chicken = await AddAsync(client, "Chicken breasts", quantity: 2, unit: "ea", location: "Fridge");
        var recipe = await (await client.PostAsJsonAsync("/api/recipes", new RecipeInput(
            "Roast", Servings: 4,
            Ingredients: [new RecipeIngredientInput("6 chicken breasts", 6, "ea", "chicken breasts")])))
            .Content.ReadFromJsonAsync<RecipeDto>();

        var before = await client.GetFromJsonAsync<StockCheckDto>($"/api/pantry/check?recipeId={recipe!.Id}");
        Assert.Equal(1, before!.FlaggedCount);

        await client.PostAsJsonAsync("/api/pantry/correct", new CorrectStockInput(
            [new CorrectStockLine(chicken.Id, 6)], ProfileId: 1));

        var after = await client.GetFromJsonAsync<StockCheckDto>($"/api/pantry/check?recipeId={recipe.Id}");
        Assert.Equal(0, after!.FlaggedCount);
    }

    /// <summary>
    /// Stage 3 acceptance: a check dismissed with "Leave it, I'll sort it" does not re-fire for that
    /// plan entry.
    /// </summary>
    [Fact]
    public async Task A_dismissed_check_does_not_re_fire()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await AddAsync(client, "Chicken breasts", quantity: 1, unit: "ea", location: "Fridge");
        var recipe = await (await client.PostAsJsonAsync("/api/recipes", new RecipeInput(
            "Roast", Servings: 4,
            Ingredients: [new RecipeIngredientInput("6 chicken breasts", 6, "ea", "chicken breasts")])))
            .Content.ReadFromJsonAsync<RecipeDto>();

        var date = DateOnly.FromDateTime(DateTime.Now).AddDays(1);
        var entry = await (await client.PutAsJsonAsync("/api/meals/plan",
            new MealPlanInput(date, MealSlot.Dinner, RecipeId: recipe!.Id)))
            .Content.ReadFromJsonAsync<MealPlanEntryDto>();

        await client.PostAsync($"/api/pantry/check/{entry!.Id}/dismiss", null);

        var res = await client.GetAsync($"/api/pantry/check?recipeId={recipe.Id}&planEntryId={entry.Id}");
        Assert.Equal(HttpStatusCode.NoContent, res.StatusCode);
    }

    // ---- Stage 4 · auto-deduct ----

    /// <summary>
    /// Stage 4 acceptance, all four rules at once — and the one that matters most is the last:
    /// <b>an unconvertible unit claims no arithmetic</b>. A pound of butter must not read as gone
    /// because a recipe used four tablespoons.
    /// </summary>
    [Fact]
    public async Task Deduction_is_exact_where_it_can_be_and_silent_where_it_cannot()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await AddAsync(client, "Chicken breasts", quantity: 6, unit: "ea", location: "Fridge");
        await AddAsync(client, "Capers", "Estimated", estimate: "Plenty");
        await AddAsync(client, "Butter", quantity: 1, unit: "lb", location: "Fridge");
        await AddAsync(client, "Salt", "NotCounted");

        var recipe = await (await client.PostAsJsonAsync("/api/recipes", new RecipeInput(
            "Chicken Piccata", Servings: 4,
            Ingredients: [
                new RecipeIngredientInput("6 chicken breasts", 6, "ea", "chicken breasts"),
                new RecipeIngredientInput("4 tbsp capers", 4, "tbsp", "capers"),
                new RecipeIngredientInput("4 tbsp butter", 4, "tbsp", "butter"),
                new RecipeIngredientInput("salt", null, null, "salt"),
            ])))
            .Content.ReadFromJsonAsync<RecipeDto>();

        var date = DateOnly.FromDateTime(DateTime.Now).AddDays(-1);
        var entry = await (await client.PutAsJsonAsync("/api/meals/plan",
            new MealPlanInput(date, MealSlot.Dinner, RecipeId: recipe!.Id)))
            .Content.ReadFromJsonAsync<MealPlanEntryDto>();
        await client.PutAsJsonAsync("/api/meals/plan/eaten", new MealEatenInput(date, MealSlot.Dinner, true));

        var receipt = await (await client.PostAsync($"/api/pantry/deduct?planEntryId={entry!.Id}", null))
            .Content.ReadFromJsonAsync<DeductionReceiptDto>();

        // Counted + convertible: exact arithmetic, and it hit zero.
        var chicken = Assert.Single(receipt!.Counted);
        Assert.Equal("Chicken breasts", chicken.Name);
        Assert.Equal(6, chicken.From);
        Assert.Equal(0, chicken.To);
        Assert.Contains(chicken.PantryItemId, receipt.HitNone);

        // Estimated: one step, never two.
        var capers = receipt.Estimated.Single(l => l.Name == "Capers");
        Assert.Equal(nameof(EstimateState.Low), capers.ResultingState);

        // Counted + unconvertible: no arithmetic claimed, and the row says why.
        var butter = receipt.Estimated.Single(l => l.Name == "Butter");
        Assert.Equal("MostLeft", butter.ResultingState);
        Assert.Contains("don't convert", butter.Note);
        var butterNow = (await ListAsync(client))!.Items.Single(i => i.Name == "Butter");
        Assert.Equal(1, butterNow.Quantity);

        // Staples: named, untouched.
        Assert.Contains("Salt", receipt.LeftAlone);
    }

    /// <summary>
    /// Stage 4 acceptance: only nights answered <i>yes</i> deduct, and deduction is idempotent —
    /// flipping the answer twice must not take the shelves down twice.
    /// </summary>
    [Fact]
    public async Task Only_a_yes_deducts_and_it_deducts_once()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        await AddAsync(client, "Chicken breasts", quantity: 10, unit: "ea", location: "Fridge");

        var recipe = await (await client.PostAsJsonAsync("/api/recipes", new RecipeInput(
            "Roast", Servings: 4,
            Ingredients: [new RecipeIngredientInput("2 chicken breasts", 2, "ea", "chicken breasts")])))
            .Content.ReadFromJsonAsync<RecipeDto>();

        var date = DateOnly.FromDateTime(DateTime.Now).AddDays(-1);
        var entry = await (await client.PutAsJsonAsync("/api/meals/plan",
            new MealPlanInput(date, MealSlot.Dinner, RecipeId: recipe!.Id)))
            .Content.ReadFromJsonAsync<MealPlanEntryDto>();

        // Unanswered deducts nothing.
        Assert.Equal(HttpStatusCode.NoContent,
            (await client.PostAsync($"/api/pantry/deduct?planEntryId={entry!.Id}", null)).StatusCode);
        Assert.Equal(10, (await ListAsync(client))!.Items.Single().Quantity);

        // Answered "no" deducts nothing.
        await client.PutAsJsonAsync("/api/meals/plan/eaten", new MealEatenInput(date, MealSlot.Dinner, false));
        Assert.Equal(HttpStatusCode.NoContent,
            (await client.PostAsync($"/api/pantry/deduct?planEntryId={entry.Id}", null)).StatusCode);
        Assert.Equal(10, (await ListAsync(client))!.Items.Single().Quantity);

        // Answered "yes" deducts once, however many times it is asked.
        await client.PutAsJsonAsync("/api/meals/plan/eaten", new MealEatenInput(date, MealSlot.Dinner, true));
        await client.PostAsync($"/api/pantry/deduct?planEntryId={entry.Id}", null);
        await client.PostAsync($"/api/pantry/deduct?planEntryId={entry.Id}", null);
        Assert.Equal(8, (await ListAsync(client))!.Items.Single().Quantity);
    }

    // ---- Stage 2 · grocery ----

    /// <summary>
    /// Stage 2 acceptance: ticking a line adds stock and the row reads "Put 1 lb in the fridge".
    /// This is the return trip, and it is the reason the list is owned locally rather than mirrored.
    /// </summary>
    [Fact]
    public async Task Ticking_a_line_puts_the_stock_back()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var butter = await AddAsync(client, "Butter", quantity: 0, unit: "lb", location: "Fridge");

        var line = await (await client.PostAsJsonAsync("/api/grocery", new GroceryInput(
            "Butter", 1, "lb", butter.Id, "Meal", null, null, null, 1)))
            .Content.ReadFromJsonAsync<GroceryLineDto>();

        var ticked = await (await client.PostAsync($"/api/grocery/{line!.Id}/check?checkedOff=true", null))
            .Content.ReadFromJsonAsync<GroceryLineDto>();

        Assert.Equal("Put 1 lb in the fridge", ticked!.ReturnTrip);
        Assert.Equal(1, (await ListAsync(client))!.Items.Single(i => i.Id == butter.Id).Quantity);

        // And unticking reverses exactly that, through the ledger.
        await client.PostAsync($"/api/grocery/{line.Id}/check?checkedOff=false", null);
        Assert.Equal(0, (await ListAsync(client))!.Items.Single(i => i.Id == butter.Id).Quantity);
    }

    /// <summary>
    /// Stage 2 acceptance: two lines for the same item from two nights show as <b>one row with both
    /// provenances</b>. A list that says "Lemons" twice is a list that gets one of them ignored.
    /// </summary>
    [Fact]
    public async Task Two_nights_wanting_the_same_thing_merge_into_one_row()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var lemons = await AddAsync(client, "Lemons", quantity: 0, unit: "ea");

        var wed = DateOnly.FromDateTime(DateTime.Now).AddDays(1);
        var fri = DateOnly.FromDateTime(DateTime.Now).AddDays(3);
        await client.PostAsJsonAsync("/api/grocery", new GroceryInput(
            "Lemons", 3, "ea", lemons.Id, "Meal", 1, "Chicken Piccata", wed, 1));
        await client.PostAsJsonAsync("/api/grocery", new GroceryInput(
            "Lemons", 2, "ea", lemons.Id, "Meal", 2, "Sheet-pan salmon", fri, 1));

        var list = await client.GetFromJsonAsync<GroceryListDto>("/api/grocery");
        var line = Assert.Single(list!.Lines);

        Assert.Equal(2, line.Provenance.Count);
        Assert.Equal("Chicken Piccata", line.Provenance[0].Label);
        Assert.Equal("Sheet-pan salmon", line.Provenance[1].Label);
        // The larger of the two, not the sum: two nights wanting lemons want three between them far
        // more often than five.
        Assert.Equal(3, line.Quantity);
    }

    /// <summary>
    /// A row that has already been ticked is never merged into. Planning another night that needs it
    /// has to put it back on the list, not silently re-open a row somebody already dealt with.
    /// </summary>
    [Fact]
    public async Task A_ticked_row_is_not_merged_into()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var first = await (await client.PostAsJsonAsync("/api/grocery", new GroceryInput(
            "Kitchen roll", null, null, null, "Hand", null, null, null, 1)))
            .Content.ReadFromJsonAsync<GroceryLineDto>();
        await client.PostAsync($"/api/grocery/{first!.Id}/check?checkedOff=true", null);

        await client.PostAsJsonAsync("/api/grocery", new GroceryInput(
            "kitchen rolls", null, null, null, "Hand", null, null, null, 1));

        var list = await client.GetFromJsonAsync<GroceryListDto>("/api/grocery");
        Assert.Equal(2, list!.Lines.Count);
        Assert.Equal(1, list.OpenCount);
    }

    /// <summary>With no list chosen the mirror is `Off` — a supported state, not a broken one.</summary>
    [Fact]
    public async Task The_mirror_is_off_until_a_list_is_chosen()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var status = await client.GetFromJsonAsync<MirrorStatusDto>("/api/grocery/mirror");
        Assert.Equal("Off", status!.State);
        Assert.Equal(0, status.QueuedCount);
    }

    // ---- Stage 5 · scan and import ----

    /// <summary>
    /// DECISIONS PG4: an unknown barcode is a first-class row, <b>not an error</b> — and naming it
    /// once makes the next identical scan resolve without asking.
    /// </summary>
    [Fact]
    public async Task Naming_an_unknown_barcode_teaches_the_catalogue()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var run = Guid.NewGuid();

        var first = await (await client.PostAsJsonAsync("/api/pantry/scan", new ScanInput(
            "012345678905", null, 1, "Cupboard", run, 0, 1)))
            .Content.ReadFromJsonAsync<ScanResultDto>();

        Assert.False(first!.Matched);
        Assert.Null(first.Item);
        Assert.Empty((await ListAsync(client))!.Items);

        await client.PostAsJsonAsync("/api/pantry/catalogue", new CatalogueInput(
            "012345678905", null, "Cento whole peeled tomatoes", "tins", "Cupboard", "Counted", null, 1));

        var second = await (await client.PostAsJsonAsync("/api/pantry/scan", new ScanInput(
            "012345678905", null, 1, "Cupboard", run, 1, 1)))
            .Content.ReadFromJsonAsync<ScanResultDto>();

        Assert.True(second!.Matched);
        // Title-cased on the way in: `NAME IT` is the scan path, where the name is either a pack
        // being named for the first time or a suggestion out of a stranger's database — neither is
        // the household's own words yet. A name typed into the row sheet is left exactly as typed.
        Assert.Equal("Cento Whole Peeled Tomatoes", second.Item!.Name);
    }

    /// <summary>
    /// The house style applies to scanning, and stops there.
    /// </summary>
    /// <remarks>
    /// The pantry stores the household's own words (DECISIONS P9), so re-casing what somebody
    /// deliberately typed would be the section overruling them. `iPhone charger cable`, `pH strips`
    /// and `crème fraîche` are all things a person may mean exactly as written.
    /// </remarks>
    [Fact]
    public async Task A_name_typed_by_hand_is_left_exactly_as_typed()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var created = await (await client.PostAsJsonAsync("/api/pantry", new PantryItemInput(
            "crème fraîche, the good one", "Fridge", "Counted", 1, "tub", null, 1)))
            .Content.ReadFromJsonAsync<PantryItemDto>();

        Assert.Equal("crème fraîche, the good one", created!.Name);
    }

    /// <summary>
    /// The other half of PG4: a pack nobody could name is typed in by hand, and the barcode the
    /// phone read goes with it — so the <i>second</i> pack resolves without asking anybody.
    /// </summary>
    /// <remarks>
    /// This is the case the scan screen cannot cover on its own. The outside lookup answered
    /// nothing, so there is no suggestion to accept; somebody types the item in, and if the code
    /// were dropped at that moment the household would be asked to name the identical pack again
    /// next week.
    /// </remarks>
    [Fact]
    public async Task Adding_by_hand_with_a_barcode_teaches_the_catalogue()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var run = Guid.NewGuid();

        // Not in the catalogue, and nothing was written.
        var miss = await (await client.PostAsJsonAsync("/api/pantry/scan", new ScanInput(
            "012345678905", null, 1, "Cupboard", run, 0, 1)))
            .Content.ReadFromJsonAsync<ScanResultDto>();
        Assert.False(miss!.Matched);

        // Typed in by hand, holding on to the code.
        var created = await (await client.PostAsJsonAsync("/api/pantry", new PantryItemInput(
            "Cento whole peeled tomatoes", "Cupboard", "Counted", 5, "tins", null, 1,
            Barcode: "012345678905")))
            .Content.ReadFromJsonAsync<PantryItemDto>();
        Assert.Equal("0012345678905", created!.CatalogueRef);

        // The next identical pack resolves onto that same row, with no naming step.
        var second = await (await client.PostAsJsonAsync("/api/pantry/scan", new ScanInput(
            "012345678905", null, 1, "Cupboard", run, 1, 1)))
            .Content.ReadFromJsonAsync<ScanResultDto>();

        Assert.True(second!.Matched);
        Assert.Equal(created.Id, second.Item!.Id);
        Assert.Equal(6, second.Item.Quantity);
    }

    /// <summary>
    /// Renaming a row to what the household actually calls it re-teaches the catalogue.
    /// </summary>
    /// <remarks>
    /// The pantry stores the household's own words, and the catalogue is what turns a scan into
    /// those words. If it kept the name from the day the barcode was attached, a shelf reading
    /// "Coke Zero" would keep producing scans that say "Coca-Cola Zero Sugar 355 ml".
    /// </remarks>
    [Fact]
    public async Task Renaming_an_item_that_carries_a_barcode_updates_the_catalogue()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var created = await (await client.PostAsJsonAsync("/api/pantry", new PantryItemInput(
            "Coca-Cola Zero Sugar 355 ml", "Fridge", "Counted", 6, "cans", null, 1,
            Barcode: "012345678905")))
            .Content.ReadFromJsonAsync<PantryItemDto>();

        // No barcode in the payload — the field was untouched, which must not unlink it.
        await client.PatchAsJsonAsync($"/api/pantry/{created!.Id}", new PantryItemInput(
            "Coke Zero", "Fridge", "Counted", 6, "cans", null, 1));

        var again = await (await client.PostAsJsonAsync("/api/pantry/scan", new ScanInput(
            "012345678905", null, 1, null, Guid.NewGuid(), 0, 1)))
            .Content.ReadFromJsonAsync<ScanResultDto>();

        Assert.True(again!.Matched);
        Assert.Equal("Coke Zero", again.Item!.Name);
        Assert.Equal(created.Id, again.Item.Id);
    }

    /// <summary>
    /// One barcode, one live row. Two items answering to the same code makes every later scan of it
    /// a coin toss, so the second attachment is refused by name rather than silently allowed.
    /// </summary>
    [Fact]
    public async Task A_barcode_another_item_carries_is_refused()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await client.PostAsJsonAsync("/api/pantry", new PantryItemInput(
            "Olive oil, good bottle", "Cupboard", "Estimated", null, null, "Plenty", 1,
            Barcode: "012345678905"));

        var second = await client.PostAsJsonAsync("/api/pantry", new PantryItemInput(
            "Rapeseed oil", "Cupboard", "Estimated", null, null, "Plenty", 1,
            Barcode: "012345678905"));

        Assert.Equal(HttpStatusCode.BadRequest, second.StatusCode);
        // Named, not just refused — "already in use" leaves somebody hunting the shelves for it.
        Assert.Contains("Olive oil, good bottle", await second.Content.ReadAsStringAsync());
        // And the refusal cost nothing: the rejected item was never created.
        Assert.DoesNotContain((await ListAsync(client))!.Items, i => i.Name == "Rapeseed oil");
    }

    /// <summary>
    /// A hand entry does not know what one pack weighs, so it must not overwrite a pack size
    /// somebody stated while holding the bag.
    /// </summary>
    /// <remarks>
    /// Not stating a thing is not the same as stating null. If it were, editing the walnuts row on
    /// the panel would turn every later scan of that bag from "one 500 g bag" into "+1 g" —
    /// silently, and only noticed a month later when the shelf said 4 g.
    /// <para>
    /// The hand edit here sends no pack size, which un-packages the <i>row</i> — that is a full
    /// replace and behaves like every other field on it. What must survive is the <b>catalogue's</b>
    /// stated size, so the next scan brings the row back across rather than adding 1 to a count of
    /// grams. Restating 500 g as one 500 g bag is arithmetic nobody can argue with, which is why it
    /// is allowed to happen on its own.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task Editing_an_item_by_hand_does_not_erase_a_stated_pack_size()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await client.PostAsJsonAsync("/api/pantry/catalogue", new CatalogueInput(
            "012345678905", null, "Walnuts", "g", "Cupboard", "Counted", PackSize: 500, ProfileId: 1));

        await client.PostAsJsonAsync("/api/pantry/scan", new ScanInput(
            "012345678905", null, 1, null, Guid.NewGuid(), 0, 1));

        // Amended by hand, in grams, with nothing said about packages.
        var walnuts = (await ListAsync(client))!.Items.Single();
        await client.PatchAsJsonAsync($"/api/pantry/{walnuts.Id}", new PantryItemInput(
            "Walnuts, halves", "Cupboard", "Counted", 500, "g", null, 1));

        await client.PostAsJsonAsync("/api/pantry/scan", new ScanInput(
            "012345678905", null, 1, null, Guid.NewGuid(), 0, 1));

        var after = (await ListAsync(client))!.Items.Single();
        // Two bags of 500 g — a kilo on the shelf, still. Not 501 g.
        Assert.Equal(2, after.Quantity);
        Assert.Equal(500, after.PackSize);
        Assert.Equal("g", after.PackUnit);
    }

    /// <summary>
    /// A scan adds <b>one pack</b>, and what a pack is comes from the catalogue.
    /// </summary>
    /// <remarks>
    /// Scanning a 500 g bag of walnuts must not add "1", which for an item measured in grams is not
    /// a small error but a meaningless number the household then has to correct with a +1 stepper.
    /// Nothing fails and nothing is logged; the shelf just quietly says 1 g.
    /// <para>
    /// The count is a count of <i>bags</i> rather than the 500 g it used to hold, because "2500 g of
    /// walnuts" is a figure nobody can check by looking at the cupboard, and five identical bags on
    /// five rows is the same cupboard listed five times. The row reads `500 g ×2`.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_scan_adds_one_pack_not_one_unit()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var run = Guid.NewGuid();

        await client.PostAsJsonAsync("/api/pantry/catalogue", new CatalogueInput(
            "012345678905", null, "Walnuts", "g", "Cupboard", "Counted", PackSize: 500, ProfileId: 1));

        await client.PostAsJsonAsync("/api/pantry/scan", new ScanInput(
            "012345678905", null, 1, null, run, 0, 1));

        var walnuts = (await ListAsync(client))!.Items.Single();
        Assert.Equal(1, walnuts.Quantity);
        Assert.Equal(500, walnuts.PackSize);
        Assert.Equal("g", walnuts.PackUnit);
        // The display unit is the package, so `500 g ×1` does not come out as `500 g ×1 g`.
        Assert.Null(walnuts.Unit);

        // A second bag is another bag — one row, not two.
        await client.PostAsJsonAsync("/api/pantry/scan", new ScanInput(
            "012345678905", null, 1, null, run, 1, 1));
        var after = (await ListAsync(client))!.Items.Single();
        Assert.Equal(2, after.Quantity);
        // And a kilo is still what is in the cupboard, which is what the stock check compares.
        Assert.Equal(1000, after.Quantity * after.PackSize);
    }

    /// <summary>
    /// Pack size applies to things measured, not to things counted. A pack of six tins is still
    /// scanned one tin at a time, and a stated net weight must not turn "1 can" into "400 cans".
    /// </summary>
    [Fact]
    public async Task A_countable_unit_ignores_the_stated_pack_weight()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var run = Guid.NewGuid();

        await client.PostAsJsonAsync("/api/pantry/catalogue", new CatalogueInput(
            "012345678905", null, "Chopped tomatoes", "tins", "Cupboard", "Counted",
            PackSize: 400, ProfileId: 1));

        await client.PostAsJsonAsync("/api/pantry/scan", new ScanInput(
            "012345678905", null, 1, null, run, 0, 1));

        Assert.Equal(1, (await ListAsync(client))!.Items.Single().Quantity);
    }

    /// <summary>
    /// DECISIONS PG7: two phones on the same delivery both add; the same phone retrying does not.
    /// Idempotency is on <c>(scanRunId, sequence)</c>.
    /// </summary>
    [Fact]
    public async Task A_repeated_scan_sequence_does_not_double_count()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var run = Guid.NewGuid();
        await client.PostAsJsonAsync("/api/pantry/catalogue", new CatalogueInput(
            "012345678905", null, "Lemons", "ea", "Cupboard", "Counted", null, 1));

        await client.PostAsJsonAsync("/api/pantry/scan", new ScanInput("012345678905", null, 1, null, run, 0, 1));
        await client.PostAsJsonAsync("/api/pantry/scan", new ScanInput("012345678905", null, 1, null, run, 0, 1));
        await client.PostAsJsonAsync("/api/pantry/scan", new ScanInput("012345678905", null, 1, null, run, 1, 1));

        Assert.Equal(2, (await ListAsync(client))!.Items.Single().Quantity);
    }

    /// <summary>
    /// Stage 5 acceptance: nothing is written until `PUT n AWAY`, and applying twice answers 409
    /// with the applied import so the second person is told who got there first.
    /// </summary>
    [Fact]
    public async Task An_import_writes_nothing_until_applied_and_only_once()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var payload = "GV HVY WHP CRM 32Z\nMM CHKN BRST 2.5LB PK\nXQ ZZT 4K";
        var import = await (await client.PostAsJsonAsync("/api/pantry/imports",
            new OrderImportInput("Email", "Walmart", payload, null)))
            .Content.ReadFromJsonAsync<OrderImportDto>();

        Assert.Equal(3, import!.Lines.Count);
        Assert.Equal(1, import.UnreadableCount);
        // Nothing on the shelves yet.
        Assert.Empty((await ListAsync(client))!.Items);

        await client.PostAsJsonAsync($"/api/pantry/imports/{import.Id}/apply", new ApplyImportInput(1));

        var items = (await ListAsync(client))!.Items;
        // The two readable lines landed; the unreadable one stayed behind to be named.
        Assert.Equal(2, items.Count);
        Assert.Contains(items, i => i.Name == "Heavy whipping cream");
        Assert.Contains(items, i => i.Name == "Chicken breast" && i.Quantity == 6);

        var again = await client.PostAsJsonAsync(
            $"/api/pantry/imports/{import.Id}/apply", new ApplyImportInput(2));
        Assert.Equal(HttpStatusCode.Conflict, again.StatusCode);
        var applied = await again.Content.ReadFromJsonAsync<OrderImportDto>();
        Assert.Equal("Astrid", applied!.AppliedByName);

        // And it is still two — the second apply changed nothing.
        Assert.Equal(2, (await ListAsync(client))!.Items.Count);
    }

    /// <summary>A pending import surfaces on 9a as the waiting row, and stops doing so once applied.</summary>
    [Fact]
    public async Task A_pending_import_shows_on_the_tab_until_it_is_put_away()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var import = await (await client.PostAsJsonAsync("/api/pantry/imports",
            new OrderImportInput("Email", "Walmart", "SPGHT 1LB", null)))
            .Content.ReadFromJsonAsync<OrderImportDto>();

        Assert.Single((await ListAsync(client))!.PendingImports);

        await client.PostAsJsonAsync($"/api/pantry/imports/{import!.Id}/apply", new ApplyImportInput(1));
        Assert.Empty((await ListAsync(client))!.PendingImports);
    }

    // ---- The item sheet (PANTRY_SHELVES §2) ----

    /// <summary>
    /// <c>USED BY</c> lists the recipes that cook this item, with what each asks for — and restates
    /// the amount in the item's own packs only where the units genuinely convert.
    /// </summary>
    /// <remarks>
    /// The refusal is the point, and it is the same one the stock check makes: an item counted in
    /// 12 oz cans has no honest answer for a line asking for two tablespoons, so the row says
    /// <c>2 tbsp</c> and stops rather than inventing a number of tins.
    /// </remarks>
    [Fact]
    public async Task Used_by_names_the_recipes_and_converts_only_what_converts()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/pantry", new PantryItemInput(
            "Tomato sauce", "Cupboard", "Counted", 4, "cans", null, 1, PackSize: 12, PackUnit: "oz"));
        var item = (await res.Content.ReadFromJsonAsync<PantryItemDto>())!;

        await client.PostAsJsonAsync("/api/recipes", new RecipeInput(
            "Dal with spinach", Servings: 4,
            Ingredients: [new RecipeIngredientInput("30 oz tomato sauce", 30, "oz", "tomato sauce")]));
        await client.PostAsJsonAsync("/api/recipes", new RecipeInput(
            "Chicken Piccata", Servings: 4,
            Ingredients: [new RecipeIngredientInput("2 tbsp tomato sauce", 2, "tbsp", "tomato sauce")]));
        await client.PostAsJsonAsync("/api/recipes", new RecipeInput(
            "Something else", Servings: 4,
            Ingredients: [new RecipeIngredientInput("2 onions", 2, "ea", "onions")]));

        var usage = (await client.GetFromJsonAsync<List<ItemUsageDto>>($"/api/pantry/{item.Id}/used-by"))!;

        // Alphabetical, and only the two that name it.
        Assert.Equal(["Chicken Piccata", "Dal with spinach"], usage.Select(u => u.Title));

        var dal = usage.Single(u => u.Title == "Dal with spinach");
        Assert.Equal(30m, dal.Quantity);
        Assert.Equal("oz", dal.Unit);
        Assert.Equal(2.5m, dal.Packs);
        // The unit registry stores the canonical singular, so this is `can` and not `cans` — the
        // pantry renders the plural nowhere, on this screen or any other. See the note in UnitSeed.
        Assert.Equal("can", dal.PackUnit);

        // Tablespoons of tomato sauce against 12 oz cans: no conversion, so no pack count.
        var piccata = usage.Single(u => u.Title == "Chicken Piccata");
        Assert.Equal(2m, piccata.Quantity);
        Assert.Null(piccata.Packs);
    }

    /// <summary>
    /// A recipe naming the item on two lines is one row, carrying the larger amount.
    /// </summary>
    /// <remarks>
    /// Two rows would read as two dishes on a list whose whole job is naming dishes, and summing
    /// them is wrong as often as it is right — "1 can, drained" and "1 can, with juice" is one can.
    /// </remarks>
    [Fact]
    public async Task A_recipe_naming_it_twice_appears_once()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var item = await AddAsync(client, "Tomato sauce", quantity: 4, unit: "cans");

        await client.PostAsJsonAsync("/api/recipes", new RecipeInput(
            "Ragù", Servings: 4,
            Ingredients: [
                new RecipeIngredientInput("1 can tomato sauce, drained", 1, "can", "tomato sauce"),
                new RecipeIngredientInput("2 cans tomato sauce", 2, "can", "tomato sauce"),
            ]));

        var usage = await client.GetFromJsonAsync<List<ItemUsageDto>>($"/api/pantry/{item.Id}/used-by");

        var row = Assert.Single(usage!);
        Assert.Equal(2m, row.Quantity);
    }

    /// <summary>
    /// A night holding this item makes its recipe say so — and does not reorder the list to do it.
    /// </summary>
    [Fact]
    public async Task A_claimed_night_shows_on_its_recipe_without_promoting_it()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var item = await AddAsync(client, "Tomato sauce", quantity: 4, unit: "cans");

        await client.PostAsJsonAsync("/api/recipes", new RecipeInput(
            "Amatriciana", Servings: 4,
            Ingredients: [new RecipeIngredientInput("1 can tomato sauce", 1, "can", "tomato sauce")]));
        var claimed = await (await client.PostAsJsonAsync("/api/recipes", new RecipeInput(
            "Ragù", Servings: 4,
            Ingredients: [new RecipeIngredientInput("1 can tomato sauce", 1, "can", "tomato sauce")])))
            .Content.ReadFromJsonAsync<RecipeDto>();

        var date = DateOnly.FromDateTime(DateTime.Now).AddDays(2);
        await client.PutAsJsonAsync("/api/meals/plan",
            new MealPlanInput(date, MealSlot.Dinner, RecipeId: claimed!.Id));

        var usage = (await client.GetFromJsonAsync<List<ItemUsageDto>>($"/api/pantry/{item.Id}/used-by"))!;

        // Still alphabetical: the amber says it is spoken for, the ordering does not.
        Assert.Equal(["Amatriciana", "Ragù"], usage.Select(u => u.Title));
        Assert.Null(usage.Single(u => u.Title == "Amatriciana").ClaimedForDate);
        Assert.Equal(date, usage.Single(u => u.Title == "Ragù").ClaimedForDate);
    }

    /// <summary>
    /// A deduction's history row names the night it cooked, so "one used" answers its own question.
    /// </summary>
    [Fact]
    public async Task The_history_names_what_a_deduction_was_for()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var item = await AddAsync(client, "Tomato sauce", quantity: 4, unit: "cans");

        var recipe = await (await client.PostAsJsonAsync("/api/recipes", new RecipeInput(
            "Chicken Piccata", Servings: 4,
            Ingredients: [new RecipeIngredientInput("1 can tomato sauce", 1, "cans", "tomato sauce")])))
            .Content.ReadFromJsonAsync<RecipeDto>();

        var date = DateOnly.FromDateTime(DateTime.Now).AddDays(-1);
        var entry = await (await client.PutAsJsonAsync("/api/meals/plan",
            new MealPlanInput(date, MealSlot.Dinner, RecipeId: recipe!.Id)))
            .Content.ReadFromJsonAsync<MealPlanEntryDto>();
        await client.PutAsJsonAsync("/api/meals/plan/eaten", new MealEatenInput(date, MealSlot.Dinner, true));
        await client.PostAsync($"/api/pantry/deduct?planEntryId={entry!.Id}", null);

        var events = (await client.GetFromJsonAsync<List<PantryEventDto>>($"/api/pantry/{item.Id}/events"))!;

        var deduction = events.Single(e => e.Kind == nameof(PantryEventKind.Deducted));
        Assert.Equal("Chicken Piccata", deduction.SourceLabel);

        // A hand entry has no cause worth naming — the person is already in ByName.
        Assert.Null(events.Single(e => e.Kind == nameof(PantryEventKind.TypedIn)).SourceLabel);
    }

    /// <summary>
    /// The add form's viewfinder identifies a barcode and <b>writes nothing</b> (ADD_TO_PANTRY §2).
    /// </summary>
    /// <remarks>
    /// The distinction from <c>POST /scan</c> is the whole point: a camera decodes the same pack many
    /// times a second, so a lookup with a side effect would file a ledger row per frame. "One scan
    /// names the thing and fills its size; it never increments a count."
    /// </remarks>
    [Fact]
    public async Task Looking_up_a_barcode_identifies_it_and_writes_nothing()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/pantry", new PantryItemInput(
            "Tomato sauce", "Cupboard", "Counted", 4, "can", null, 1,
            PackSize: 12, PackUnit: "oz", Barcode: "041331126047"));
        var item = (await res.Content.ReadFromJsonAsync<PantryItemDto>())!;
        var before = (await client.GetFromJsonAsync<List<PantryEventDto>>($"/api/pantry/{item.Id}/events"))!.Count;

        var found = await client.GetFromJsonAsync<BarcodeLookupDto>("/api/pantry/catalogue/041331126047");

        Assert.True(found!.Known);
        Assert.Equal("Tomato sauce", found.Name);
        // **No pack size**, and that is the documented rule rather than a gap: only the scan path
        // teaches it, "because the phone asked while somebody was holding it". A hand-add carries a
        // size for that row and does not claim it for every future pack of the same code
        // (see TeachCatalogueAsync). The viewfinder therefore fills a name and leaves the size blank
        // for a code the household only ever typed.
        Assert.Null(found.PackSize);

        // Nothing moved and nothing was filed.
        var after = (await client.GetFromJsonAsync<List<PantryEventDto>>($"/api/pantry/{item.Id}/events"))!.Count;
        Assert.Equal(before, after);
        var still = (await ListAsync(client))!.Items.Single(i => i.Id == item.Id);
        Assert.Equal(4m, still.Quantity);
    }

    /// <summary>An unknown barcode is a first-class answer, not an error (DECISIONS PG4).</summary>
    [Fact]
    public async Task An_unknown_barcode_answers_rather_than_failing()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var found = await client.GetFromJsonAsync<BarcodeLookupDto>("/api/pantry/catalogue/041331126047");

        Assert.False(found!.Known);
        Assert.Null(found.Name);
        // Normalised on the way through, so a later `NAME IT` teaches against the same 13 digits.
        Assert.Equal(13, found.Barcode.Length);
    }

    /// <summary>Something that is not a grocery barcode is refused rather than looked up.</summary>
    [Fact]
    public async Task A_barcode_that_is_not_one_is_refused()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.GetAsync("/api/pantry/catalogue/not-a-barcode");

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }
}
