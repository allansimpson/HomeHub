namespace HomeHub.Api.Pantry;

/// <summary>What an external catalogue knows about a barcode. All fields are suggestions.</summary>
public readonly record struct ProductInfo(
    string Name,
    string? Brand,
    /// <summary>Pack unit as the source states it — "ml", "g". Display, not maths.</summary>
    string? Unit,
    /// <summary>Numeric pack size in <see cref="Unit"/>, when the source gives one.</summary>
    decimal? PackSize,
    /// <summary>Named on screen, so a guessed name is never passed off as the household's own.</summary>
    string Source);

/// <summary>
/// Looks a barcode up somewhere outside the house.
/// </summary>
/// <remarks>
/// <b>This seam exists to suggest, never to decide.</b> DECISIONS PG4 deliberately rejected a
/// third-party catalogue — naming a pack once is "the entire learning mechanism, and it is enough" —
/// and that reasoning still holds for the thing it was protecting: the pantry stores the
/// <i>household's own words</i>. Open Food Facts will answer "Coca-Cola Zero Sugar 355 ml" where the
/// shelf says "Coke Zero", and the shelf has to win.
/// <para>
/// So a lookup only ever pre-fills the `NAME IT` field. Nothing here creates a pantry item, and
/// nothing here writes a catalogue entry — confirming does that, exactly as it did before, which is
/// what keeps the second scan of a pack resolving locally with no network call at all.
/// </para>
/// <para>
/// Every implementation must fail <b>silently and fast</b>. A scan is an interactive gesture in
/// someone's hand; an unreachable catalogue has to degrade to the unmatched row that was already
/// the designed behaviour, not to an error.
/// </para>
/// </remarks>
public interface IProductLookup
{
    /// <summary>Human-readable provenance, shown beside the suggestion.</summary>
    string Source { get; }

    /// <summary>Null when the barcode is unknown, the lookup is off, or anything went wrong.</summary>
    Task<ProductInfo?> LookupAsync(string barcode, CancellationToken ct);
}

/// <summary>
/// The default: no outbound lookup at all.
/// </summary>
/// <remarks>
/// Registered whenever the Open Food Facts integration is switched off, so the pantry behaves
/// exactly as the handoff specified — every new barcode is an unmatched row and the household names
/// it. That is a supported way to run the section, not a degraded one.
/// </remarks>
public sealed class NotConnectedProductLookup : IProductLookup
{
    public string Source => "none";

    public Task<ProductInfo?> LookupAsync(string barcode, CancellationToken ct) =>
        Task.FromResult<ProductInfo?>(null);
}
