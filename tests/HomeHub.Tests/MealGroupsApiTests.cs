namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Meals;

/// <summary>
/// Saved meals (MEALS_GROUPS): templates that expand into an arrangement, their history as a unit,
/// and the co-occurrence suggestion.
/// </summary>
public class MealGroupsApiTests
{
    private static readonly DateOnly Monday = new(2026, 8, 3);

    private static async Task<RecipeDto> RecipeAsync(HttpClient client, string title, int? totalMinutes = null) =>
        (await (await client.PostAsJsonAsync("/api/recipes", new RecipeInput(title, TotalMinutes: totalMinutes)))
            .Content.ReadFromJsonAsync<RecipeDto>())!;

    private static async Task<MealDto> MealAsync(HttpClient client, string name, params (int Id, MealRole Role)[] parts) =>
        (await (await client.PostAsJsonAsync("/api/meals/saved", new MealInput(
            name, parts.Select(p => new MealComponentInput(p.Id, p.Role)).ToList())))
            .Content.ReadFromJsonAsync<MealDto>())!;

    private static Task<HttpResponseMessage> PlanAsync(HttpClient client, MealPlanInput input) =>
        client.PutAsJsonAsync("/api/meals/plan", input);

    private static Task<HttpResponseMessage> EatenAsync(HttpClient client, DateOnly date, bool? eaten) =>
        client.PutAsJsonAsync("/api/meals/plan/eaten", new MealEatenInput(date, MealSlot.Dinner, eaten));

    [Fact]
    public async Task A_meal_is_created_with_its_components_in_order()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var main = await RecipeAsync(client, "Spaghetti Bolognese", 35);
        var side = await RecipeAsync(client, "Garlic Toast", 12);

        var meal = await MealAsync(client, "Spaghetti Night", (main.Id, MealRole.Main), (side.Id, MealRole.Side));

        Assert.Equal("Spaghetti Night", meal.Name);
        Assert.Equal(["Spaghetti Bolognese", "Garlic Toast"], meal.Components.Select(c => c.Title));
        Assert.Equal(["Main", "Side"], meal.Components.Select(c => c.Role));
        // 47 MIN TOTAL — the sum the detail screen shows.
        Assert.Equal(47, meal.TotalMinutes);
    }

    /// <summary>Exactly one main, and it is the first component whatever the caller claimed.</summary>
    [Fact]
    public async Task The_first_component_is_always_the_main()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var a = await RecipeAsync(client, "A");
        var b = await RecipeAsync(client, "B");

        var meal = await MealAsync(client, "Odd", (a.Id, MealRole.Dessert), (b.Id, MealRole.Side));

        Assert.Equal("Main", meal.Components[0].Role);
        Assert.Single(meal.Components, c => c.Role == "Main");
    }

    [Fact]
    public async Task A_meal_needs_a_name_and_at_least_one_recipe()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var a = await RecipeAsync(client, "A");

        var noName = await client.PostAsJsonAsync("/api/meals/saved",
            new MealInput("  ", [new MealComponentInput(a.Id)]));
        var noParts = await client.PostAsJsonAsync("/api/meals/saved", new MealInput("Empty"));
        var duplicate = await client.PostAsJsonAsync("/api/meals/saved",
            new MealInput("Twice", [new MealComponentInput(a.Id), new MealComponentInput(a.Id)]));

        Assert.Equal(HttpStatusCode.BadRequest, noName.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, noParts.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, duplicate.StatusCode);
    }

    /// <summary>
    /// §6.2: assigning expands into plan entries. The night does not reference the meal, so editing
    /// the template afterwards must not rewrite a night already planned.
    /// </summary>
    [Fact]
    public async Task Assigning_a_meal_expands_it_and_editing_the_template_never_rewrites_the_night()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var main = await RecipeAsync(client, "Spaghetti Bolognese", 35);
        var side = await RecipeAsync(client, "Garlic Toast", 12);
        var dessert = await RecipeAsync(client, "Tiramisu", 20);
        var meal = await MealAsync(client, "Spaghetti Night", (main.Id, MealRole.Main), (side.Id, MealRole.Side));

        await client.PostAsJsonAsync($"/api/meals/saved/{meal.Id}/assign",
            new AssignMealInput(Monday, MealSlot.Dinner, meal.Id, ServingsOverride: 6));

        var week = await client.GetFromJsonAsync<MealWeekDto>($"/api/meals/week?start={Monday:yyyy-MM-dd}");
        var night = week!.Days[0].Entries.ToList();
        Assert.Equal(["Spaghetti Bolognese", "Garlic Toast"], night.Select(e => e.RecipeTitle));
        Assert.All(night, e => Assert.Equal(6, e.ServingsOverride));

        // The template gains a dessert...
        await client.PutAsJsonAsync($"/api/meals/saved/{meal.Id}", new MealInput(
            "Spaghetti Night",
            [new MealComponentInput(main.Id), new MealComponentInput(side.Id, MealRole.Side),
             new MealComponentInput(dessert.Id, MealRole.Dessert)]));

        // ...and Monday is untouched, because it never pointed at the template.
        var after = await client.GetFromJsonAsync<MealWeekDto>($"/api/meals/week?start={Monday:yyyy-MM-dd}");
        Assert.Equal(2, after!.Days[0].Entries.Count);
    }

    [Fact]
    public async Task Assigning_a_meal_replaces_whatever_was_on_the_night()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var old = await RecipeAsync(client, "Old Plan");
        var main = await RecipeAsync(client, "Main");
        var meal = await MealAsync(client, "Night", (main.Id, MealRole.Main));

        await PlanAsync(client, new MealPlanInput(Monday, MealSlot.Dinner, RecipeId: old.Id));
        await client.PostAsJsonAsync($"/api/meals/saved/{meal.Id}/assign",
            new AssignMealInput(Monday, MealSlot.Dinner, meal.Id));

        var week = await client.GetFromJsonAsync<MealWeekDto>($"/api/meals/week?start={Monday:yyyy-MM-dd}");
        var only = Assert.Single(week!.Days[0].Entries);
        Assert.Equal("Main", only.RecipeTitle);
    }

    /// <summary>
    /// §5: the meal's own history counts nights where the whole set was confirmed, while each recipe
    /// counts every night it was on. A side used in several meals honestly reads higher than any one
    /// of them.
    /// </summary>
    [Fact]
    public async Task A_meals_history_counts_the_set_while_each_recipe_counts_itself()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var main = await RecipeAsync(client, "Spaghetti Bolognese");
        var side = await RecipeAsync(client, "Garlic Toast");
        var otherMain = await RecipeAsync(client, "Lasagne");
        var meal = await MealAsync(client, "Spaghetti Night", (main.Id, MealRole.Main), (side.Id, MealRole.Side));

        var today = DateOnly.FromDateTime(DateTime.Now);
        // Two nights of the whole meal...
        foreach (var offset in new[] { -10, -5 })
        {
            var date = today.AddDays(offset);
            await PlanAsync(client, new MealPlanInput(date, MealSlot.Dinner, RecipeId: main.Id));
            await PlanAsync(client, new MealPlanInput(date, MealSlot.Dinner, RecipeId: side.Id, Role: MealRole.Side, Replace: false));
            await EatenAsync(client, date, true);
        }
        // ...and one night where the toast rode along with something else.
        var solo = today.AddDays(-2);
        await PlanAsync(client, new MealPlanInput(solo, MealSlot.Dinner, RecipeId: otherMain.Id));
        await PlanAsync(client, new MealPlanInput(solo, MealSlot.Dinner, RecipeId: side.Id, Role: MealRole.Side, Replace: false));
        await EatenAsync(client, solo, true);

        var meals = await client.GetFromJsonAsync<List<MealSummaryDto>>("/api/meals/saved");
        var summary = meals!.Single(m => m.Id == meal.Id);
        var recipes = (await client.GetFromJsonAsync<List<RecipeSummaryDto>>("/api/recipes"))!;

        Assert.Equal(2, summary.TimesCooked);
        Assert.Equal(today.AddDays(-5), summary.LastCookedDate);
        // The toast was eaten three times, and says so — that is the honest number.
        Assert.Equal(3, recipes.Single(r => r.Id == side.Id).TimesCooked);
        Assert.Equal(2, recipes.Single(r => r.Id == main.Id).TimesCooked);
    }

    /// <summary>
    /// §7: the promote strip appears on the third <b>confirmed</b> co-occurrence, never the third
    /// planned one.
    /// </summary>
    [Fact]
    public async Task Co_occurrence_counts_confirmed_nights_only()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var main = await RecipeAsync(client, "Curry");
        var side = await RecipeAsync(client, "Naan");
        var today = DateOnly.FromDateTime(DateTime.Now);

        async Task Night(int offset, bool? eaten)
        {
            var date = today.AddDays(offset);
            await PlanAsync(client, new MealPlanInput(date, MealSlot.Dinner, RecipeId: main.Id));
            await PlanAsync(client, new MealPlanInput(date, MealSlot.Dinner, RecipeId: side.Id, Role: MealRole.Side, Replace: false));
            if (eaten is not null) await EatenAsync(client, date, eaten);
        }

        // Three nights planned, but only two confirmed — under the threshold.
        await Night(-9, true);
        await Night(-6, true);
        await Night(-3, null);

        var before = await client.GetFromJsonAsync<List<CoOccurrenceDto>>("/api/meals/saved/co-occurrences");
        Assert.Empty(before!);

        // Confirming the third crosses it.
        await EatenAsync(client, today.AddDays(-3), true);

        var after = await client.GetFromJsonAsync<List<CoOccurrenceDto>>("/api/meals/saved/co-occurrences");
        var pairing = Assert.Single(after!);
        Assert.Equal(3, pairing.Times);
        Assert.Equal([main.Id, side.Id], pairing.RecipeIds.Order());
    }

    /// <summary>A set already saved as a meal has nothing left to offer.</summary>
    [Fact]
    public async Task A_pairing_already_saved_is_not_offered_again()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var main = await RecipeAsync(client, "Curry");
        var side = await RecipeAsync(client, "Naan");
        var today = DateOnly.FromDateTime(DateTime.Now);

        foreach (var offset in new[] { -9, -6, -3 })
        {
            var date = today.AddDays(offset);
            await PlanAsync(client, new MealPlanInput(date, MealSlot.Dinner, RecipeId: main.Id));
            await PlanAsync(client, new MealPlanInput(date, MealSlot.Dinner, RecipeId: side.Id, Role: MealRole.Side, Replace: false));
            await EatenAsync(client, date, true);
        }
        Assert.Single((await client.GetFromJsonAsync<List<CoOccurrenceDto>>("/api/meals/saved/co-occurrences"))!);

        await MealAsync(client, "Curry Night", (main.Id, MealRole.Main), (side.Id, MealRole.Side));

        Assert.Empty((await client.GetFromJsonAsync<List<CoOccurrenceDto>>("/api/meals/saved/co-occurrences"))!);
    }

    /// <summary>§3: deleting a meal never deletes its recipes.</summary>
    [Fact]
    public async Task Deleting_a_meal_leaves_its_recipes_alone()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var main = await RecipeAsync(client, "Spaghetti Bolognese");
        var side = await RecipeAsync(client, "Garlic Toast");
        var meal = await MealAsync(client, "Spaghetti Night", (main.Id, MealRole.Main), (side.Id, MealRole.Side));

        var deleted = await client.DeleteAsync($"/api/meals/saved/{meal.Id}");
        Assert.Equal(HttpStatusCode.NoContent, deleted.StatusCode);

        var recipes = await client.GetFromJsonAsync<List<RecipeSummaryDto>>("/api/recipes");
        Assert.Contains(recipes!, r => r.Id == main.Id);
        Assert.Contains(recipes!, r => r.Id == side.Id);
    }

    [Fact]
    public async Task A_stale_meal_edit_conflicts_rather_than_overwriting()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var a = await RecipeAsync(client, "A");
        var meal = await MealAsync(client, "Night", (a.Id, MealRole.Main));

        await client.PutAsJsonAsync($"/api/meals/saved/{meal.Id}?baseVersion={meal.Version}",
            new MealInput("Theirs", [new MealComponentInput(a.Id)]));
        var stale = await client.PutAsJsonAsync($"/api/meals/saved/{meal.Id}?baseVersion={meal.Version}",
            new MealInput("Mine", [new MealComponentInput(a.Id)]));

        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
        var current = await stale.Content.ReadFromJsonAsync<MealDto>();
        Assert.Equal("Theirs", current!.Name);
    }
}
