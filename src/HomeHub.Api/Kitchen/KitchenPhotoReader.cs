namespace HomeHub.Api.Kitchen;

using System.Text.Json.Serialization;
using HomeHub.Api.Calendar.Capture;

/// <summary>One line as it was read, kept verbatim.</summary>
/// <param name="RawText">
/// Exactly what was on the page.
/// <para>
/// <b>Never normalised, never dropped.</b> It is the only evidence of what the photograph actually
/// said, and it is what makes a wrong reading arguable weeks later rather than merely wrong.
/// </para>
/// </param>
/// <param name="Unclear">
/// Whether the reader struggled with this line. Renders as <c>UNCLEAR</c> and blocks nothing —
/// a line nobody could read is still a line that was on the page.
/// </param>
public sealed record ReadLine(string RawText, bool Unclear);

/// <summary>What one photograph of a recipe yielded, before anybody has confirmed a word of it.</summary>
/// <param name="Available">
/// Whether a reading could be attempted at all. Separate from an empty result on purpose: "this
/// panel cannot read photographs" is not a fact about the photograph, and the panel must not blame
/// a picture that may be perfectly clear.
/// </param>
/// <param name="Reason">A sentence for the household when there is nothing, else null.</param>
public sealed record RecipeReading(
    bool Available,
    string? Title,
    int? Servings,
    IReadOnlyList<ReadLine> Ingredients,
    IReadOnlyList<ReadLine> Steps,
    string? Reason)
{
    public static RecipeReading Nothing(string? reason, bool available = true) =>
        new(available, null, null, [], [], reason);
}

/// <summary>What one photograph of an order or a till receipt yielded.</summary>
public sealed record PurchaseReading(
    bool Available,
    string? VendorLabel,
    IReadOnlyList<ReadLine> Lines,
    string? Reason)
{
    public static PurchaseReading Nothing(string? reason, bool available = true) =>
        new(available, null, [], reason);
}

/// <summary>
/// Reading the Kitchen's two kinds of photograph — a recipe page, and an order.
/// </summary>
/// <remarks>
/// <para>
/// <b>The same mechanism as reading an engagement off a flyer</b>, and deliberately so: cookbook
/// pages, handwritten cards, phone screenshots and delivery confirmations are all a stranger's
/// printed words, and they get the same treatment — a profile with no callable tools, a closed
/// response shape per mode, and a reading that <i>writes nothing</i>.
/// </para>
/// <para>
/// <b>Nothing here persists.</b> A recipe reaches the folder through the ordinary import endpoint
/// after somebody has looked at what was read; a delivery reaches the pantry through the ordinary
/// put-away commit. That is what keeps a misread photograph from becoming twenty-four wrong rows.
/// </para>
/// </remarks>
public interface IKitchenPhotoReader
{
    /// <summary>Whether a reading can be attempted at all. False means no reader is configured.</summary>
    bool IsAvailable { get; }

    Task<RecipeReading> ReadRecipeAsync(NormalizedImage image, CancellationToken ct);

    Task<PurchaseReading> ReadPurchasesAsync(NormalizedImage image, CancellationToken ct);
}

/// <inheritdoc />
public sealed class KitchenPhotoReader : IKitchenPhotoReader
{
    private readonly IImageExtractionClient _client;

    public KitchenPhotoReader(IImageExtractionClient client) => _client = client;

    public bool IsAvailable => _client.IsAvailable;

    public async Task<RecipeReading> ReadRecipeAsync(NormalizedImage image, CancellationToken ct)
    {
        if (!IsAvailable) return RecipeReading.Nothing(NotSwitchedOn, available: false);

        var result = await _client.ExtractAsync<RawRecipeReply>(
            ImageAnalysisMode.Recipe, image, RecipeInstruction, ct);

        if (result.Status != ImageExtractionStatus.Success || result.Proposal is not { } reply)
            return RecipeReading.Nothing(Excuse(result.Status, "I can't find a recipe on that one."));

        var ingredients = Lines(reply.Ingredients);
        var steps = Lines(reply.Steps);
        if (ingredients.Count == 0 && steps.Count == 0)
            return RecipeReading.Nothing("I can't find a recipe on that one.");

        return new RecipeReading(true, Clean(reply.Title), reply.Servings, ingredients, steps, null);
    }

    public async Task<PurchaseReading> ReadPurchasesAsync(NormalizedImage image, CancellationToken ct)
    {
        if (!IsAvailable) return PurchaseReading.Nothing(NotSwitchedOn, available: false);

        var result = await _client.ExtractAsync<RawPurchaseReply>(
            ImageAnalysisMode.PurchasedItems, image, PurchaseInstruction, ct);

        if (result.Status != ImageExtractionStatus.Success || result.Proposal is not { } reply)
            return PurchaseReading.Nothing(Excuse(result.Status, "I can't find an order on that one."));

        var lines = Lines(reply.Lines);
        return lines.Count == 0
            ? PurchaseReading.Nothing("I can't find an order on that one.")
            : new PurchaseReading(true, Clean(reply.Vendor), lines, null);
    }

    private const string NotSwitchedOn = "Reading photographs isn't switched on for this panel.";

    /// <summary>
    /// What actually happened, in the household's words.
    /// </summary>
    /// <remarks>
    /// One sentence for everything is the trap this seam keeps falling into. "I can't find a recipe
    /// on that one" is a statement about the photograph, and saying it after a timeout sends
    /// somebody off to re-photograph a page that was never the problem. Exactly one branch here is
    /// allowed to blame the picture, and the caller passes in its wording.
    /// </remarks>
    private static string Excuse(ImageExtractionStatus status, string blamesThePicture) => status switch
    {
        ImageExtractionStatus.Success or ImageExtractionStatus.UnreadableOrInsufficient => blamesThePicture,
        ImageExtractionStatus.Busy => "I'm reading another photo just now — try that one again in a moment.",
        ImageExtractionStatus.TimedOut => "That took too long to read. Trying again usually works.",
        ImageExtractionStatus.ModelRunFailed or ImageExtractionStatus.Unavailable =>
            "I couldn't read that one just now. Try again in a moment.",
        ImageExtractionStatus.MalformedOutput or ImageExtractionStatus.SemanticValidationFailed =>
            "I couldn't make sense of that one.",
        _ => "",
    };

    /// <summary>
    /// Bounded, trimmed, and with the blanks dropped.
    /// </summary>
    /// <remarks>
    /// The cap is on the count and on each line, because the answer is untrusted input and a
    /// photograph of a page of dense text is a plausible way to hand the panel a megabyte of it.
    /// </remarks>
    private static IReadOnlyList<ReadLine> Lines(IReadOnlyList<RawLine>? raw)
    {
        if (raw is null) return [];
        return [.. raw
            .Where(l => !string.IsNullOrWhiteSpace(l.Text))
            .Take(200)
            .Select(l => new ReadLine(Truncate(l.Text!.Trim(), 300), l.Unclear ?? false))];
    }

    private static string? Clean(string? value)
    {
        var text = value?.Trim();
        return string.IsNullOrEmpty(text) ? null : Truncate(text, 200);
    }

    private static string Truncate(string value, int max) => value.Length <= max ? value : value[..max];

    /// <summary>
    /// The trusted, mode-fixed instruction. Nothing in the image can change it.
    /// </summary>
    /// <remarks>
    /// It asks for verbatim lines rather than a parsed structure. HomeHub already has an ingredient
    /// parser that every other import path goes through, and a second one living inside a model
    /// would scale amounts differently from the first — which is the sort of divergence nobody
    /// notices until a recipe doubled for eight buys half of what it should.
    /// </remarks>
    private const string RecipeInstruction = """
        Read the recipe off this image.

        Return exactly one JSON object with only this shape:

        {"title":string|null,"servings":integer|null,
         "ingredients":[{"text":string,"unclear":boolean}],
         "steps":[{"text":string,"unclear":boolean}]}

        Rules:
        - Copy each ingredient line and each step VERBATIM, exactly as printed, including amounts.
          Do not convert units, do not tidy the wording, do not merge or split lines.
        - Set unclear to true for any line you had to strain to read. Include it anyway — a line
          nobody can read is still a line that was on the page.
        - servings ONLY if the page prints it. Never infer it from the amounts.
        - Leave any field null rather than guessing at it.
        - An image with no recipe on it returns empty lists.
        """;

    /// <remarks>
    /// Says <i>every</i> line, twice, because the interesting failure is the quiet one: a reader
    /// that drops what it does not recognise produces a plausible short order, and a pantry that
    /// only knows about the lines a model found easy is wrong by however much was left out.
    /// </remarks>
    private const string PurchaseInstruction = """
        Read the purchased items off this image — a screenshot of a delivery order, or a photograph
        of a till receipt.

        Return exactly one JSON object with only this shape:

        {"vendor":string|null,"lines":[{"text":string,"unclear":boolean}]}

        Rules:
        - One entry per purchased item, copied VERBATIM including any quantity, size or pack count.
        - Include EVERY item line, including ones you are unsure of. Set unclear to true for those
          and copy the characters as best you can rather than omitting the line.
        - Skip totals, subtotals, tax, delivery fees, tips, loyalty messages and payment details.
        - vendor is the shop's name if it is printed, else null.
        - An image with no purchased items on it returns an empty list.
        """;

    /// <summary>One untrusted line as the reader answered it.</summary>
    private sealed record RawLine(
        [property: JsonPropertyName("text")] string? Text,
        [property: JsonPropertyName("unclear")] bool? Unclear);

    private sealed record RawRecipeReply(
        [property: JsonPropertyName("title")] string? Title,
        [property: JsonPropertyName("servings")] int? Servings,
        [property: JsonPropertyName("ingredients")] IReadOnlyList<RawLine>? Ingredients,
        [property: JsonPropertyName("steps")] IReadOnlyList<RawLine>? Steps);

    private sealed record RawPurchaseReply(
        [property: JsonPropertyName("vendor")] string? Vendor,
        [property: JsonPropertyName("lines")] IReadOnlyList<RawLine>? Lines);
}

/// <summary>The reader when none is configured. Says so, and never blames a photograph for it.</summary>
public sealed class NotConfiguredKitchenPhotoReader : IKitchenPhotoReader
{
    public bool IsAvailable => false;

    public Task<RecipeReading> ReadRecipeAsync(NormalizedImage image, CancellationToken ct) =>
        Task.FromResult(RecipeReading.Nothing(
            "Reading photographs isn't switched on for this panel.", available: false));

    public Task<PurchaseReading> ReadPurchasesAsync(NormalizedImage image, CancellationToken ct) =>
        Task.FromResult(PurchaseReading.Nothing(
            "Reading photographs isn't switched on for this panel.", available: false));
}
