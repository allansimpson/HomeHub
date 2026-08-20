namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Pantry;

/// <summary>
/// How long the household reckons things last (SETTINGS_AND_IMPORT §1).
/// </summary>
/// <remarks>
/// The panel states its own blast radius twice, and these tests hold it to that: these numbers
/// decide what floats to the top of <i>worth using soon</i> and <b>nothing else</b>. Never a use-by
/// date, never a notification.
/// </remarks>
public class ShelfLifeTests
{
    private static Task<List<ShelfLifeDto>?> ReadAsync(HttpClient client) =>
        client.GetFromJsonAsync<List<ShelfLifeDto>>("/api/pantry/shelf-life");

    /// <summary>
    /// An empty settings screen teaches nothing — the household needs to see what the panel
    /// currently believes before it can disagree usefully.
    /// </summary>
    [Fact]
    public async Task The_defaults_are_there_on_first_read()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var rows = await ReadAsync(client);

        Assert.NotEmpty(rows!);
        Assert.Contains(rows!, r => r.FoodKind == "Leafy greens" && r.State == nameof(FoodState.Fresh));
        Assert.All(rows!, r => Assert.True(r.IsSeeded));
    }

    /// <summary>
    /// §1: grouped by the state food is in, not by aisle — how long a jar lasts depends on whether
    /// it has been opened, not on where it was sold.
    /// </summary>
    [Fact]
    public async Task Assumptions_are_grouped_by_the_state_food_is_in()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var rows = await ReadAsync(client);

        Assert.Contains(rows!, r => r.State == nameof(FoodState.Fresh));
        Assert.Contains(rows!, r => r.State == nameof(FoodState.Chilled));
        Assert.Contains(rows!, r => r.State == nameof(FoodState.Opened));
    }

    /// <summary>Editing one changes it, and marks it as no longer a shipped default.</summary>
    [Fact]
    public async Task Editing_one_marks_it_as_the_households_own()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var row = (await ReadAsync(client))!.First(r => r.FoodKind == "Leafy greens");
        var updated = await (await client.PatchAsJsonAsync(
            $"/api/pantry/shelf-life/{row.Id}", new ShelfLifeInput(9)))
            .Content.ReadFromJsonAsync<ShelfLifeDto>();

        Assert.Equal(9, updated!.Days);
        Assert.False(updated.IsSeeded);
    }

    /// <summary>
    /// A day is the floor. Zero would mean "already gone", which is a fact about one item rather
    /// than an assumption about a kind of food.
    /// </summary>
    [Fact]
    public async Task A_shelf_life_of_nothing_is_refused()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var row = (await ReadAsync(client))!.First();
        var res = await client.PatchAsJsonAsync($"/api/pantry/shelf-life/{row.Id}", new ShelfLifeInput(0));

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    /// <summary>`PUT THEM BACK` restores every default, including ones somebody moved.</summary>
    [Fact]
    public async Task Putting_them_back_restores_the_shipped_numbers()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var row = (await ReadAsync(client))!.First(r => r.FoodKind == "Leafy greens");
        await client.PatchAsJsonAsync($"/api/pantry/shelf-life/{row.Id}", new ShelfLifeInput(99));

        await client.PostAsync("/api/pantry/shelf-life/reset", null);

        var after = (await ReadAsync(client))!.First(r => r.FoodKind == "Leafy greens");
        Assert.Equal(5, after.Days);
        Assert.True(after.IsSeeded);
    }

    /// <summary>
    /// §1's blast radius, stated as a test: these numbers <b>never</b> become a warning.
    /// </summary>
    /// <remarks>
    /// Setting every assumption to a single day must not make a single item read as low or out. If
    /// this ever fails, the section has grown the expiry alerts the market study found in Cooklist
    /// and KitchenPal and deliberately refused to copy.
    /// </remarks>
    [Fact]
    public async Task Shelf_life_never_becomes_a_warning()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await client.PostAsJsonAsync("/api/pantry", new PantryItemInput(
            "Leafy greens", "Fridge", "Counted", 4, "bags", null, ProfileId: 1));

        foreach (var row in (await ReadAsync(client))!)
        {
            await client.PatchAsJsonAsync($"/api/pantry/shelf-life/{row.Id}", new ShelfLifeInput(1));
        }

        var list = await client.GetFromJsonAsync<PantryListDto>("/api/pantry");

        Assert.Equal(0, list!.ProbablyLow);
        Assert.Equal(0, list.ProbablyOut);
    }
}
