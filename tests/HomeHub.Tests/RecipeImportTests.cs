namespace HomeHub.Tests;

using System.Globalization;
using System.Net;
using HomeHub.Api.Meals;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

/// <summary>
/// Stage M2: the SSRF guard (D4), the ingredient parser (D3), the JSON-LD importer (D2) and the
/// completeness scoring (D10).
/// </summary>
public class RecipeImportTests
{
    // ---- D4: the security boundary ----

    /// <summary>
    /// Every range D4 lists must be refused. This is the test that matters most in the file: the API
    /// has no authentication, so an unguarded fetcher is an SSRF primitive aimed at Home Assistant's
    /// long-lived token, SQL Server, and the router — all of which live on the same LAN.
    /// </summary>
    [Theory]
    [InlineData("127.0.0.1")]          // loopback
    [InlineData("10.0.0.5")]           // RFC1918
    [InlineData("172.16.4.1")]         // RFC1918
    [InlineData("172.31.255.254")]     // RFC1918 upper bound
    [InlineData("192.168.1.10")]       // RFC1918 — the Home Assistant box
    [InlineData("169.254.169.254")]    // link-local, the cloud metadata endpoint
    [InlineData("100.64.0.1")]         // CGNAT
    [InlineData("0.0.0.0")]            // "this network"
    [InlineData("224.0.0.1")]          // multicast
    [InlineData("::1")]                // IPv6 loopback
    [InlineData("fe80::1")]            // IPv6 link-local
    [InlineData("fc00::1")]            // IPv6 unique-local
    [InlineData("fd12:3456::1")]       // IPv6 ULA, the commonly-used half of fc00::/7
    public void Private_addresses_are_refused(string address)
    {
        Assert.True(RecipeFetcher.IsPrivate(System.Net.IPAddress.Parse(address)));
    }

    [Theory]
    [InlineData("1.1.1.1")]
    [InlineData("93.184.216.34")]
    [InlineData("172.32.0.1")]   // just outside RFC1918 — must NOT be caught
    [InlineData("172.15.255.1")] // just below RFC1918 — must NOT be caught
    [InlineData("100.63.255.1")] // just below CGNAT
    [InlineData("100.128.0.1")]  // just above CGNAT
    [InlineData("2606:4700::1")] // public IPv6
    public void Public_addresses_are_allowed(string address)
    {
        Assert.False(RecipeFetcher.IsPrivate(System.Net.IPAddress.Parse(address)));
    }

    /// <summary>An IPv4-mapped IPv6 literal must not smuggle a private address past the check.</summary>
    [Fact]
    public void Ipv4_mapped_ipv6_does_not_bypass_the_guard()
    {
        Assert.True(RecipeFetcher.IsPrivate(IPAddress.Parse("::ffff:192.168.1.10")));
        Assert.True(RecipeFetcher.IsPrivate(IPAddress.Parse("::ffff:127.0.0.1")));
    }

    private static RecipeFetcher GuardedFetcher(MealsOptions options) =>
        new(new HttpClient(RecipeFetcher.CreateGuardedHandler(options)),
            Microsoft.Extensions.Options.Options.Create(options),
            NullLogger<RecipeFetcher>.Instance);

    /// <summary>
    /// A <b>name</b> resolving to a private address is refused, and refused at connect time.
    /// </summary>
    /// <remarks>
    /// The other tests in this section check <see cref="RecipeFetcher.IsPrivate"/>, which is a pure
    /// predicate over an address someone already has. This one checks the part that decides *which*
    /// address gets screened, which is where the TOCTOU gap was: `localhost` is a name, so the
    /// cheap pre-flight in `Validate` cannot reject it on sight, and the only thing standing between
    /// this call and a socket on 127.0.0.1 is the connect callback. If the guard is ever moved back
    /// in front of the send, this test still passes — but it is the test that would have to be
    /// deleted to remove the callback, which is the point of it.
    /// </remarks>
    [Fact]
    public async Task A_name_resolving_to_a_private_address_is_refused_at_connect_time()
    {
        var result = await GuardedFetcher(new MealsOptions { AllowPrivateAddresses = false })
            .GetPageAsync("http://localhost:9/recipe", CancellationToken.None);

        Assert.False(result.Ok);
        Assert.Equal("That address is on the local network.", result.Error);
    }

    /// <summary>
    /// With the escape hatch open the same address is dialled rather than refused.
    /// </summary>
    /// <remarks>
    /// Port 9 is discard and nothing is listening, so the connection fails — and that is the
    /// assertion. "Could not reach that site" means the guard let it through to a socket;
    /// "on the local network" would mean the flag does nothing. Without this, a guard that refused
    /// everything unconditionally would pass the test above.
    /// </remarks>
    [Fact]
    public async Task The_private_address_escape_hatch_actually_opens_it()
    {
        var result = await GuardedFetcher(new MealsOptions { AllowPrivateAddresses = true })
            .GetPageAsync("http://localhost:9/recipe", CancellationToken.None);

        Assert.False(result.Ok);
        Assert.NotEqual("That address is on the local network.", result.Error);
    }

    /// <summary>A name that does not resolve is a lookup failure, not a network-range refusal.</summary>
    [Fact]
    public async Task An_unresolvable_name_says_so()
    {
        // `.invalid` is reserved by RFC 2606 precisely so it can never resolve, anywhere.
        var result = await GuardedFetcher(new MealsOptions { AllowPrivateAddresses = false })
            .GetPageAsync("http://nothing-here.invalid/recipe", CancellationToken.None);

        Assert.False(result.Ok);
        Assert.Equal("Could not find that site.", result.Error);
    }

    // ---- What a refused fetch tells the household ----

    /// <summary>
    /// A publisher refusing automated reads must not read as a fault in the panel.
    /// </summary>
    /// <remarks>
    /// allrecipes.com answers <c>402</c> from Cloudflare to every client — browser user-agent
    /// included — with a body pointing at their content-licensing address. `The site answered 402`
    /// sent the household back to retry the same link forever; the message has to say the site will
    /// not allow it, and name the path that still works — copying the page and pasting it, which the
    /// screen then offers in one tap.
    /// </remarks>
    [Theory]
    [InlineData(401)]
    [InlineData(402)] // allrecipes.com — licensed content
    [InlineData(403)]
    [InlineData(451)]
    public void A_publisher_refusing_the_panel_says_so_and_points_at_pasting(int status)
    {
        var message = RecipeFetcher.RefusalFor((HttpStatusCode)status);

        Assert.Contains("does not allow", message);
        Assert.Contains("paste", message, StringComparison.OrdinalIgnoreCase);
        // The bare status number is what made it read as a panel fault.
        Assert.DoesNotContain(status.ToString(CultureInfo.InvariantCulture), message);
    }

    [Theory]
    [InlineData(404)]
    [InlineData(410)]
    public void A_missing_page_says_it_is_missing(int status)
    {
        Assert.Equal("That page does not exist.", RecipeFetcher.RefusalFor((HttpStatusCode)status));
    }

    /// <summary>Retryable states say so; a dead end must not invite a retry and vice versa.</summary>
    [Fact]
    public void Retryable_states_invite_a_retry()
    {
        Assert.Contains("Try again", RecipeFetcher.RefusalFor((HttpStatusCode)429));
        Assert.Contains("Try again", RecipeFetcher.RefusalFor(HttpStatusCode.BadGateway));
        Assert.DoesNotContain("Try again", RecipeFetcher.RefusalFor(HttpStatusCode.NotFound));
    }

    /// <summary>Anything unrecognised still reports the number rather than inventing an explanation.</summary>
    [Fact]
    public void An_unrecognised_status_is_reported_verbatim()
    {
        Assert.Equal("The site answered 418.", RecipeFetcher.RefusalFor((HttpStatusCode)418));
    }

    // ---- D3: the ingredient parser ----

    [Theory]
    // quantity, unit, name, note
    [InlineData("2 tbsp olive oil, divided", 2, "tbsp", "olive oil", "divided")]
    [InlineData("1/2 cup coconut milk", 0.5, "cup", "coconut milk", null)]
    [InlineData("1 1/2 cups flour", 1.5, "cup", "flour", null)]
    [InlineData("½ tsp salt", 0.5, "tsp", "salt", null)]
    [InlineData("0.5 kg beef mince", 0.5, "kg", "beef mince", null)]
    [InlineData("3 cloves garlic, finely sliced", 3, "clove", "garlic", "finely sliced")]
    [InlineData("500 g tomatoes", 500, "g", "tomatoes", null)]
    [InlineData("2 large eggs", 2, null, "large eggs", null)]
    [InlineData("4 chicken thighs", 4, null, "chicken thighs", null)]
    public void Common_ingredient_shapes_parse(string line, double quantity, string? unit, string name, string? note)
    {
        var parsed = IngredientParser.Parse(line);

        Assert.Equal((decimal)quantity, parsed.Quantity);
        Assert.Equal(unit, parsed.Unit);
        Assert.Equal(name, parsed.Name);
        Assert.Equal(note, parsed.Note);
    }

    /// <summary>A range takes the low value; `RawText` still shows the range to the cook.</summary>
    [Fact]
    public void A_range_takes_the_low_value()
    {
        Assert.Equal(2m, IngredientParser.Parse("2-3 cloves garlic").Quantity);
        Assert.Equal(2m, IngredientParser.Parse("2–3 cloves garlic").Quantity); // en dash
    }

    /// <summary>
    /// D3's governing rule: failure is null fields, never wrong fields. A wrong quantity in a scaled
    /// recipe is worse than an unscaled line, and the UI already renders these honestly as
    /// AS WRITTEN.
    /// </summary>
    [Theory]
    [InlineData("Salt and pepper to taste")]
    [InlineData("A handful of parsley")]
    [InlineData("Olive oil")]
    [InlineData("")]
    [InlineData("   ")]
    public void Unreadable_lines_come_back_entirely_null(string line)
    {
        var parsed = IngredientParser.Parse(line);

        Assert.Null(parsed.Quantity);
        Assert.Null(parsed.Unit);
        Assert.Null(parsed.Name);
        Assert.Null(parsed.Note);
    }

    /// <summary>A parenthetical container size is dropped from the name rather than mis-read.</summary>
    [Fact]
    public void Parenthetical_container_sizes_do_not_corrupt_the_name()
    {
        var parsed = IngredientParser.Parse("1 (14 oz) can diced tomatoes");

        Assert.Equal(1m, parsed.Quantity);
        Assert.Equal("can", parsed.Unit);
        Assert.DoesNotContain("14", parsed.Name);
    }

    // ---- D2 / D10: the importer ----

    private static string Page(string json) =>
        $"<html><head><script type=\"application/ld+json\">{json}</script></head><body></body></html>";

    private const string FullRecipe = """
    {
      "@context": "https://schema.org",
      "@type": "Recipe",
      "name": "Green Curry",
      "recipeCuisine": "Thai",
      "recipeYield": "4 servings",
      "totalTime": "PT35M",
      "prepTime": "PT15M",
      "publisher": { "@type": "Organization", "name": "Serious Eats" },
      "image": { "@type": "ImageObject", "url": "https://example.com/curry.jpg" },
      "recipeIngredient": ["2 tbsp green curry paste", "1/2 cup coconut milk"],
      "recipeInstructions": [
        { "@type": "HowToStep", "text": "Fry the paste." },
        { "@type": "HowToStep", "text": "Add the milk." }
      ]
    }
    """;

    [Fact]
    public void A_complete_recipe_parses_every_field()
    {
        var result = JsonLdRecipeImporter.Parse(Page(FullRecipe), "https://example.com/curry");

        Assert.Equal(ImportConfidence.Complete, result.Confidence);
        Assert.Null(result.Reason);
        var r = result.Recipe!;
        Assert.Equal("Green Curry", r.Title);
        Assert.Equal("Serious Eats", r.SourceName);
        Assert.Equal(4, r.Servings);
        Assert.Equal(35, r.TotalMinutes);
        Assert.Equal(15, r.PrepMinutes);
        Assert.Equal(2, r.Ingredients!.Count);
        Assert.Equal(2, r.Steps!.Count);
        Assert.Equal("https://example.com/curry.jpg", result.ImageUrl);
        // Cuisine is normalised into the reserved namespace so the folder cannot end up with both
        // "Thai" and "thai" as separate groups.
        Assert.Contains("cuisine:thai", r.Tags!);
        // Parsed at import time, and the raw line is still what will be displayed.
        Assert.Equal(2m, r.Ingredients[0].Quantity);
        Assert.Equal("tbsp", r.Ingredients[0].Unit);
        Assert.Equal("2 tbsp green curry paste", r.Ingredients[0].RawText);
    }

    /// <summary>The node may be top-level, inside `@graph`, or an element of a top-level array.</summary>
    [Fact]
    public void The_recipe_node_is_found_in_every_documented_position()
    {
        var graph = Page($$"""{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{{FullRecipe}}]}""");
        var array = Page($"[{{\"@type\":\"WebSite\"}},{FullRecipe}]");

        Assert.Equal(ImportConfidence.Complete, JsonLdRecipeImporter.Parse(graph, "https://e.com").Confidence);
        Assert.Equal(ImportConfidence.Complete, JsonLdRecipeImporter.Parse(array, "https://e.com").Confidence);
    }

    /// <summary>`@type` is legitimately allowed to be an array.</summary>
    [Fact]
    public void An_array_valued_type_still_matches()
    {
        var json = FullRecipe.Replace("\"@type\": \"Recipe\"", "\"@type\": [\"Recipe\",\"NewsArticle\"]");

        Assert.Equal(ImportConfidence.Complete, JsonLdRecipeImporter.Parse(Page(json), "https://e.com").Confidence);
    }

    /// <summary>`recipeInstructions` arrives in four different shapes in the wild.</summary>
    [Fact]
    public void Instructions_parse_from_every_documented_shape()
    {
        static string With(string instructions) => $$"""
        {"@type":"Recipe","name":"X","recipeIngredient":["1 cup a","2 cups b"],"recipeInstructions":{{instructions}}}
        """;

        var plain = JsonLdRecipeImporter.Parse(Page(With("\"Do the thing.\"")), "https://e.com");
        var strings = JsonLdRecipeImporter.Parse(Page(With("[\"One.\",\"Two.\"]")), "https://e.com");
        var sections = JsonLdRecipeImporter.Parse(Page(With("""
        [{"@type":"HowToSection","name":"For the sauce","itemListElement":[{"@type":"HowToStep","text":"Simmer."}]}]
        """)), "https://e.com");

        Assert.Single(plain.Recipe!.Steps!);
        Assert.Equal(2, strings.Recipe!.Steps!.Count);
        var step = Assert.Single(sections.Recipe!.Steps!);
        Assert.Equal("Simmer.", step.Text);
        // HowToSection is where section headings come from — the detail screen renders them.
        Assert.Equal("For the sauce", step.SectionHeading);
    }

    /// <summary>
    /// D10's whole point: a valid `Recipe` node is not a usable recipe. NYT Cooking emits exactly
    /// this shape — well-formed, and truncated — for unauthenticated fetches.
    /// </summary>
    [Fact]
    public void A_valid_node_with_a_stripped_body_is_Partial_and_says_what_is_missing()
    {
        var paywalled = Page("""
        {"@type":"Recipe","name":"Behind A Paywall","recipeIngredient":[],"recipeInstructions":[]}
        """);

        var result = JsonLdRecipeImporter.Parse(paywalled, "https://example.com/x");

        Assert.Equal(ImportConfidence.Partial, result.Confidence);
        Assert.NotNull(result.Recipe);
        Assert.Contains("ingredients", result.Reason!, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("steps", result.Reason!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void A_page_with_no_recipe_node_is_Empty_and_writes_nothing()
    {
        var result = JsonLdRecipeImporter.Parse(
            Page("""{"@type":"NewsArticle","headline":"Not a recipe"}"""), "https://example.com/x");

        Assert.Equal(ImportConfidence.Empty, result.Confidence);
        Assert.Null(result.Recipe);
        Assert.NotNull(result.Reason);
    }

    /// <summary>One malformed block must not cost us the recipe in the next one.</summary>
    [Fact]
    public void A_broken_json_block_does_not_hide_a_later_valid_one()
    {
        var html = "<html><head>"
            + "<script type=\"application/ld+json\">{ this is not json </script>"
            + $"<script type=\"application/ld+json\">{FullRecipe}</script>"
            + "</head></html>";

        Assert.Equal(ImportConfidence.Complete, JsonLdRecipeImporter.Parse(html, "https://e.com").Confidence);
    }

    /// <summary>Markup and entities inside JSON-LD strings would otherwise render literally.</summary>
    [Fact]
    public void Embedded_markup_is_stripped_from_values()
    {
        var json = """
        {"@type":"Recipe","name":"Salt &amp; Pepper Squid",
         "recipeIngredient":["1 lb squid","<p>2 tsp salt</p>"],
         "recipeInstructions":["<p>Fry <b>hot</b>.</p>"]}
        """;

        var r = JsonLdRecipeImporter.Parse(Page(json), "https://e.com").Recipe!;

        Assert.Equal("Salt & Pepper Squid", r.Title);
        Assert.Equal("2 tsp salt", r.Ingredients![1].RawText);
        Assert.Equal("Fry hot.", r.Steps![0].Text);
    }

    /// <summary>A day-long "total time" is a cure, not a cook time, and would wreck the start-by maths.</summary>
    [Fact]
    public void An_absurd_duration_is_dropped_rather_than_stored()
    {
        var json = FullRecipe.Replace("\"PT35M\"", "\"P2D\"");

        Assert.Null(JsonLdRecipeImporter.Parse(Page(json), "https://e.com").Recipe!.TotalMinutes);
    }

    // ---- D5: the cached-image lifecycle ----

    /// <summary>
    /// A path from the database is still untrusted input by the time it is combined into a filename
    /// to read or delete. Anything with a separator or a parent segment is refused outright.
    /// </summary>
    [Theory]
    [InlineData("../../appsettings.json")]
    [InlineData("..\\..\\appsettings.json")]
    [InlineData("sub/dir.jpg")]
    [InlineData("sub\\dir.jpg")]
    [InlineData("")]
    [InlineData("   ")]
    public void Image_names_that_could_escape_the_cache_directory_are_refused(string fileName)
    {
        var service = new RecipeImportService(
            fetcher: null!,
            options: Microsoft.Extensions.Options.Options.Create(new MealsOptions()),
            environment: new StubEnvironment(Path.GetTempPath()),
            logger: Microsoft.Extensions.Logging.Abstractions.NullLogger<RecipeImportService>.Instance);

        Assert.Null(service.ResolveImagePath(fileName));
    }

    [Theory]
    [InlineData("a1b2.jpg", "image/jpeg")]
    [InlineData("a1b2.png", "image/png")]
    [InlineData("a1b2.webp", "image/webp")]
    [InlineData("a1b2.exe", null)]
    [InlineData("a1b2", null)]
    public void Only_real_image_extensions_are_served(string fileName, string? expected)
    {
        Assert.Equal(expected, RecipeImportService.ContentTypeFor(fileName));
    }

    private sealed class StubEnvironment(string root) : IHostEnvironment
    {
        public string ApplicationName { get; set; } = "Tests";
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
        public string ContentRootPath { get; set; } = root;
        public string EnvironmentName { get; set; } = "Test";
    }

    /// <summary>A yield with no number keeps its wording rather than inventing a serving count.</summary>
    [Fact]
    public void A_wordy_yield_leaves_servings_null_and_keeps_the_text()
    {
        var json = FullRecipe.Replace("\"4 servings\"", "\"A dozen cookies\"");

        var r = JsonLdRecipeImporter.Parse(Page(json), "https://e.com").Recipe!;
        Assert.Null(r.Servings);
        Assert.Equal("A dozen cookies", r.YieldText);
    }
}
