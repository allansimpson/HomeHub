namespace HomeHub.Tests;

using System.Net.Http.Json;
using HomeHub.Api.Pantry;

/// <summary>
/// `WHERE IT LIVES` — the per-item shelf, when it was last put there, and whether that is where it
/// usually is.
/// </summary>
/// <remarks>
/// The section exists because the three locations answer "it is in the cupboard" and not "where in
/// the cupboard". Design settled its shape on 2026-09-01; the two lines below the place are the
/// awkward ones, and each has a rule that is easy to get subtly wrong:
/// <list type="bullet">
/// <item><c>since</c> dates the last <i>move</i>, falling back to the day the item arrived.</item>
/// <item><c>n of the last 4</c> counts <i>sightings</i>, not moves — a jar that has never moved is
/// exactly the one the household is most certain about — and is omitted entirely below two, because
/// one look is not evidence of a habit.</item>
/// </list>
/// </remarks>
public class PantryShelfTests
{
    private static async Task<PantryItemDto> AddAsync(
        HttpClient client, string name, string location = "Cupboard")
    {
        var res = await client.PostAsJsonAsync("/api/pantry", new PantryItemInput(
            name, location, "Counted", 1, "ea", null, ProfileId: 1));
        res.EnsureSuccessStatusCode();
        return (await res.Content.ReadFromJsonAsync<PantryItemDto>())!;
    }

    private static async Task<PantryItemDto> PatchAsync(
        HttpClient client, PantryItemDto item, string? location = null, string? shelf = null,
        decimal? quantity = null)
    {
        var res = await client.PatchAsJsonAsync($"/api/pantry/{item.Id}", new PantryItemInput(
            item.Name, location ?? item.Location, item.Tracking, quantity ?? item.Quantity,
            item.Unit, item.EstimateState, ProfileId: 1, Shelf: shelf));
        res.EnsureSuccessStatusCode();
        return (await res.Content.ReadFromJsonAsync<PantryItemDto>())!;
    }

    private static Task<PantryItemDto?> GetAsync(HttpClient client, int id) =>
        client.GetFromJsonAsync<PantryItemDto>($"/api/pantry/{id}");

    [Fact]
    public async Task A_shelf_is_free_text_and_survives_the_round_trip()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var item = await AddAsync(client, "Plain flour");

        var moved = await PatchAsync(client, item, shelf: "behind the pasta");

        // The phrase nobody's enum was going to hold, which is the entire argument for free text.
        Assert.Equal("behind the pasta", moved.Shelf);
        Assert.Equal("behind the pasta", (await GetAsync(client, item.Id))!.Shelf);
    }

    /// <summary>
    /// <b>An omitted shelf leaves the stored one alone.</b> A scan and a delivery line PATCH the same
    /// record and neither has an opinion about shelves — so treating absence as "clear it" would have
    /// the pantry forget where everything is on every restock.
    /// </summary>
    [Fact]
    public async Task Silence_does_not_clear_a_shelf_but_an_empty_string_does()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var item = await AddAsync(client, "Capers");
        item = await PatchAsync(client, item, shelf: "door shelf");

        // A write that says nothing about place — the shape a restock sends.
        var restocked = await PatchAsync(client, item, quantity: 4);
        Assert.Equal("door shelf", restocked.Shelf);

        var cleared = await PatchAsync(client, restocked, shelf: "");
        Assert.Null(cleared.Shelf);
    }

    [Fact]
    public async Task Moving_writes_its_own_event_rather_than_a_correction()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var item = await AddAsync(client, "Peas");

        await PatchAsync(client, item, location: "Freezer");

        var events = await client.GetFromJsonAsync<List<PantryEventDto>>($"/api/pantry/{item.Id}/events");
        Assert.Contains(events!, e => e.Kind == nameof(PantryEventKind.Moved));
    }

    /// <summary>
    /// A shelf change within one location is still a move. `Cupboard → Cupboard · behind the pasta`
    /// is something somebody did and would want dated.
    /// </summary>
    [Fact]
    public async Task Changing_only_the_shelf_counts_as_a_move()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var item = await AddAsync(client, "Rice");

        await PatchAsync(client, item, shelf: "top shelf");

        var events = await client.GetFromJsonAsync<List<PantryEventDto>>($"/api/pantry/{item.Id}/events");
        Assert.Contains(events!, e => e.Kind == nameof(PantryEventKind.Moved));
    }

    [Fact]
    public async Task Since_dates_the_last_move_and_falls_back_to_when_it_arrived()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var item = await AddAsync(client, "Lasagne sheets");

        // Never moved: the line still reads, dated from arrival. Design preferred that to a blank —
        // a thing that arrived in the cupboard in June has been there since June.
        var fresh = (await GetAsync(client, item.Id))!;
        Assert.NotNull(fresh.InPlaceSinceUtc);

        await PatchAsync(client, item, location: "Freezer");
        var moved = (await GetAsync(client, item.Id))!;

        Assert.NotNull(moved.InPlaceSinceUtc);
        Assert.True(moved.InPlaceSinceUtc >= fresh.InPlaceSinceUtc);
    }

    /// <summary>
    /// One sighting is not a habit. The row is omitted rather than rendered as `1 of the last 1`,
    /// which would claim maximum confidence off minimum evidence.
    /// </summary>
    [Fact]
    public async Task Usually_kept_here_is_omitted_until_there_is_more_than_one_sighting()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var item = await AddAsync(client, "Cat litter");

        var fresh = (await GetAsync(client, item.Id))!;
        Assert.Null(fresh.KeptHereCount);
        Assert.Null(fresh.KeptHereOf);
    }

    [Fact]
    public async Task Usually_kept_here_counts_the_sightings_that_agree_with_where_it_is_now()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var item = await AddAsync(client, "Butter");

        // Three sightings in the cupboard, then a move to the fridge. The move is itself a sighting,
        // so the fridge has one and the cupboard three.
        item = await PatchAsync(client, item, quantity: 2);
        item = await PatchAsync(client, item, quantity: 3);
        item = await PatchAsync(client, item, location: "Fridge");

        var dto = (await GetAsync(client, item.Id))!;

        Assert.Equal(4, dto.KeptHereOf);
        // Only the move itself found it in the fridge — so this reads `1 of the last 4`, which is the
        // line doing its job: it is telling you this is not where the thing usually lives.
        Assert.Equal(1, dto.KeptHereCount);
    }

    /// <summary>
    /// The shelf is compared as well as the location, because the line sits under
    /// `Cupboard · middle shelf` and "here" is the whole of what that says.
    /// </summary>
    [Fact]
    public async Task A_different_shelf_in_the_same_location_is_not_here()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var item = await AddAsync(client, "Tinned tomatoes");

        item = await PatchAsync(client, item, shelf: "top shelf");
        item = await PatchAsync(client, item, quantity: 5);
        item = await PatchAsync(client, item, shelf: "behind the pasta");

        var dto = (await GetAsync(client, item.Id))!;

        Assert.NotNull(dto.KeptHereOf);
        Assert.True(dto.KeptHereCount < dto.KeptHereOf,
            "sightings on the old shelf must not count as agreeing with the new one");
    }

    [Fact]
    public async Task Shelf_suggestions_are_scoped_to_the_location_asked_about()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var flour = await AddAsync(client, "Plain flour");
        await PatchAsync(client, flour, shelf: "behind the pasta");
        var peas = await AddAsync(client, "Peas", location: "Freezer");
        await PatchAsync(client, peas, shelf: "bottom drawer");

        var cupboard = await client.GetFromJsonAsync<List<string>>("/api/pantry/shelves?location=Cupboard");
        var freezer = await client.GetFromJsonAsync<List<string>>("/api/pantry/shelves?location=Freezer");

        // A freezer offers freezer places. Offering "behind the pasta" to somebody filing a bag of
        // peas is how a free-text field becomes a list of other people's answers.
        Assert.Contains("behind the pasta", cupboard!);
        Assert.DoesNotContain("behind the pasta", freezer!);
        Assert.Contains("bottom drawer", freezer!);
    }
}
