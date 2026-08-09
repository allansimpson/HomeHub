namespace HomeHub.Api.Pantry;

/// <summary>
/// The one place that reads <see cref="PantryItem.Quantity"/> together with
/// <see cref="PantryItem.PackSize"/>.
/// </summary>
/// <remarks>
/// A counted item means one of two things and the fields alone do not say which:
/// <list type="bullet">
/// <item><b>Packaged</b> — a pack size is stated, so <c>Quantity</c> is a count of packages and the
/// amount on the shelf is the two multiplied. Five 3 oz pots is 15 oz.</item>
/// <item><b>Loose</b> — no pack size, so <c>Quantity</c> is already an amount in
/// <see cref="PantryItem.Unit"/>, exactly as it was before packages existed.</item>
/// </list>
/// Every comparison and every deduction has to pick the right reading, and picking the wrong one is
/// silent: "five containers" and "five ounces" are both plausible numbers on a shelf list. So the
/// reading lives here once rather than at each of the four call sites that need it.
/// <para>
/// <b>Nothing here converts between units.</b> It multiplies a count by a size, which is arithmetic
/// nobody can argue with. Whether the result can be compared to what a recipe asks for is still
/// <see cref="UnitConversion"/>'s question, and still usually answered "no".
/// </para>
/// </remarks>
public static class PantryAmounts
{
    /// <summary>Whether this row is counted in packages rather than in an amount.</summary>
    public static bool IsPackaged(PantryItem item) => item.PackSize is > 0;

    /// <summary>
    /// The unit the shelf's amount is expressed in — what a recipe line has to be converted into
    /// before the two can be compared.
    /// </summary>
    /// <remarks>
    /// On a packaged row this is <see cref="PantryItem.PackUnit"/> and <b>not</b>
    /// <see cref="PantryItem.Unit"/>: `Unit` there names the container, and comparing "4 oz" against
    /// a count of tins is precisely the conversion that has no honest answer.
    /// </remarks>
    public static string? MeasureUnit(PantryItem item) => IsPackaged(item) ? item.PackUnit : item.Unit;

    /// <summary>How much is on the shelf, in <see cref="MeasureUnit"/>.</summary>
    public static decimal OnHand(PantryItem item) =>
        IsPackaged(item) ? (item.Quantity ?? 0) * item.PackSize!.Value : item.Quantity ?? 0;

    /// <summary>
    /// Turn an amount in <see cref="MeasureUnit"/> into the change it makes to
    /// <see cref="PantryItem.Quantity"/>.
    /// </summary>
    /// <remarks>
    /// <b>Fractional packs are allowed, and that is the honest answer.</b> A recipe wanting 4 oz out
    /// of 3 oz pots leaves "a bit over three pots" of a five-pot shelf, and the row says so. Rounding
    /// up to whole packs would report a pot gone that is still more than half full — and then offer
    /// to put it on the shopping list, which is the confident wrongness DECISIONS P9 forbids.
    /// Rounding down would do the reverse and quietly hide a shortfall.
    /// </remarks>
    public static decimal ToQuantity(PantryItem item, decimal amount) =>
        IsPackaged(item) ? amount / item.PackSize!.Value : amount;

    /// <summary>
    /// Whether two rows describe the same thing to buy — the grouping key.
    /// </summary>
    /// <remarks>
    /// Name <b>and</b> size, because different sizes of one product are two things to run out of and
    /// two lines on a shopping list. Merging a 3 oz pot into a 32 oz tub because they share a name
    /// would make the count meaningless in the one place it is read: "how many have we got?"
    /// <para>
    /// A barcode, where there is one, is the better answer and the callers check it first — it
    /// already encodes brand, product and size, which is exactly this comparison done by the
    /// manufacturer.
    /// </para>
    /// </remarks>
    public static bool SameProduct(PantryItem item, string name, decimal? packSize, string? packUnit) =>
        string.Equals(item.Name, name, StringComparison.OrdinalIgnoreCase)
        && item.PackSize == packSize
        && string.Equals(item.PackUnit ?? string.Empty, packUnit ?? string.Empty, StringComparison.OrdinalIgnoreCase);
}
