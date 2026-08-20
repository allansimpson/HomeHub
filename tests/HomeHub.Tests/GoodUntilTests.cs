namespace HomeHub.Tests;

using System.Net.Http.Json;
using HomeHub.Api.Data;
using HomeHub.Api.Pantry;
using Microsoft.Extensions.DependencyInjection;

/// <summary>
/// The one sanctioned exception to the expiry ban (ADD_TO_PANTRY §6).
/// </summary>
/// <remarks>
/// <c>PANTRY_DATA_CONTRACT</c> §5 rules expiry dates out, on the grounds that nobody enters them and
/// nothing can infer them reliably. This field survives that reasoning only by refusing everything
/// the ban was about — so these tests are about what it must <i>not</i> do.
/// </remarks>
public class GoodUntilTests
{
    private static Task<HttpResponseMessage> AddAsync(HttpClient client, DateOnly? goodUntil) =>
        client.PostAsJsonAsync("/api/pantry", new PantryItemInput(
            "Tomato sauce", "Cupboard", "Counted", 4, "tins", null, ProfileId: 1,
            GoodUntil: goodUntil));

    /// <summary>A date the packet states is kept, and reported back.</summary>
    [Fact]
    public async Task A_date_off_the_packet_is_kept()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var date = new DateOnly(2027, 3, 14);
        var item = await (await AddAsync(client, date)).Content.ReadFromJsonAsync<PantryItemDto>();

        Assert.Equal(date, item!.GoodUntil);
    }

    /// <summary>§6: optional, and its absence never blocks a save.</summary>
    [Fact]
    public async Task Nothing_is_required()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await AddAsync(client, null);

        res.EnsureSuccessStatusCode();
        var item = await res.Content.ReadFromJsonAsync<PantryItemDto>();
        Assert.Null(item!.GoodUntil);
    }

    /// <summary>
    /// §6: the date's provenance is recorded, because the whole exception rests on it.
    /// </summary>
    /// <remarks>
    /// A date somebody read off a packet is worth having; one the app worked out for itself is
    /// exactly what the ban exists to prevent. <see cref="GoodUntilSource"/> has no
    /// <c>Inferred</c> member, so the unwanted case is unrepresentable rather than merely
    /// discouraged.
    /// </remarks>
    [Fact]
    public async Task The_date_records_that_a_person_typed_it()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var item = await (await AddAsync(client, new DateOnly(2027, 3, 14)))
            .Content.ReadFromJsonAsync<PantryItemDto>();

        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
        var saved = db.PantryItems.Single(i => i.Id == item!.Id);

        Assert.Equal(GoodUntilSource.Typed, saved.GoodUntilSource);
    }

    /// <summary>
    /// §6: <b>never the subject of a notification, badge or counter.</b> It sorts; it does not warn.
    /// </summary>
    /// <remarks>
    /// The market study found Cooklist and KitchenPal both pushing expiry alerts built on barcode
    /// lookups that resolve roughly a third of products. A date in the past here must change the
    /// tally not at all — if it ever starts counting, this section has become one of them.
    /// </remarks>
    [Fact]
    public async Task A_date_in_the_past_raises_nothing()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await AddAsync(client, new DateOnly(2000, 1, 1));

        var list = await client.GetFromJsonAsync<PantryListDto>("/api/pantry");

        // Four tins on the shelf and a date long gone: still not low, still not out, still no count.
        Assert.Equal(0, list!.ProbablyLow);
        Assert.Equal(0, list.ProbablyOut);
    }
}
