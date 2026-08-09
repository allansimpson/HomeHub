using HomeHub.Api.Pantry;

namespace HomeHub.Tests;

/// <summary>
/// How a scanned name is cased before it lands on a shelf.
/// </summary>
/// <remarks>
/// Outside catalogues are inconsistent about case because the field is whatever a contributor typed
/// — the same source answers `TRADITIONAL ITALIAN POLENTA` for one product and
/// `Traditional italian polenta` for the next. On a shelf list read from across a room that is the
/// loudest thing on the screen.
/// </remarks>
public class ProductNameTests
{
    [Theory]
    [InlineData("TRADITIONAL ITALIAN POLENTA", "Traditional Italian Polenta")]
    [InlineData("Traditional italian polenta", "Traditional Italian Polenta")]
    [InlineData("traditional italian polenta", "Traditional Italian Polenta")]
    [InlineData("TrAdItIoNaL iTaLiAn PoLeNtA", "Traditional Italian Polenta")]
    public void However_the_catalogue_cased_it_the_shelf_reads_the_same(string given, string expected)
    {
        Assert.Equal(expected, ProductNames.TitleCase(given));
    }

    /// <summary>
    /// The single most visible way a naive title-caser gives itself away.
    /// </summary>
    [Theory]
    [InlineData("hershey's kisses", "Hershey's Kisses")]
    [InlineData("REESE'S PIECES", "Reese's Pieces")]
    [InlineData("m&m's", "M&M's")]
    public void An_apostrophe_does_not_start_a_new_word(string given, string expected)
    {
        Assert.Equal(expected, ProductNames.TitleCase(given));
    }

    /// <summary>Hyphens, slashes and brackets do start one, because they read as word breaks.</summary>
    [Theory]
    [InlineData("coca-cola zero", "Coca-Cola Zero")]
    [InlineData("half-and-half", "Half-And-Half")]
    [InlineData("salt/pepper grinder", "Salt/Pepper Grinder")]
    [InlineData("olive oil (extra virgin)", "Olive Oil (Extra Virgin)")]
    public void Hyphens_slashes_and_brackets_do(string given, string expected)
    {
        Assert.Equal(expected, ProductNames.TitleCase(given));
    }

    /// <summary>
    /// A word that opens with a digit is a size or a code — raising a letter inside it reads as a
    /// typo rather than a style.
    /// </summary>
    [Theory]
    [InlineData("MILK 500ML", "Milk 500ml")]
    [InlineData("cheese 200G", "Cheese 200g")]
    [InlineData("cola 2L bottle", "Cola 2l Bottle")]
    public void A_word_starting_with_a_digit_is_lowercased_whole(string given, string expected)
    {
        Assert.Equal(expected, ProductNames.TitleCase(given));
    }

    [Theory]
    [InlineData(null, null)]
    [InlineData("", "")]
    [InlineData("   ", "   ")]
    public void Nothing_in_nothing_out(string? given, string? expected)
    {
        Assert.Equal(expected, ProductNames.TitleCase(given));
    }

    [Fact]
    public void Surrounding_whitespace_is_trimmed()
    {
        Assert.Equal("Butter", ProductNames.TitleCase("   butter  "));
    }

    /// <summary>
    /// Acronyms flatten, and that is the accepted cost.
    /// </summary>
    /// <remarks>
    /// Pinned as a test so the behaviour is a decision rather than a surprise. The obvious fix — leave
    /// short all-caps words alone — is worse than the problem: it would render `SOUP OF THE DAY` as
    /// `Soup OF THE Day`. The name is editable on the row sheet, which is where a case nobody can
    /// infer should be settled.
    /// </remarks>
    [Theory]
    [InlineData("UHT MILK", "Uht Milk")]
    [InlineData("BBQ SAUCE", "Bbq Sauce")]
    public void Acronyms_flatten_which_is_the_known_trade(string given, string expected)
    {
        Assert.Equal(expected, ProductNames.TitleCase(given));
    }

    /// <summary>…but the alternative would have been worse, which is why it was not taken.</summary>
    [Fact]
    public void Small_words_are_still_capitalised_rather_than_left_shouting()
    {
        Assert.Equal("Soup Of The Day", ProductNames.TitleCase("SOUP OF THE DAY"));
    }

    // ---- brand + product ----

    /// <summary>
    /// The case this exists for: the catalogue knows the brand and offers a product name generic
    /// enough to be useless on a shelf. "Pickle Spears" cannot be told from the other jar of pickles.
    /// </summary>
    [Fact]
    public void The_brand_leads_a_generic_product_name()
    {
        Assert.Equal("Grillo's Pickle Spears", ProductNames.Specific("Grillo's", "Pickle Spears"));
    }

    /// <summary>
    /// Only when it adds something. Half of these records already lead with the brand, and the
    /// punctuation fold is what stops <c>Grillos</c> and <c>Grillo's</c> reading as different words.
    /// </summary>
    [Theory]
    [InlineData("Coca-Cola", "Coca-Cola Zero Sugar", "Coca-Cola Zero Sugar")]
    [InlineData("Grillo's", "Grillos Dill Pickles", "Grillos Dill Pickles")]
    [InlineData("Grillos", "Grillo's Dill Pickles", "Grillo's Dill Pickles")]
    [InlineData("Cento", "CENTO whole peeled tomatoes", "CENTO whole peeled tomatoes")]
    public void The_brand_is_not_repeated_when_the_name_already_carries_it(
        string brand, string name, string expected)
    {
        Assert.Equal(expected, ProductNames.Specific(brand, name));
    }

    /// <summary>Either half missing is the other half, not a blank or a crash.</summary>
    [Theory]
    [InlineData(null, "Pickle Spears", "Pickle Spears")]
    [InlineData("Grillo's", null, "Grillo's")]
    [InlineData("   ", "Pickle Spears", "Pickle Spears")]
    public void A_missing_half_falls_back_to_the_other(string? brand, string? name, string expected)
    {
        Assert.Equal(expected, ProductNames.Specific(brand, name));
    }

    /// <summary>
    /// A combination that would not fit the column keeps the product alone. A truncated brand+product
    /// is worse than either — "Grillo's Italian Dill Pickle Spears In Br" is a name nobody chose.
    /// </summary>
    [Fact]
    public void An_overlong_combination_keeps_the_product_rather_than_truncating()
    {
        var name = new string('x', PantryFieldLimits.ItemName - 2);

        Assert.Equal(name, ProductNames.Specific("Grillo's", name));
    }
}
