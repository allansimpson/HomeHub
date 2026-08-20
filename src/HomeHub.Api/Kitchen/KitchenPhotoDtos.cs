namespace HomeHub.Api.Kitchen;

/// <summary>
/// A photograph handed to the Kitchen, to be read.
/// </summary>
/// <param name="ImageBase64">The image bytes, base64, with no data-URL prefix.</param>
/// <param name="MediaType">Its media type. Defaults to JPEG when the device did not say.</param>
public sealed record ReadKitchenPhotoRequest(string ImageBase64, string? MediaType);

/// <summary>One line as it was read — verbatim, and flagged if the reader struggled.</summary>
public sealed record ReadLineDto(string RawText, bool Unclear)
{
    public static ReadLineDto From(ReadLine line) => new(line.RawText, line.Unclear);
}

/// <summary>
/// What a photograph of a recipe yielded. Nothing has been saved.
/// </summary>
/// <remarks>
/// The panel renders this as ordinary editable fields and the household saves it with the existing
/// paste importer — so a photograph reaches the folder through a decision, exactly as an engagement
/// reaches the calendar through one.
/// </remarks>
public sealed record RecipeReadingDto(
    bool Available,
    string? Title,
    int? Servings,
    IReadOnlyList<ReadLineDto> Ingredients,
    IReadOnlyList<ReadLineDto> Steps,
    int UnclearCount,
    string? Reason)
{
    public static RecipeReadingDto From(RecipeReading reading)
    {
        ArgumentNullException.ThrowIfNull(reading);
        var ingredients = reading.Ingredients.Select(ReadLineDto.From).ToList();
        var steps = reading.Steps.Select(ReadLineDto.From).ToList();
        return new RecipeReadingDto(
            reading.Available,
            reading.Title,
            reading.Servings,
            ingredients,
            steps,
            // Counted server-side so the panel's `11 lines · 2 unclear` and the `UNCLEAR` tags can
            // never disagree about the same reading.
            ingredients.Count(l => l.Unclear) + steps.Count(l => l.Unclear),
            reading.Reason);
    }
}

/// <summary>What a photograph of an order or a till receipt yielded. Nothing has been saved.</summary>
public sealed record PurchaseReadingDto(
    bool Available,
    string? VendorLabel,
    IReadOnlyList<ReadLineDto> Lines,
    int UnclearCount,
    string? Reason)
{
    public static PurchaseReadingDto From(PurchaseReading reading)
    {
        ArgumentNullException.ThrowIfNull(reading);
        var lines = reading.Lines.Select(ReadLineDto.From).ToList();
        return new PurchaseReadingDto(
            reading.Available,
            reading.VendorLabel,
            lines,
            lines.Count(l => l.Unclear),
            reading.Reason);
    }
}
