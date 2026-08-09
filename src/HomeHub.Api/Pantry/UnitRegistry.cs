namespace HomeHub.Api.Pantry;

using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// The one thing that turns a typed unit into a stored one — and the only thing that ever adds a
/// row to <see cref="MeasurementUnit"/>.
/// </summary>
/// <remarks>
/// Every field where somebody types a unit goes through here: a pantry item by hand, a scanned pack
/// being named, a corrected order line, a grocery line, and every ingredient on a recipe however it
/// arrived. One normaliser, because the value of canonical units is entirely in their being the
/// <i>same</i> everywhere — a pantry that stores <c>oz</c> and a recipe that stores <c>ounces</c>
/// is a stock check that cannot answer.
/// <para>
/// <b>Free text is allowed and is the point of the table.</b> A unit nobody predefined — "bunch",
/// "clove", "sleeve" — is folded, stored under its own name, and joins the list, so the second
/// person to reach for it gets it offered rather than typing it slightly differently. Refusing
/// unknown units would be the strictness that makes people write the unit into the item's name.
/// </para>
/// <para>
/// <b>Load once, then resolve synchronously.</b> A recipe save normalises fifteen lines and a
/// pantry save one; a per-value database round trip would be fifteen queries to answer a question
/// about a thirty-row table. Callers <c>await</c> <see cref="LoadAsync"/> once and then call
/// <see cref="Normalise"/> as often as they like — which is also what lets the resolution happen
/// inside the plain, synchronous <c>Apply</c> helpers the controllers already have.
/// </para>
/// </remarks>
public sealed class UnitRegistry
{
    /// <summary>Where a unit somebody typed sits in the picker: after everything predefined.</summary>
    public const int AdoptedSortOrder = 1000;

    private readonly HomeHubDbContext _db;
    private readonly TimeProvider _clock;

    /// <summary>Folded spelling → canonical form. Null until <see cref="LoadAsync"/> has run.</summary>
    private Dictionary<string, string>? _canonicalByAlias;

    public UnitRegistry(HomeHubDbContext db, TimeProvider clock)
    {
        _db = db;
        _clock = clock;
    }

    /// <summary>
    /// Fold a typed unit to the form the alias table is keyed on: trimmed, lowercased, inner
    /// whitespace collapsed, periods dropped.
    /// </summary>
    /// <remarks>
    /// Periods go so <c>tsp.</c> and <c>fl. oz.</c> need no entries of their own, and the whitespace
    /// collapse is what makes <c>fl  oz</c> and <c>fl oz</c> the same key. Everything else is left
    /// alone: folding more aggressively (stripping plurals, say) would quietly merge units that are
    /// not the same thing, and the alias table is the right place to say which spellings are.
    /// </remarks>
    public static string Fold(string raw) =>
        string.Join(' ', raw.Replace(".", string.Empty)
            .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries))
            .ToLowerInvariant();

    /// <summary>
    /// Read the unit table into memory for this request. Idempotent — call it at the top of any
    /// action that normalises.
    /// </summary>
    public async Task LoadAsync(CancellationToken ct)
    {
        if (_canonicalByAlias is not null) return;

        var rows = await _db.MeasurementUnitAliases
            .Select(a => new { a.Alias, a.Unit!.Canonical })
            .ToListAsync(ct);

        _canonicalByAlias = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var row in rows) _canonicalByAlias[row.Alias] = row.Canonical;
    }

    /// <summary>
    /// The canonical form of a typed unit, adopting it into the table when it is new.
    /// </summary>
    /// <returns>
    /// Null when nothing was typed — <b>no unit is a real answer</b>, not a missing one. "2 eggs"
    /// and "6 lemons" are how most of a pantry is counted, and inventing a unit for them would put
    /// a word on the row that nobody chose.
    /// </returns>
    /// <remarks>
    /// A new unit is <i>added to the caller's change tracker</i>, not saved here: it becomes real
    /// when the pantry item or recipe that introduced it is saved, and a save that fails leaves no
    /// orphan unit behind. This is the same shape as <c>PantryController.SeedAliasAsync</c>, and it
    /// carries the same accepted race — two requests introducing the same brand-new word in the same
    /// instant, on a household panel, where one of them loses to the unique index.
    /// <para>
    /// A unit too long for the column is folded and returned but <b>not</b> adopted. The controllers
    /// reject overlong units against <see cref="PantryFieldLimits.Unit"/> already; adopting one here
    /// would turn their tidy 400 into a truncation error from SQL Server.
    /// </para>
    /// </remarks>
    public string? Normalise(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;

        var key = Fold(raw);
        if (key.Length == 0) return null;

        var known = _canonicalByAlias
            ?? throw new InvalidOperationException($"Call {nameof(LoadAsync)} before normalising.");

        if (known.TryGetValue(key, out var canonical)) return canonical;
        if (key.Length > PantryFieldLimits.Unit) return key;

        var unit = new MeasurementUnit
        {
            Canonical = key,
            // No spelled-out form: "sleeve" is already the whole word, and guessing a longer one
            // would be the panel putting words in somebody's mouth.
            DisplayName = null,
            IsSeeded = false,
            SortOrder = AdoptedSortOrder,
            CreatedUtc = _clock.GetUtcNow().UtcDateTime,
        };
        // Through the navigation so EF fixes up the foreign key once the new unit has an id.
        unit.Aliases.Add(new MeasurementUnitAlias { Alias = key });
        _db.MeasurementUnits.Add(unit);

        // Remembered immediately, so a recipe with "sleeve" on three lines adds one unit, not three.
        known[key] = key;
        return key;
    }

    /// <summary>The whole list, ordered the way the picker shows it.</summary>
    public Task<List<MeasurementUnit>> ListAsync(CancellationToken ct) =>
        _db.MeasurementUnits
            .Include(u => u.Aliases)
            .OrderBy(u => u.SortOrder).ThenBy(u => u.Canonical)
            .ToListAsync(ct);
}
