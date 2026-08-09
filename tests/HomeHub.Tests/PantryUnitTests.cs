namespace HomeHub.Tests;

using HomeHub.Api.Pantry;

/// <summary>
/// The Pantry's pure logic: the normaliser that makes the stock check possible, the conversion
/// table that decides what may be claimed, the barcode forms, and the order parser.
/// </summary>
/// <remarks>
/// These are the pieces where a wrong answer is silent. A bad normalisation looks like an empty
/// pantry; a bad conversion looks like a shortfall; a bad expansion asks the household to name the
/// same tin twice. None of them throw, so none of them show up without a test.
/// </remarks>
public class PantryNormaliserTests
{
    /// <summary>The join the whole stock check rests on: the recipe's words and the shelf's words.</summary>
    [Theory]
    [InlineData("2 boneless, skinless chicken breasts, cut into cutlets", "chicken breast")]
    [InlineData("Chicken breasts", "chicken breast")]
    [InlineData("freshly grated parmesan", "parmesan")]
    [InlineData("Parmesan", "parmesan")]
    [InlineData("large eggs", "egg")]
    // "peeled" is a descriptor and goes — which is harmless, because it goes on both sides of the
    // join: the shelf's "Cento whole peeled tomatoes" and a recipe's reduce identically.
    [InlineData("Cento whole peeled tomatoes (28 oz)", "cento whole tomato")]
    [InlineData("jalapeño", "jalapeno")]
    [InlineData("Jalapenos", "jalapeno")]
    public void Normalises_to_a_shared_key(string input, string expected)
    {
        Assert.Equal(expected, IngredientNormaliser.Normalise(input));
    }

    /// <summary>
    /// Nothing recognisable must come back empty rather than as a key — an empty alias claimed by
    /// two unrelated items would join them, and the check would confidently answer about the wrong
    /// shelf.
    /// </summary>
    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("2")]
    [InlineData("(to taste)")]
    public void Nothing_recognisable_is_not_a_key(string input)
    {
        Assert.Equal(string.Empty, IngredientNormaliser.Normalise(input));
    }

    /// <summary>
    /// The `-ss` guard. Without it "cress", "glass" and "couscous" lose a letter and stop matching
    /// themselves — the failure is silent, because a normaliser that returns "cres" still returns
    /// *something*.
    /// </summary>
    [Theory]
    [InlineData("watercress", "watercress")]
    [InlineData("couscous", "couscous")]
    [InlineData("molasses", "molasses")]
    [InlineData("asparagus", "asparagus")]
    public void Words_ending_in_double_s_are_not_singularised(string input, string expected)
    {
        Assert.Equal(expected, IngredientNormaliser.Normalise(input));
    }

    /// <summary>
    /// "Smoked paprika" is not paprika. The descriptor list drops words that never change *which
    /// thing* is meant, and this is the boundary it must not cross.
    /// </summary>
    [Fact]
    public void Descriptors_that_change_the_thing_are_kept()
    {
        Assert.Equal("smoked paprika", IngredientNormaliser.Normalise("smoked paprika"));
        Assert.NotEqual(
            IngredientNormaliser.Normalise("smoked paprika"),
            IngredientNormaliser.Normalise("paprika"));
    }
}

public class UnitConversionTests
{
    /// <summary>Same dimension, fixed ratio — the only arithmetic the section claims.</summary>
    [Fact]
    public void Converts_within_a_dimension()
    {
        Assert.Equal(0.5m, UnitConversion.Convert(8, "tbsp", "cup")!.Value, 2);
        Assert.Equal(1m, UnitConversion.Convert(16, "oz", "lb")!.Value, 3);
        Assert.Equal(2m, UnitConversion.Convert(2000, "g", "kg")!.Value, 3);
    }

    /// <summary>A count is a count, whatever the two rows call their units.</summary>
    [Fact]
    public void Counts_compare_to_counts()
    {
        Assert.Equal(2m, UnitConversion.Convert(2, "ea", "")!.Value);
        Assert.Equal(3m, UnitConversion.Convert(3, "cloves", "ea")!.Value);
    }

    /// <summary>
    /// <b>Volume never converts to weight.</b> A cup of flour and a cup of honey differ by more than
    /// double, so a density table would be exactly the confident wrongness DECISIONS P9 forbids. The
    /// null is what makes the deduction degrade honestly instead of announcing that a pound of
    /// butter is gone.
    /// </summary>
    [Fact]
    public void Volume_does_not_convert_to_weight()
    {
        Assert.Null(UnitConversion.Convert(4, "tbsp", "lb"));
        Assert.Null(UnitConversion.Convert(1, "cup", "g"));
    }

    /// <summary>An unknown unit is unknown, not assumed to be 1:1.</summary>
    [Fact]
    public void Unknown_units_do_not_fall_back_to_one_to_one()
    {
        Assert.Null(UnitConversion.Convert(4, "tbsp", "jar"));
        Assert.Null(UnitConversion.Convert(2, "handfuls", "lb"));
    }
}

public class BarcodeTests
{
    /// <summary>Every form lands on the same 13 digits so one pack is one catalogue entry.</summary>
    [Fact]
    public void Pads_the_unambiguous_lengths()
    {
        Assert.Equal("0001234567890", Barcodes.Normalise("1234567890"[..0] + "001234567890"));
        Assert.Equal("0012345678905", Barcodes.Normalise("012345678905"));
        Assert.Equal("4006381333931", Barcodes.Normalise("4006381333931"));
    }

    /// <summary>Separators are noise; the digits are the code.</summary>
    [Fact]
    public void Ignores_separators()
    {
        Assert.Equal("0012345678905", Barcodes.Normalise("0-12345-67890-5"));
    }

    /// <summary>
    /// A UPC-E is <b>expanded</b>, not padded — its digits are rearranged, so padding would file the
    /// same tin under a second code and the household would be asked to name it twice.
    /// </summary>
    [Fact]
    public void Upc_e_expands_rather_than_padding()
    {
        var expanded = Barcodes.Normalise("01234565", Barcodes.UpcE);
        Assert.NotNull(expanded);
        Assert.Equal(13, expanded!.Length);
        // The published rearrangement for a trailing 5: 0 12345 00006 → padded to 13.
        Assert.Equal("0012345000065", expanded);
        // And it must differ from the naive padding, which is the bug this guards.
        Assert.NotEqual(Barcodes.Normalise("01234565"), expanded);
    }

    /// <summary>Eight digits with no symbology are read as EAN-8 — the commoner of the two.</summary>
    [Fact]
    public void Eight_digits_without_a_format_are_ean8()
    {
        Assert.Equal("0000040123455", Barcodes.Normalise("40123455"));
    }

    [Theory]
    [InlineData("")]
    [InlineData(null)]
    [InlineData("abc")]
    [InlineData("12345")]
    public void Rejects_what_is_not_a_grocery_barcode(string? raw)
    {
        Assert.Null(Barcodes.Normalise(raw));
    }
}

/// <summary>
/// Reading an Open Food Facts payload.
/// </summary>
/// <remarks>
/// Every failure in this class is silent by design — the provider swallows exceptions so a scan
/// degrades to the unmatched row rather than to an error. That is the right behaviour and it is also
/// exactly why these need tests: a binding that throws on a real-world record would show up as
/// "not in the catalogue" for a product the database knows perfectly well, with nothing in the UI
/// to suggest anything went wrong.
/// </remarks>
public class OpenFoodFactsTests
{
    private static OpenFoodFactsProductLookup.OffResponse Parse(string json) =>
        System.Text.Json.JsonSerializer.Deserialize<OpenFoodFactsProductLookup.OffResponse>(json)!;

    /// <summary>The shape the live API actually returns, taken from a real response.</summary>
    [Fact]
    public void Reads_a_real_product()
    {
        var info = OpenFoodFactsProductLookup.ToProductInfo(Parse("""
            {"status":1,"product":{"product_name":"Coca-Cola Zero Sugar","brands":"Coca-Cola",
             "quantity":"355 ml","product_quantity":355,"product_quantity_unit":"ml"}}
            """));

        Assert.NotNull(info);
        Assert.Equal("Coca-Cola Zero Sugar", info!.Value.Name);
        Assert.Equal("Coca-Cola", info.Value.Brand);
        Assert.Equal("ml", info.Value.Unit);
        Assert.Equal(355m, info.Value.PackSize);
        Assert.Equal("Open Food Facts", info.Value.Source);
    }

    /// <summary>
    /// <c>product_quantity</c> arrives as a number, a quoted number, or an empty string depending on
    /// who entered the record. All three have to survive — a strict decimal binding would throw on
    /// two of them and lose the entire lookup, silently.
    /// </summary>
    [Theory]
    [InlineData("355", 355)]
    [InlineData("\"355\"", 355)]
    // Below the rounding hinge, so this still proves a decimal *parses* rather than colliding with
    // `Tidy` — which is a separate rule with its own test.
    [InlineData("1.5", 1.5)]
    [InlineData("\"1.5\"", 1.5)]
    public void Reads_pack_size_whether_it_is_a_number_or_a_string(string raw, double expected)
    {
        var info = OpenFoodFactsProductLookup.ToProductInfo(Parse(
            "{\"status\":1,\"product\":{\"product_name\":\"Thing\",\"product_quantity\":"
            + raw + ",\"product_quantity_unit\":\"g\"}}"));

        Assert.Equal((decimal)expected, info!.Value.PackSize);
    }

    [Theory]
    [InlineData("\"\"")]
    [InlineData("null")]
    [InlineData("\"about a cup\"")]
    [InlineData("0")]
    public void An_unusable_pack_size_is_null_rather_than_a_guess(string raw)
    {
        var info = OpenFoodFactsProductLookup.ToProductInfo(Parse(
            "{\"status\":1,\"product\":{\"product_name\":\"Thing\",\"product_quantity\":" + raw + "}}"));

        Assert.NotNull(info);
        Assert.Null(info!.Value.PackSize);
    }

    /// <summary>
    /// Real-world precision. An 8 oz bag of walnuts comes back as 226.796185 g — a converted
    /// imperial figure at full float precision — and that number is shown to the household for
    /// confirmation and then applied to every future scan of the pack.
    /// </summary>
    [Theory]
    [InlineData(226.796185, 227)]   // Fisher Chopped Walnuts, 8 oz
    [InlineData(453.59237, 454)]    // 1 lb
    [InlineData(355, 355)]          // already whole, untouched
    [InlineData(1.5, 1.5)]          // below the hinge: the decimals are the value
    [InlineData(0.333333, 0.33)]
    public void Pack_sizes_are_rounded_to_something_a_person_would_write(double raw, double expected)
    {
        Assert.Equal((decimal)expected, OpenFoodFactsProductLookup.Tidy((decimal)raw));
    }

    /// <summary>A 200 with <c>status: 0</c> is the normal "unknown barcode" answer, not a fault.</summary>
    [Fact]
    public void An_unknown_barcode_yields_no_suggestion()
    {
        Assert.Null(OpenFoodFactsProductLookup.ToProductInfo(Parse("""{"status":0,"product":null}""")));
    }

    /// <summary>
    /// A record with no name at all is worse than nothing: it would pre-fill the field with a blank
    /// and make the household think the lookup worked.
    /// </summary>
    [Fact]
    public void A_nameless_record_yields_no_suggestion()
    {
        Assert.Null(OpenFoodFactsProductLookup.ToProductInfo(Parse("""
            {"status":1,"product":{"product_name":"","generic_name":"  ","brands":null}}
            """)));
    }

    /// <summary>Falls back through the name fields rather than giving up on the first blank.</summary>
    [Fact]
    public void Falls_back_to_generic_name_then_brand()
    {
        var generic = OpenFoodFactsProductLookup.ToProductInfo(Parse("""
            {"status":1,"product":{"product_name":"","generic_name":"Cola","brands":"Store"}}
            """));
        Assert.Equal("Cola", generic!.Value.Name);

        var brand = OpenFoodFactsProductLookup.ToProductInfo(Parse("""
            {"status":1,"product":{"product_name":null,"generic_name":null,"brands":"Great Value"}}
            """));
        Assert.Equal("Great Value", brand!.Value.Name);
    }

    /// <summary>`brands` is a comma-separated list; only the first is a thing anyone says out loud.</summary>
    [Fact]
    public void Takes_the_first_brand_only()
    {
        var info = OpenFoodFactsProductLookup.ToProductInfo(Parse("""
            {"status":1,"product":{"product_name":"Beans","brands":"Heinz, H. J. Heinz Company, Kraft Heinz"}}
            """));
        Assert.Equal("Heinz", info!.Value.Brand);
    }

    /// <summary>
    /// Free-text `quantity` is used only as a unit label when the structured pair is missing, and
    /// never parsed into a number — "6 x 33 cl" is not something to do arithmetic on.
    /// </summary>
    [Fact]
    public void Free_text_quantity_never_becomes_a_number()
    {
        var info = OpenFoodFactsProductLookup.ToProductInfo(Parse("""
            {"status":1,"product":{"product_name":"Lager","quantity":"6 x 33 cl"}}
            """));

        Assert.Null(info!.Value.PackSize);
        Assert.Equal("6 x 33 cl", info.Value.Unit);
    }

    /// <summary>Names are clamped to the column, since the source has no length contract with us.</summary>
    [Fact]
    public void Overlong_values_are_truncated_to_the_column()
    {
        var overlong = new string('x', PantryFieldLimits.ItemName + 50);
        var info = OpenFoodFactsProductLookup.ToProductInfo(Parse(
            "{\"status\":1,\"product\":{\"product_name\":\"" + overlong + "\"}}"));

        Assert.Equal(PantryFieldLimits.ItemName, info!.Value.Name.Length);
    }
}

public class OrderImportParserTests
{
    /// <summary>The abbreviations grocers actually print, expanded into words a household reads.</summary>
    [Fact]
    public void Expands_a_store_line()
    {
        var lines = OrderImportParser.Parse("GV HVY WHP CRM 32Z");
        var line = Assert.Single(lines);

        Assert.False(line.Unreadable);
        // The store brand goes; the product does not.
        Assert.Equal("Heavy whipping cream", line.Name);
        Assert.Equal(32m, line.Quantity);
        Assert.Equal("oz", line.Unit);
        // Not a weight guess: an ounce of cream is an amount, not a count of creams.
        Assert.Null(line.PoundsPerPack);
    }

    /// <summary>
    /// The weight guess, and the reason it is flagged: `2.5 LB` of chicken breasts becomes "about
    /// 6", which is the single most likely wrong number in the section (DECISIONS PG5). The parser's
    /// job is to hand the pounds back so the row can say where the six came from.
    /// </summary>
    [Fact]
    public void A_weight_pack_of_countable_things_is_a_guess_that_says_so()
    {
        var line = Assert.Single(OrderImportParser.Parse("MM CHKN BRST 2.5LB PK"));

        Assert.Equal(6m, line.Quantity);
        Assert.Equal("ea", line.Unit);
        Assert.Equal(2.5m, line.PoundsPerPack);
    }

    /// <summary>
    /// A line nothing could be made of is <b>unreadable</b>, not a pantry item called "hvy whp".
    /// Failure is a `NAME IT` row, never a wrong row.
    /// </summary>
    [Theory]
    [InlineData("XQ ZZT 4K")]
    // A store brand with nothing after it. `GV` on its own is under the length floor and never
    // reaches the parser at all — this is the shortest line that does.
    [InlineData("GVX")]
    public void Cryptic_lines_come_back_unreadable(string raw)
    {
        var line = Assert.Single(OrderImportParser.Parse(raw));
        Assert.True(line.Unreadable);
        Assert.Null(line.Name);
        // The raw string survives regardless — it is how a wrong interpretation gets caught.
        Assert.Equal(raw, line.RawText);
    }

    /// <summary>
    /// Order emails are mostly not the order. Filtering the furniture is what keeps 9d a review
    /// rather than a haystack — and a kept footer would become a pantry item called "Unsubscribe".
    /// </summary>
    [Fact]
    public void Drops_email_furniture()
    {
        var payload = string.Join('\n', [
            "Thank you for your order!",
            "Your order #114-2938",
            "GV HVY WHP CRM 32Z",
            "SPGHT 1LB",
            "Subtotal $42.18",
            "Delivery window 2:00 PM",
            "questions@example.com",
            "Unsubscribe",
        ]);

        var names = OrderImportParser.Parse(payload).Select(l => l.Name).ToList();

        Assert.Equal(2, names.Count);
        Assert.Contains("Heavy whipping cream", names);
        Assert.Contains("Spaghetti", names);
    }

    /// <summary>A leading `2x` is a count of packs, not part of the name.</summary>
    [Fact]
    public void Reads_a_leading_pack_count()
    {
        var line = Assert.Single(OrderImportParser.Parse("2x SPGHT 1LB"));
        Assert.Equal("Spaghetti", line.Name);
        Assert.Equal(2m, line.Quantity);
        Assert.Equal("lb", line.Unit);
    }

    /// <summary>
    /// An unparseable payload yields no lines rather than throwing — 9d then shows its documented
    /// `0 / 0 / n` state with one action, never a stack trace (PANTRY_BEHAVIOURS §6).
    /// </summary>
    [Theory]
    [InlineData("")]
    [InlineData(null)]
    [InlineData("Subtotal $0.00")]
    public void An_unreadable_payload_is_empty_not_an_error(string? payload)
    {
        Assert.Empty(OrderImportParser.Parse(payload));
    }
}
