namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Meals;

/// <summary>
/// Stage M1 week plan over HTTP. Dates are <see cref="DateOnly"/> household calendar dates rather
/// than instants (meals-planning.md D7), so nothing here should shift with a UTC offset.
/// </summary>
public class MealsApiTests
{
    private static readonly DateOnly Monday = new(2026, 8, 3);

    private static async Task<RecipeDto> CreateRecipeAsync(HttpClient client, string title) =>
        (await (await client.PostAsJsonAsync("/api/recipes", new RecipeInput(title)))
            .Content.ReadFromJsonAsync<RecipeDto>())!;

    private static Task<HttpResponseMessage> PlanAsync(HttpClient client, MealPlanInput input, int? baseVersion = null) =>
        client.PutAsJsonAsync($"/api/meals/plan{(baseVersion is null ? "" : $"?baseVersion={baseVersion}")}", input);

    [Fact]
    public async Task Week_returns_seven_days_including_the_empty_ones()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var week = await client.GetFromJsonAsync<MealWeekDto>($"/api/meals/week?start={Monday:yyyy-MM-dd}");

        Assert.Equal(Monday, week!.Start);
        Assert.Equal(Monday.AddDays(6), week.End);
        Assert.Equal(7, week.Days.Count);
        // Every day is present so the week screen renders seven ruled rows without filling gaps itself.
        Assert.All(week.Days, d => Assert.Empty(d.Entries));
        Assert.Equal(Monday.AddDays(6), week.Days[^1].Date);
    }

    [Fact]
    public async Task Planning_a_recipe_shows_its_title_on_the_right_day()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var recipe = await CreateRecipeAsync(client, "Chicken Piccata");

        var planned = await (await PlanAsync(client, new MealPlanInput(Monday.AddDays(1), MealSlot.Dinner, RecipeId: recipe.Id)))
            .Content.ReadFromJsonAsync<MealPlanEntryDto>();

        Assert.Equal("Chicken Piccata", planned!.RecipeTitle);
        Assert.Equal("Dinner", planned.Slot);

        var week = await client.GetFromJsonAsync<MealWeekDto>($"/api/meals/week?start={Monday:yyyy-MM-dd}");
        Assert.Empty(week!.Days[0].Entries);
        var tuesday = Assert.Single(week.Days[1].Entries);
        Assert.Equal("Chicken Piccata", tuesday.RecipeTitle);
        Assert.Equal(recipe.Id, tuesday.RecipeId);
    }

    [Fact]
    public async Task Planning_the_same_slot_twice_replaces_rather_than_duplicates()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var first = await CreateRecipeAsync(client, "Pasta");
        var second = await CreateRecipeAsync(client, "Roast");

        await PlanAsync(client, new MealPlanInput(Monday, MealSlot.Dinner, RecipeId: first.Id));
        var replaced = await (await PlanAsync(client, new MealPlanInput(Monday, MealSlot.Dinner, RecipeId: second.Id)))
            .Content.ReadFromJsonAsync<MealPlanEntryDto>();

        Assert.Equal("Roast", replaced!.RecipeTitle);
        Assert.Equal(2, replaced.Version);

        var week = await client.GetFromJsonAsync<MealWeekDto>($"/api/meals/week?start={Monday:yyyy-MM-dd}");
        var monday = Assert.Single(week!.Days[0].Entries);
        Assert.Equal("Roast", monday.RecipeTitle);
    }

    [Fact]
    public async Task A_slot_can_hold_free_text_instead_of_a_recipe()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var planned = await (await PlanAsync(client, new MealPlanInput(Monday, MealSlot.Dinner, FreeText: "Leftovers")))
            .Content.ReadFromJsonAsync<MealPlanEntryDto>();

        Assert.Equal("Leftovers", planned!.FreeText);
        Assert.Null(planned.RecipeId);
        Assert.Null(planned.RecipeTitle);
    }

    [Fact]
    public async Task A_slot_needs_a_recipe_or_text_and_rejects_neither()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var neither = await PlanAsync(client, new MealPlanInput(Monday, MealSlot.Dinner));
        Assert.Equal(HttpStatusCode.BadRequest, neither.StatusCode);
    }

    /// <summary>
    /// Both fields at once is the linked-leftovers case (MEALS_DATA_CONTRACT §3.1) — the row reads
    /// "Leftovers" but still opens the recipe it came from, at the servings it was cooked at. It used
    /// to be a 400; this asserts the link and the text survive together, because storing
    /// "Leftovers of Pasta" as plain text is the shape the contract rules out.
    /// </summary>
    [Fact]
    public async Task Leftovers_can_carry_both_the_text_and_the_recipe_they_came_from()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var recipe = await CreateRecipeAsync(client, "Pasta");

        var planned = await (await PlanAsync(
                client,
                new MealPlanInput(Monday.AddDays(1), MealSlot.Lunch, recipe.Id, "Leftovers", ServingsOverride: 6)))
            .Content.ReadFromJsonAsync<MealPlanEntryDto>();

        Assert.Equal("Leftovers", planned!.FreeText);
        Assert.Equal(recipe.Id, planned.RecipeId);
        Assert.Equal("Pasta", planned.RecipeTitle);
        Assert.Equal(6, planned.ServingsOverride);
    }

    [Fact]
    public async Task Planning_an_unknown_recipe_is_404()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var missing = await PlanAsync(client, new MealPlanInput(Monday, MealSlot.Dinner, RecipeId: 999));

        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
    }

    [Fact]
    public async Task Clearing_empties_the_slot_and_clearing_an_empty_slot_is_a_no_op()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        await PlanAsync(client, new MealPlanInput(Monday, MealSlot.Dinner, FreeText: "Takeout"));

        var cleared = await client.DeleteAsync($"/api/meals/plan?date={Monday:yyyy-MM-dd}&slot=Dinner");
        Assert.Equal(HttpStatusCode.NoContent, cleared.StatusCode);

        // Absent and empty are the same thing, so clearing twice is not an error.
        var again = await client.DeleteAsync($"/api/meals/plan?date={Monday:yyyy-MM-dd}&slot=Dinner");
        Assert.Equal(HttpStatusCode.NoContent, again.StatusCode);

        var week = await client.GetFromJsonAsync<MealWeekDto>($"/api/meals/week?start={Monday:yyyy-MM-dd}");
        Assert.All(week!.Days, d => Assert.Empty(d.Entries));
    }

    [Fact]
    public async Task Conditional_plan_write_conflicts_on_a_stale_version()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        await PlanAsync(client, new MealPlanInput(Monday, MealSlot.Dinner, FreeText: "First"));

        // Someone else changes the slot, taking it to version 2.
        await PlanAsync(client, new MealPlanInput(Monday, MealSlot.Dinner, FreeText: "Theirs"), baseVersion: 1);

        var stale = await PlanAsync(client, new MealPlanInput(Monday, MealSlot.Dinner, FreeText: "Mine"), baseVersion: 1);

        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
        var current = await stale.Content.ReadFromJsonAsync<MealPlanEntryDto>();
        Assert.Equal("Theirs", current!.FreeText);
        Assert.Equal(2, current.Version);
    }

    [Fact]
    public async Task Deleting_a_planned_recipe_leaves_the_night_reading_its_title()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var recipe = await CreateRecipeAsync(client, "Chicken Piccata");
        await PlanAsync(client, new MealPlanInput(Monday, MealSlot.Dinner, RecipeId: recipe.Id));

        await client.DeleteAsync($"/api/recipes/{recipe.Id}");

        var week = await client.GetFromJsonAsync<MealWeekDto>($"/api/meals/week?start={Monday:yyyy-MM-dd}");
        var monday = Assert.Single(week!.Days[0].Entries);
        // The plan survives the recipe: what you ate on Monday is not erased by tidying the folder.
        Assert.Null(monday.RecipeId);
        Assert.Equal("Chicken Piccata", monday.FreeText);
    }

    [Fact]
    public async Task Week_excludes_days_outside_the_requested_range()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        await PlanAsync(client, new MealPlanInput(Monday.AddDays(-1), MealSlot.Dinner, FreeText: "Yesterday"));
        await PlanAsync(client, new MealPlanInput(Monday.AddDays(7), MealSlot.Dinner, FreeText: "Next week"));
        await PlanAsync(client, new MealPlanInput(Monday.AddDays(6), MealSlot.Dinner, FreeText: "Sunday"));

        var week = await client.GetFromJsonAsync<MealWeekDto>($"/api/meals/week?start={Monday:yyyy-MM-dd}");

        var planned = week!.Days.SelectMany(d => d.Entries).ToList();
        var only = Assert.Single(planned);
        Assert.Equal("Sunday", only.FreeText);
    }

    [Fact]
    public async Task Clearing_without_a_date_or_slot_is_refused_rather_than_guessed()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        await PlanAsync(client, new MealPlanInput(Monday, MealSlot.Breakfast, FreeText: "Toast"));

        // Model binding fills a missing non-nullable value type with default() and raises no error,
        // so an omitted slot used to mean "Breakfast" — clearing a plan nobody asked about and
        // answering 204 as though it were the right one.
        var noSlot = await client.DeleteAsync($"/api/meals/plan?date={Monday:yyyy-MM-dd}");
        Assert.Equal(HttpStatusCode.BadRequest, noSlot.StatusCode);

        var nothing = await client.DeleteAsync("/api/meals/plan");
        Assert.Equal(HttpStatusCode.BadRequest, nothing.StatusCode);

        // And the plan it would have silently deleted is still there.
        var week = await client.GetFromJsonAsync<MealWeekDto>($"/api/meals/week?start={Monday:yyyy-MM-dd}");
        Assert.Single(week!.Days[0].Entries);
    }

    [Fact]
    public async Task An_undefined_slot_number_is_refused()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        // JsonStringEnumConverter takes raw numbers as well as names, so without a check this stored
        // a row in a slot the week screen can neither render nor address.
        var res = await client.PutAsJsonAsync(
            "/api/meals/plan", new { date = "2026-08-03", slot = 99, freeText = "Nonsense" });

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task Overlong_plan_text_is_refused_rather_than_failing_at_the_column()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await PlanAsync(client, new MealPlanInput(Monday, MealSlot.Dinner, FreeText: new string('x', 201)));

        // The in-memory provider ignores HasMaxLength, so this asserts the controller's own guard —
        // which is the only thing standing between an overlong field and a 500 on SQL Server.
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task Different_slots_on_the_same_day_are_separate_entries()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await PlanAsync(client, new MealPlanInput(Monday, MealSlot.Lunch, FreeText: "Sandwiches"));
        await PlanAsync(client, new MealPlanInput(Monday, MealSlot.Dinner, FreeText: "Stew"));

        var week = await client.GetFromJsonAsync<MealWeekDto>($"/api/meals/week?start={Monday:yyyy-MM-dd}");

        // Ordered by slot, so lunch precedes dinner regardless of insertion order.
        Assert.Equal(new[] { "Lunch", "Dinner" }, week!.Days[0].Entries.Select(e => e.Slot));
    }

    // ---- Cooked history (MEALS_DATA_CONTRACT §3.2/§3.3) ----

    private static Task<HttpResponseMessage> EatenAsync(HttpClient client, DateOnly date, MealSlot slot, bool? wasEaten) =>
        client.PutAsJsonAsync("/api/meals/plan/eaten", new MealEatenInput(date, slot, wasEaten));

    private static async Task<RecipeSummaryDto> SummaryAsync(HttpClient client, int id) =>
        (await client.GetFromJsonAsync<List<RecipeSummaryDto>>("/api/recipes"))!.Single(r => r.Id == id);

    /// <summary>
    /// BUILD_ORDER Step 0's acceptance test: cooked twice, skipped once, and the skipped night must
    /// change neither number. This is the whole reason <c>wasEaten</c> exists — without it the folder's
    /// NOT LATELY sort counts nights nobody ate and quietly lies about what is overdue.
    /// </summary>
    [Fact]
    public async Task Cooked_history_counts_only_the_nights_that_were_actually_eaten()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var recipe = await CreateRecipeAsync(client, "Green Curry");

        var today = DateOnly.FromDateTime(DateTime.Now);
        var cookedFirst = today.AddDays(-20);
        var skipped = today.AddDays(-10);
        var cookedLast = today.AddDays(-4);

        foreach (var date in new[] { cookedFirst, skipped, cookedLast })
            await PlanAsync(client, new MealPlanInput(date, MealSlot.Dinner, RecipeId: recipe.Id));

        await EatenAsync(client, cookedFirst, MealSlot.Dinner, true);
        await EatenAsync(client, skipped, MealSlot.Dinner, false);
        await EatenAsync(client, cookedLast, MealSlot.Dinner, true);

        var summary = await SummaryAsync(client, recipe.Id);

        Assert.Equal(2, summary.TimesCooked);
        // The skipped night is the most recent of the three, so a naive "last planned" would report it.
        Assert.Equal(cookedLast, summary.LastCookedDate);
        Assert.Equal(skipped, summary.LastSkippedDate);
    }

    [Fact]
    public async Task An_unanswered_or_future_night_is_never_counted_as_cooked()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var recipe = await CreateRecipeAsync(client, "Ragu");
        var today = DateOnly.FromDateTime(DateTime.Now);

        // Past but unanswered, and answered-yes but still in the future. Neither is history.
        await PlanAsync(client, new MealPlanInput(today.AddDays(-3), MealSlot.Dinner, RecipeId: recipe.Id));
        await PlanAsync(client, new MealPlanInput(today.AddDays(3), MealSlot.Dinner, RecipeId: recipe.Id));
        await EatenAsync(client, today.AddDays(3), MealSlot.Dinner, true);

        var summary = await SummaryAsync(client, recipe.Id);

        Assert.Equal(0, summary.TimesCooked);
        Assert.Null(summary.LastCookedDate);
    }

    [Fact]
    public async Task Re_planning_a_night_onto_a_different_dish_drops_the_answer_it_was_given()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var first = await CreateRecipeAsync(client, "Ragu");
        var second = await CreateRecipeAsync(client, "Laksa");
        var night = DateOnly.FromDateTime(DateTime.Now).AddDays(-2);

        await PlanAsync(client, new MealPlanInput(night, MealSlot.Dinner, RecipeId: first.Id));
        await EatenAsync(client, night, MealSlot.Dinner, true);

        // Correcting the record: it was actually Laksa. The "yes we ate it" was about the Ragu.
        await PlanAsync(client, new MealPlanInput(night, MealSlot.Dinner, RecipeId: second.Id));

        var entry = (await client.GetFromJsonAsync<MealWeekDto>($"/api/meals/week?start={night:yyyy-MM-dd}"))!
            .Days[0].Entries.Single();
        Assert.Null(entry.WasEaten);
        // And neither recipe has been credited with a night nobody confirmed.
        Assert.Equal(0, (await SummaryAsync(client, first.Id)).TimesCooked);
        Assert.Equal(0, (await SummaryAsync(client, second.Id)).TimesCooked);
    }

    [Fact]
    public async Task Changing_only_the_servings_keeps_the_answer()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var recipe = await CreateRecipeAsync(client, "Ragu");
        var night = DateOnly.FromDateTime(DateTime.Now).AddDays(-2);

        await PlanAsync(client, new MealPlanInput(night, MealSlot.Dinner, RecipeId: recipe.Id));
        await EatenAsync(client, night, MealSlot.Dinner, true);
        await PlanAsync(client, new MealPlanInput(night, MealSlot.Dinner, RecipeId: recipe.Id, ServingsOverride: 6));

        Assert.Equal(1, (await SummaryAsync(client, recipe.Id)).TimesCooked);
    }

    // ---- Meals made of several recipes (MEALS_GROUPS) ----

    private static Task<HttpResponseMessage> AddToNightAsync(HttpClient client, DateOnly date, int recipeId, MealRole role) =>
        client.PutAsJsonAsync("/api/meals/plan",
            new MealPlanInput(date, MealSlot.Dinner, RecipeId: recipeId, Role: role, Replace: false));

    private static async Task<List<MealPlanEntryDto>> NightAsync(HttpClient client, DateOnly date)
    {
        var week = await client.GetFromJsonAsync<MealWeekDto>($"/api/meals/week?start={date:yyyy-MM-dd}");
        return week!.Days[0].Entries.ToList();
    }

    /// <summary>
    /// §7: a night holds two recipes with no naming and no extra taps beyond the second pick.
    /// </summary>
    [Fact]
    public async Task A_night_can_hold_several_recipes_without_naming_anything()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var main = await CreateRecipeAsync(client, "Spaghetti Bolognese");
        var side = await CreateRecipeAsync(client, "Garlic Toast");

        await PlanAsync(client, new MealPlanInput(Monday, MealSlot.Dinner, RecipeId: main.Id));
        await AddToNightAsync(client, Monday, side.Id, MealRole.Side);

        var night = await NightAsync(client, Monday);

        Assert.Equal(2, night.Count);
        Assert.Equal(["Spaghetti Bolognese", "Garlic Toast"], night.Select(e => e.RecipeTitle));
        // Order is Position, so the arrangement arrives in the order it is cooked.
        Assert.Equal([0, 1], night.Select(e => e.Position));
        Assert.Equal(["Main", "Side"], night.Select(e => e.Role));
    }

    /// <summary>The default is still replace, so every caller written before meals behaves as it did.</summary>
    [Fact]
    public async Task Planning_without_asking_to_add_still_replaces_the_whole_night()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var main = await CreateRecipeAsync(client, "Pasta");
        var side = await CreateRecipeAsync(client, "Salad");
        var other = await CreateRecipeAsync(client, "Roast");

        await PlanAsync(client, new MealPlanInput(Monday, MealSlot.Dinner, RecipeId: main.Id));
        await AddToNightAsync(client, Monday, side.Id, MealRole.Side);
        await PlanAsync(client, new MealPlanInput(Monday, MealSlot.Dinner, RecipeId: other.Id));

        var night = await NightAsync(client, Monday);

        var only = Assert.Single(night);
        Assert.Equal("Roast", only.RecipeTitle);
        // Collapsed back to one dish, so it is the main again.
        Assert.Equal("Main", only.Role);
    }

    /// <summary>A double-tap on the pick list must not put the same dish on twice.</summary>
    [Fact]
    public async Task Adding_the_same_recipe_twice_does_not_duplicate_it()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var main = await CreateRecipeAsync(client, "Pasta");
        var side = await CreateRecipeAsync(client, "Salad");

        await PlanAsync(client, new MealPlanInput(Monday, MealSlot.Dinner, RecipeId: main.Id));
        await AddToNightAsync(client, Monday, side.Id, MealRole.Side);
        await AddToNightAsync(client, Monday, side.Id, MealRole.Side);

        Assert.Equal(2, (await NightAsync(client, Monday)).Count);
    }

    /// <summary>
    /// Removing one dish leaves the rest of the night alone — distinct from cancelling the night.
    /// Dropping the main promotes whatever is left, because a night of only a side is unrenderable.
    /// </summary>
    [Fact]
    public async Task Removing_one_recipe_leaves_the_rest_and_repacks_the_arrangement()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var main = await CreateRecipeAsync(client, "Pasta");
        var side = await CreateRecipeAsync(client, "Salad");

        await PlanAsync(client, new MealPlanInput(Monday, MealSlot.Dinner, RecipeId: main.Id));
        await AddToNightAsync(client, Monday, side.Id, MealRole.Side);
        var night = await NightAsync(client, Monday);

        var removed = await client.DeleteAsync($"/api/meals/plan/entry/{night[0].Id}");
        Assert.Equal(HttpStatusCode.NoContent, removed.StatusCode);

        var left = Assert.Single(await NightAsync(client, Monday));
        Assert.Equal("Salad", left.RecipeTitle);
        Assert.Equal(0, left.Position);
        Assert.Equal("Main", left.Role);
    }

    /// <summary>Clearing the slot cancels the night — all of it, not just the main.</summary>
    [Fact]
    public async Task Clearing_a_slot_removes_the_whole_arrangement()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var main = await CreateRecipeAsync(client, "Pasta");
        var side = await CreateRecipeAsync(client, "Salad");

        await PlanAsync(client, new MealPlanInput(Monday, MealSlot.Dinner, RecipeId: main.Id));
        await AddToNightAsync(client, Monday, side.Id, MealRole.Side);
        await client.DeleteAsync($"/api/meals/plan?date={Monday:yyyy-MM-dd}&slot=Dinner");

        Assert.Empty(await NightAsync(client, Monday));
    }

    /// <summary>
    /// §7: cooking a meal increments the meal <b>and</b> each recipe; skipping it increments nothing.
    /// One confirmation covers the whole night — nobody ate the bolognese but not the garlic bread.
    /// </summary>
    [Fact]
    public async Task Confirming_a_night_credits_every_recipe_on_it()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var main = await CreateRecipeAsync(client, "Spaghetti Bolognese");
        var side = await CreateRecipeAsync(client, "Garlic Toast");
        var night = DateOnly.FromDateTime(DateTime.Now).AddDays(-3);

        await PlanAsync(client, new MealPlanInput(night, MealSlot.Dinner, RecipeId: main.Id));
        await AddToNightAsync(client, night, side.Id, MealRole.Side);
        await EatenAsync(client, night, MealSlot.Dinner, true);

        Assert.Equal(1, (await SummaryAsync(client, main.Id)).TimesCooked);
        Assert.Equal(1, (await SummaryAsync(client, side.Id)).TimesCooked);
    }

    [Fact]
    public async Task Skipping_a_night_credits_nothing_on_it()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var main = await CreateRecipeAsync(client, "Pasta");
        var side = await CreateRecipeAsync(client, "Salad");
        var night = DateOnly.FromDateTime(DateTime.Now).AddDays(-3);

        await PlanAsync(client, new MealPlanInput(night, MealSlot.Dinner, RecipeId: main.Id));
        await AddToNightAsync(client, night, side.Id, MealRole.Side);
        await EatenAsync(client, night, MealSlot.Dinner, false);

        Assert.Equal(0, (await SummaryAsync(client, main.Id)).TimesCooked);
        Assert.Equal(0, (await SummaryAsync(client, side.Id)).TimesCooked);
    }

    [Fact]
    public async Task Confirming_a_night_that_was_never_planned_is_404_rather_than_an_invented_row()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await EatenAsync(client, Monday, MealSlot.Dinner, true);

        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }
}
