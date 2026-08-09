namespace HomeHub.Api.Pantry;

using System.Text;

/// <summary>
/// How a scanned product's name is cased before it reaches a shelf.
/// </summary>
/// <remarks>
/// Outside catalogues are wildly inconsistent about case — Open Food Facts alone returns
/// <c>TRADITIONAL ITALIAN POLENTA</c>, <c>Traditional italian polenta</c> and
/// <c>traditional italian polenta</c> for neighbouring products, because the field is whatever a
/// contributor typed. On a shelf list read from across a room that inconsistency is the loudest
/// thing on the screen.
/// <para>
/// <b>Only on the scan path.</b> A name typed by hand into the item sheet is left exactly as typed:
/// the pantry stores the household's own words, and re-casing what somebody deliberately wrote would
/// be the section overruling them. A scanned name is not the household's words yet — it is a
/// stranger's database, or a pack being named for the first time — which is where a house style
/// belongs.
/// </para>
/// </remarks>
public static class ProductNames
{
    /// <summary>
    /// Title-case a product name: first letter of each word up, everything else down.
    /// </summary>
    /// <remarks>
    /// Word boundaries are whitespace, hyphens, slashes and opening brackets, so
    /// <c>coca-cola (500ml)</c> becomes <c>Coca-Cola (500ml)</c>.
    /// <para>
    /// <b>Apostrophes are deliberately not boundaries.</b> <c>hershey's</c> must become
    /// <c>Hershey's</c> and not <c>Hershey'S</c>, which is the single most visible way a naive
    /// title-caser gives itself away.
    /// </para>
    /// <para>
    /// A word whose first character is not a letter is lowercased whole rather than having its first
    /// *letter* raised: <c>500ML</c> is <c>500ml</c>, not <c>500Ml</c>.
    /// </para>
    /// <para>
    /// <b>Known limitation:</b> acronyms flatten — <c>UHT</c> becomes <c>Uht</c>. Preserving them
    /// needs either a dictionary or an all-caps-and-short rule, and the short rule is worse than the
    /// problem: it would leave <c>SOUP OF THE DAY</c> as <c>Soup OF THE Day</c>. The name is
    /// editable on the row sheet, which is the right place to settle a case nobody can infer.
    /// </para>
    /// </remarks>
    public static string? TitleCase(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return name;

        var text = name.Trim();
        var builder = new StringBuilder(text.Length);
        // The first character of the string starts a word, and so does anything after a separator.
        var atWordStart = true;
        // True until this word's first letter has been raised — a word may open with digits or a
        // bracket before its first letter arrives.
        var wordHasLetter = false;

        foreach (var c in text)
        {
            if (char.IsWhiteSpace(c) || c is '-' or '/' or '(' or '[' or '&' or ',' or '.')
            {
                builder.Append(c);
                atWordStart = true;
                wordHasLetter = false;
                continue;
            }

            if (atWordStart && char.IsLetter(c))
            {
                builder.Append(char.ToUpperInvariant(c));
                atWordStart = false;
                wordHasLetter = true;
                continue;
            }

            // Still before the word's first letter (digits, quotes). Keep looking for one, but do
            // not treat what follows as mid-word yet — `500ml` should stay lowercase throughout.
            if (atWordStart && !char.IsLetter(c))
            {
                builder.Append(c);
                // A word that opened with a digit is a size or a code; leave the rest of it alone
                // rather than raising a letter in the middle of `500ml`.
                if (char.IsDigit(c)) { atWordStart = false; wordHasLetter = true; }
                continue;
            }

            builder.Append(wordHasLetter ? char.ToLowerInvariant(c) : c);
        }

        return builder.ToString();
    }

    /// <summary>
    /// The most specific name an outside catalogue gave us: the brand in front of the product, when
    /// the product name does not already carry it.
    /// </summary>
    /// <remarks>
    /// Catalogues split these fields, and the product half is often generic to the point of being
    /// useless on a shelf — <c>brands: "Grillo's"</c> with <c>product_name: "Pickle Spears"</c>. A row
    /// reading "Pickle Spears" is a row that cannot be told apart from the other jar of pickles, and
    /// the household then renames it by hand to the thing the database already knew.
    /// <para>
    /// <b>Only when it adds something.</b> Half of these records already lead with the brand
    /// (<c>"Coca-Cola Zero Sugar"</c> under <c>brands: "Coca-Cola"</c>), so the brand is prepended
    /// only when it is not already in the name — compared with punctuation and case folded away, or
    /// <c>Grillos</c> and <c>Grillo's</c> would read as different words and produce "Grillo's
    /// Grillos Pickle Spears".
    /// </para>
    /// <para>
    /// Still only a suggestion. It pre-fills <c>NAME IT</c> and decides nothing — whatever is in the
    /// box when SAVE is pressed is what the household gets, which is how the shelf ends up saying
    /// "Coke Zero" where the database says "Coca-Cola Zero Sugar 355 ml".
    /// </para>
    /// </remarks>
    public static string? Specific(string? brand, string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return string.IsNullOrWhiteSpace(brand) ? name : brand.Trim();
        if (string.IsNullOrWhiteSpace(brand)) return name.Trim();

        var product = name.Trim();
        var maker = brand.Trim();
        if (Fold(product).Contains(Fold(maker), StringComparison.Ordinal)) return product;

        var combined = $"{maker} {product}";
        // The column is the limit, and a truncated brand+product is worse than the product alone:
        // "Grillo's Italian Dill Pickle Spears In Br" is a name nobody would have chosen.
        return combined.Length <= PantryFieldLimits.ItemName ? combined : product;
    }

    /// <summary>Letters and digits only, lowercased — so <c>Grillo's</c> and <c>Grillos</c> match.</summary>
    private static string Fold(string value)
    {
        var builder = new StringBuilder(value.Length);
        foreach (var c in value)
        {
            if (char.IsLetterOrDigit(c)) builder.Append(char.ToLowerInvariant(c));
        }
        return builder.ToString();
    }
}
