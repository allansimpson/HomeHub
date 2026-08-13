namespace HomeHub.Api.Calendar.Capture;

using System.Text.Json;
using System.Text.Json.Serialization;

/// <summary>
/// Reading a model's answer back, in the one place both providers share.
/// </summary>
/// <remarks>
/// The envelope is OpenAI's chat-completions shape, which is also what Hermes speaks — so the two
/// implementations of <see cref="IEventExtractor"/> differ in how they *ask* and not at all in how
/// they read the reply. Keeping that here means a parsing fix cannot land in one provider and miss
/// the other, which is exactly how the case-sensitivity bug survived: it was in the hand-written
/// deserialisation and invisible to every test, because the tests all ran the simulated reader.
/// </remarks>
internal static class ExtractionJson
{
    /// <summary>
    /// Web defaults — camelCase and case-insensitive.
    /// </summary>
    /// <remarks>
    /// The models answer in camelCase (<c>title</c>, <c>month</c>); <see cref="RawDraft"/> declares
    /// PascalCase. Plain <c>JsonSerializer</c> defaults are case-sensitive, so nothing bound, every
    /// field came back null, and the reading reported "no date on that one" about a photograph it had
    /// read perfectly.
    /// </remarks>
    internal static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);

    /// <summary>
    /// The drafts in a model's answer, or null when there is nothing usable in it.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Lenient on the wrapping, strict on the content.</b> A provider that enforces a schema
    /// returns bare JSON; one that has merely been *asked* for JSON in a prompt returns bare JSON
    /// most of the time and occasionally dresses it — a fenced block, a "Here you go:" before it.
    /// That difference is the price of the Hermes path, and it is worth paying at the parser rather
    /// than by giving up and calling a readable flyer unreadable.
    /// </para>
    /// <para>
    /// What it will not do is repair malformed JSON or go looking for fields in prose. Anything that
    /// does not parse returns null, the reading reports nothing found, and the household is told the
    /// truth — the alternative is guessing at an engagement, which is the one thing this feature must
    /// never do.
    /// </para>
    /// </remarks>
    internal static ReadingReply? Parse(string? content) => ParseOne<ReadingReply>(content);

    /// <summary>
    /// Exactly one JSON object out of a model's answer, as the given shape — or null.
    /// </summary>
    /// <remarks>
    /// The general form of <see cref="Parse"/>, so a mode with its own closed DTO gets the same
    /// transport tolerance and the same refusal to guess. <b>Transport recovery only:</b> it will
    /// unwrap a fence and ignore prose around a single object, and it will not repair malformed JSON
    /// or hunt fields out of sentences.
    /// </remarks>
    internal static T? ParseOne<T>(string? content) where T : class
    {
        var text = content?.Trim();
        if (string.IsNullOrEmpty(text)) return null;

        // A fenced block: ```json ... ``` or ``` ... ```.
        if (text.StartsWith("```", StringComparison.Ordinal))
        {
            var firstBreak = text.IndexOf('\n');
            var lastFence = text.LastIndexOf("```", StringComparison.Ordinal);
            if (firstBreak > 0 && lastFence > firstBreak)
                text = text[(firstBreak + 1)..lastFence].Trim();
        }

        // Prose either side of the object. Taken from the first brace to the last, which is the whole
        // object for every shape seen in practice and simply fails to parse for anything stranger.
        if (!text.StartsWith('{'))
        {
            var open = text.IndexOf('{', StringComparison.Ordinal);
            var close = text.LastIndexOf('}');
            if (open < 0 || close <= open) return null;
            text = text[open..(close + 1)];
        }

        try
        {
            return JsonSerializer.Deserialize<T>(text, Options);
        }
        catch (JsonException)
        {
            // Not JSON after all. The caller reports nothing found rather than inventing an
            // engagement, and the household gets a sentence it can act on.
            return null;
        }
    }
}

/// <summary>What a reading answered with: the drafts, before any rule has been applied.</summary>
internal sealed record ReadingReply(
    [property: JsonPropertyName("events")] IReadOnlyList<RawDraft>? Events);

/// <summary>The chat-completions envelope, trimmed to the one field that carries the answer.</summary>
internal sealed record ChatCompletion(
    [property: JsonPropertyName("choices")] IReadOnlyList<ChatChoice>? Choices);

internal sealed record ChatChoice(
    [property: JsonPropertyName("message")] ChatMessage? Message);

internal sealed record ChatMessage(
    [property: JsonPropertyName("content")] string? Content);
