namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Pantry;

/// <summary>
/// The order a shop is walked (SETTINGS_AND_IMPORT §2, KITCHEN_LOOP_ADDENDUM §6).
/// </summary>
/// <remarks>
/// S2's rules are few and specific: the order is per shop, dragging always wins, and an aisle the
/// order does not name is still shown — last, rather than hidden. Each is one test here.
/// </remarks>
public class AisleOrderTests
{
    private static Task<HttpResponseMessage> SetAsync(HttpClient client, string store, params string[] aisles) =>
        client.PutAsJsonAsync($"/api/pantry/aisles?store={Uri.EscapeDataString(store)}",
            new AisleOrderInput(aisles));

    private static Task<AisleOrderDto?> GetAsync(HttpClient client, string store) =>
        client.GetFromJsonAsync<AisleOrderDto>($"/api/pantry/aisles?store={Uri.EscapeDataString(store)}");

    /// <summary>§2: the order is stored per shop, and the array order is the order.</summary>
    [Fact]
    public async Task An_order_is_stored_first_to_last()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        (await SetAsync(client, "Tesco", "Produce", "Chilled", "Cupboard")).EnsureSuccessStatusCode();
        var order = await GetAsync(client, "Tesco");

        Assert.Equal(["Produce", "Chilled", "Cupboard"], order!.Aisles.Select(a => a.Aisle));
        Assert.Equal([0, 1, 2], order.Aisles.Select(a => a.Position));
    }

    /// <summary>
    /// §2: <b>per shop</b> — "a butcher is not a supermarket and one order can't serve both".
    /// </summary>
    [Fact]
    public async Task Each_shop_keeps_its_own_order()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await SetAsync(client, "Tesco", "Produce", "Chilled");
        await SetAsync(client, "Butcher", "Counter");

        Assert.Equal(["Produce", "Chilled"], (await GetAsync(client, "Tesco"))!.Aisles.Select(a => a.Aisle));
        Assert.Equal(["Counter"], (await GetAsync(client, "Butcher"))!.Aisles.Select(a => a.Aisle));
    }

    /// <summary>§2: dragging always wins — a new order replaces the old one outright.</summary>
    [Fact]
    public async Task Dragging_replaces_whatever_was_there()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await SetAsync(client, "Tesco", "Produce", "Chilled", "Cupboard");
        await SetAsync(client, "Tesco", "Cupboard", "Produce");

        var order = await GetAsync(client, "Tesco");

        // Chilled is gone rather than demoted: the household sent the order it wants.
        Assert.Equal(["Cupboard", "Produce"], order!.Aisles.Select(a => a.Aisle));
    }

    /// <summary>
    /// §2: an aisle the order has never named still appears, after the ones it has.
    /// </summary>
    /// <remarks>
    /// This is the <c>ELSEWHERE</c> rule. Hiding it would leave lines in the basket that the shop
    /// screen never lists, which is the failure the "empty aisles stay listed" note exists to stop.
    /// </remarks>
    [Fact]
    public async Task An_unlisted_aisle_sorts_last_rather_than_vanishing()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await client.PostAsJsonAsync("/api/grocery", new GroceryInput("Sourdough", null, null, null, null, null, null, null, null, Aisle: "Bakery"));
        await SetAsync(client, "Tesco", "Produce");

        var order = await GetAsync(client, "Tesco");

        Assert.Equal(["Produce", "Bakery"], order!.Aisles.Select(a => a.Aisle));
        Assert.Equal(1, order.Aisles.Single(a => a.Aisle == "Bakery").LineCount);
    }

    /// <summary>
    /// §2: the count beside each aisle is of what is still to be bought. A ticked line has been
    /// bought, so it stops counting toward the walk.
    /// </summary>
    [Fact]
    public async Task The_count_is_of_open_lines_only()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var line = (await (await client.PostAsJsonAsync("/api/grocery",
            new GroceryInput("Apples", null, null, null, null, null, null, null, null, Aisle: "Produce"))).Content.ReadFromJsonAsync<GroceryLineDto>())!;
        await client.PostAsJsonAsync("/api/grocery", new GroceryInput("Pears", null, null, null, null, null, null, null, null, Aisle: "Produce"));
        await SetAsync(client, "Tesco", "Produce");

        Assert.Equal(2, (await GetAsync(client, "Tesco"))!.Aisles.Single().LineCount);

        await client.PostAsJsonAsync($"/api/grocery/{line.Id}/check", new { });

        Assert.Equal(1, (await GetAsync(client, "Tesco"))!.Aisles.Single().LineCount);
    }

    /// <summary>
    /// The same aisle twice in one order is a drag that half-failed, not two aisles. Keeping both
    /// would list it twice in the shop.
    /// </summary>
    [Fact]
    public async Task An_aisle_cannot_appear_twice_in_one_order()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await SetAsync(client, "Tesco", "Produce", "produce", "Chilled");

        Assert.Equal(["Produce", "Chilled"], (await GetAsync(client, "Tesco"))!.Aisles.Select(a => a.Aisle));
    }

    /// <summary>
    /// A line filed under another casing of the same aisle counts toward it, and does not also
    /// appear under <c>ELSEWHERE</c>.
    /// </summary>
    /// <remarks>
    /// The two halves of this were computed with different comparers, so a casing mismatch made the
    /// aisle read <c>empty</c> <i>and</i> dropped its lines out of the unlisted set. The aisle
    /// disappeared from the panel entirely, taking the household's basket with it — which is the
    /// exact failure the "empty aisles stay listed" rule exists to stop.
    /// </remarks>
    [Fact]
    public async Task An_aisle_counts_its_lines_whatever_the_casing()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await client.PostAsJsonAsync("/api/grocery", new GroceryInput(
            "Apples", null, null, null, null, null, null, null, null, Aisle: "produce"));
        await SetAsync(client, "Tesco", "Produce");

        var order = await GetAsync(client, "Tesco");

        Assert.Equal(["Produce"], order!.Aisles.Select(a => a.Aisle));
        Assert.Equal(1, order.Aisles.Single().LineCount);
    }

    /// <summary>A shop has to be named — an order belongs to somewhere.</summary>
    [Fact]
    public async Task An_order_without_a_shop_is_refused()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PutAsJsonAsync("/api/pantry/aisles?store=", new AisleOrderInput(["Produce"]));

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }
}
