namespace HomeHub.Api.Pantry;

/// <summary>
/// One unit the household measures in — the canonical spelling of it, and nothing else.
/// </summary>
/// <remarks>
/// <b>A lookup table rather than a constant, because the list has to grow.</b> A fixed vocabulary
/// would be right if the household only ever bought things that came in grams and tins, but the
/// kitchen also holds a bunch of parsley and a clove of garlic, and "we don't have a unit for that"
/// is not an answer anybody can act on. So the predefined list is seeded here and every free-text
/// unit somebody types joins it — see <see cref="UnitRegistry"/>, which is the only thing that
/// writes rows.
/// <para>
/// What the table buys is the thing a free-text column cannot: <c>ounces</c>, <c>oz</c>, <c>OZ</c>
/// and <c>Oz.</c> are one unit, stored once, displayed once. Four spellings of one unit is four
/// units to anybody reading the pantry, and it is exactly how a shelf ends up listed twice.
/// </para>
/// <para>
/// This is a naming table, <b>not</b> an arithmetic one. What may honestly be converted into what
/// is <see cref="UnitConversion"/>'s question and stays there — a household adding "bunch" must not
/// be taken to have claimed that a bunch is worth some number of grams.
/// </para>
/// </remarks>
public class MeasurementUnit
{
    public int Id { get; set; }

    /// <summary>
    /// The one spelling that gets stored and shown — <c>oz</c>, <c>mL</c>, <c>bunch</c>.
    /// </summary>
    /// <remarks>
    /// Cased for reading rather than lowercased for tidiness: <c>mL</c> and <c>L</c> earn their
    /// capitals because a lowercase <c>l</c> beside a quantity is a <c>1</c> at arm's length, which
    /// is the distance a wall panel is read from. Matching ignores case regardless — see
    /// <see cref="MeasurementUnitAlias"/>.
    /// </remarks>
    public string Canonical { get; set; } = string.Empty;

    /// <summary>
    /// The unit said in full — "ounces", "tablespoons" — for the picker's second line.
    /// </summary>
    /// <remarks>
    /// Null on anything the household typed itself. "bunch" is already the whole word, and inventing
    /// a longer form of it would be the panel putting words in somebody's mouth.
    /// </remarks>
    public string? DisplayName { get; set; }

    /// <summary>False for anything a household member introduced by typing it.</summary>
    /// <remarks>
    /// Kept because the two kinds sort differently and read differently — the seeded list is offered
    /// first, and a unit somebody added is theirs rather than the panel's.
    /// </remarks>
    public bool IsSeeded { get; set; }

    /// <summary>Where it sits in the picker; seeded units are ordered by how often a kitchen reaches
    /// for them, and adopted ones fall in behind at <see cref="UnitRegistry.AdoptedSortOrder"/>.</summary>
    public int SortOrder { get; set; }

    public DateTime CreatedUtc { get; set; }

    public List<MeasurementUnitAlias> Aliases { get; } = [];
}

/// <summary>
/// One accepted spelling of a unit. Every canonical form carries an alias for itself, so a single
/// lookup answers every question this table exists to answer.
/// </summary>
/// <remarks>
/// Stored already-folded — lowercased, trimmed, inner runs of whitespace collapsed, periods
/// dropped — by <see cref="UnitRegistry.Fold"/>. Folding on the way in rather than comparing
/// cleverly on the way out is what keeps the unique index meaningful: two rows that differ only in
/// case are the bug, not two rows the query has to be smart about.
/// </remarks>
public class MeasurementUnitAlias
{
    public int Id { get; set; }

    public int UnitId { get; set; }

    public MeasurementUnit? Unit { get; set; }

    /// <summary>The folded spelling — <c>ounces</c>, <c>oz</c>, <c>fl oz</c>.</summary>
    public string Alias { get; set; } = string.Empty;
}
