namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Calendar.Capture;
using HomeHub.Api.Kitchen;

/// <summary>
/// Reading the Kitchen's two kinds of photograph (RECIPES §3, SETTINGS_AND_IMPORT §3).
/// </summary>
/// <remarks>
/// The properties worth pinning are all about restraint: a reading writes nothing, an unreadable
/// line is kept rather than dropped, and "no reader configured" never comes back phrased as though
/// the photograph were at fault.
/// </remarks>
public class KitchenPhotoReadingTests
{
    /// <summary>A one-pixel PNG — the smallest thing that is unambiguously an image.</summary>
    private const string PngBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    /// <summary>A reader that answers whatever the test handed it. The model is never reached.</summary>
    private sealed class StubReader : IKitchenPhotoReader
    {
        public bool IsAvailable => true;
        public RecipeReading Recipe { get; init; } = RecipeReading.Nothing("nothing");
        public PurchaseReading Purchases { get; init; } = PurchaseReading.Nothing("nothing");

        public Task<RecipeReading> ReadRecipeAsync(NormalizedImage image, CancellationToken ct) =>
            Task.FromResult(Recipe);

        public Task<PurchaseReading> ReadPurchasesAsync(NormalizedImage image, CancellationToken ct) =>
            Task.FromResult(Purchases);
    }

    private static object Photo() => new { imageBase64 = PngBase64, mediaType = "image/png" };

    [Fact]
    public async Task A_recipe_reading_keeps_every_line_and_counts_the_unclear_ones()
    {
        using var app = new HubAppFactory
        {
            KitchenPhotoReader = new StubReader
            {
                Recipe = new RecipeReading(
                    true,
                    "Ragù",
                    6,
                    [new ReadLine("500 g beef mince", false), new ReadLine("2 t1ns t0mat0es", true)],
                    [new ReadLine("Brown the mince.", false)],
                    null),
            },
        };
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/recipes/read-photo", Photo());
        res.EnsureSuccessStatusCode();
        var reading = (await res.Content.ReadFromJsonAsync<RecipeReadingDto>())!;

        Assert.True(reading.Available);
        Assert.Equal("Ragù", reading.Title);
        Assert.Equal(6, reading.Servings);
        Assert.Equal(2, reading.Ingredients.Count);
        // Kept verbatim, garbling and all — it is the only evidence of what the page said.
        Assert.Equal("2 t1ns t0mat0es", reading.Ingredients[1].RawText);
        Assert.True(reading.Ingredients[1].Unclear);
        Assert.Equal(1, reading.UnclearCount);
    }

    [Fact]
    public async Task Reading_a_recipe_saves_nothing()
    {
        using var app = new HubAppFactory
        {
            KitchenPhotoReader = new StubReader
            {
                Recipe = new RecipeReading(
                    true, "Ragù", 6, [new ReadLine("500 g beef mince", false)], [], null),
            },
        };
        var client = app.CreateSeededClient();

        var before = await client.GetFromJsonAsync<List<Dictionary<string, object>>>("/api/recipes");
        await client.PostAsJsonAsync("/api/recipes/read-photo", Photo());
        var after = await client.GetFromJsonAsync<List<Dictionary<string, object>>>("/api/recipes");

        // The folder is untouched. A recipe reaches it through a decision, never through a reading.
        Assert.Equal(before!.Count, after!.Count);
    }

    [Fact]
    public async Task No_reader_configured_is_reported_as_itself_and_never_blamed_on_the_picture()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/recipes/read-photo", Photo());
        res.EnsureSuccessStatusCode();
        var reading = (await res.Content.ReadFromJsonAsync<RecipeReadingDto>())!;

        Assert.False(reading.Available);
        Assert.NotNull(reading.Reason);
        // "This panel cannot read photographs" is a different fact from "there is no recipe on
        // that one", and only one of them is about the photograph.
        Assert.DoesNotContain("find a recipe", reading.Reason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task A_missing_photograph_is_refused()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync(
            "/api/recipes/read-photo", new { imageBase64 = "", mediaType = "image/png" });

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task An_order_reading_keeps_the_garbled_lines_rather_than_dropping_them()
    {
        using var app = new HubAppFactory
        {
            KitchenPhotoReader = new StubReader
            {
                Purchases = new PurchaseReading(
                    true,
                    "Walmart",
                    [
                        new ReadLine("2 × Passata 500g", false),
                        new ReadLine("1L 0AT DR1NK BAR1STA", true),
                    ],
                    null),
            },
        };
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/pantry/imports/read-photo", Photo());
        res.EnsureSuccessStatusCode();
        var reading = (await res.Content.ReadFromJsonAsync<PurchaseReadingDto>())!;

        Assert.Equal("Walmart", reading.VendorLabel);
        Assert.Equal(2, reading.Lines.Count);
        // A pantry that only knows about the lines a model found easy is wrong by however much
        // was left out — so the unreadable one is shown, verbatim, and flagged.
        Assert.Equal("1L 0AT DR1NK BAR1STA", reading.Lines[1].RawText);
        Assert.Equal(1, reading.UnclearCount);
    }

    [Fact]
    public async Task Reading_an_order_creates_no_import()
    {
        using var app = new HubAppFactory
        {
            KitchenPhotoReader = new StubReader
            {
                Purchases = new PurchaseReading(true, "Walmart", [new ReadLine("2 × Passata", false)], null),
            },
        };
        var client = app.CreateSeededClient();

        await client.PostAsJsonAsync("/api/pantry/imports/read-photo", Photo());
        var pending = await client.GetFromJsonAsync<List<Dictionary<string, object>>>(
            "/api/pantry/imports?status=Pending");

        // Nothing reaches the review screen until the panel posts the payload it collected.
        Assert.Empty(pending!);
    }

    [Fact]
    public async Task An_oversized_picture_is_refused_before_any_reading_is_attempted()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        // Just past the 10 MB decoded cap.
        var huge = new string('A', 14 * 1024 * 1024);
        var res = await client.PostAsJsonAsync(
            "/api/pantry/imports/read-photo", new { imageBase64 = huge, mediaType = "image/jpeg" });

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }
}
