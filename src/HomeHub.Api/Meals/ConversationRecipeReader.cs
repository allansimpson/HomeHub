namespace HomeHub.Api.Meals;

using System.Text.RegularExpressions;

/// <summary>
/// What a chat turned out to be holding. Nothing has been saved.
/// </summary>
/// <param name="Message">
/// Which message it was read out of, as an index into what the panel sent — newest first. The panel
/// sends that same message back to <c>POST /recipes/import/text</c> when the household says yes, so
/// the reading and the write are the same parse of the same block.
/// </param>
/// <param name="Link">
/// The first web address in the conversation, or null. Offered only when no message parsed: a chat
/// that is nothing but "here, look at this" and a URL still has a way in — the link importer.
/// </param>
public sealed record ChatRecipeReading(
    int? Message,
    ImportConfidence Confidence,
    RecipeInput? Recipe,
    string? Reason,
    string? Link);

/// <summary>
/// Reads a recipe out of what was said in a chat.
/// </summary>
/// <remarks>
/// <b>No new parser, and no model.</b> Each message is flattened out of markdown
/// (<see cref="MarkdownToText"/>) and handed to <see cref="PastedRecipeImporter"/> — the same parser
/// the paste box, the photograph and a page with no structured data all go through. A recipe read
/// out of a chat therefore scales, matches the pantry and merges exactly like every other one. A
/// second parser living somewhere else would diverge from the first, and nobody would notice until
/// a recipe doubled for eight bought half of what it should.
/// <para>
/// <b>Newest first, and the first complete reading wins.</b> That ordering is the whole of how "make
/// it dairy-free" is handled: the adapted version is further down the transcript than the original,
/// so it is the one that is found. A chat where nothing is complete falls back to the <i>richest</i>
/// partial rather than the newest one, because the newest is often the fragment that changed — a
/// message listing two substitutions is a correction, not a recipe, and saving it as one would put a
/// two-line recipe in the folder under a name that already means something else.
/// </para>
/// </remarks>
public static partial class ConversationRecipeReader
{
    /// <summary>
    /// How short a message can be and still be worth parsing.
    /// </summary>
    /// <remarks>
    /// "Save this recipe" is in the transcript too, and so is "Of course.". Neither can be a recipe
    /// — the parser would return Empty for both — but the floor says so without spending the work,
    /// and keeps the reading pinned to the message a person would point at.
    /// </remarks>
    public const int ShortestWorthReading = 80;

    /// <summary>How many messages back to look, whatever the panel sends.</summary>
    /// <remarks>
    /// A recipe somebody wants saved was discussed in the last few turns. Reading further back
    /// invites a chat's earlier, unrelated recipe to answer for the one on screen.
    /// </remarks>
    public const int MostMessages = 12;

    /// <summary>Read the transcript, newest message first. Writes nothing and fetches nothing.</summary>
    public static ChatRecipeReading Read(IReadOnlyList<string>? messages)
    {
        var said = (messages ?? []).Take(MostMessages).ToList();

        // Provenance first, and over every message including the short ones: the address is usually
        // in the member's own "can you adapt this — <url>", which is far too short to parse.
        var link = said.Select(FirstUrlIn).FirstOrDefault(u => u is not null);

        ChatRecipeReading? bestPartial = null;
        var bestLines = 0;

        for (var i = 0; i < said.Count; i++)
        {
            if (said[i] is not { Length: >= ShortestWorthReading } message) continue;

            var flattened = MarkdownToText.Flatten(message);
            if (flattened is null) continue;

            // The address of the page it came from, when the message carries one. Passed in rather
            // than left to the importer to find, because it is read off the *unflattened* message —
            // a markdown link's URL is not in the text once the markers come off.
            var result = PastedRecipeImporter.Parse(flattened, FirstUrlIn(message));
            if (result.Confidence == ImportConfidence.Empty || result.Recipe is null) continue;

            if (result.Confidence == ImportConfidence.Complete)
                return new ChatRecipeReading(i, result.Confidence, result.Recipe, result.Reason, link);

            var lines = result.Recipe.Ingredients?.Count ?? 0;
            lines += result.Recipe.Steps?.Count ?? 0;
            if (lines <= bestLines) continue;
            bestLines = lines;
            bestPartial = new ChatRecipeReading(i, result.Confidence, result.Recipe, result.Reason, link);
        }

        return bestPartial ?? new ChatRecipeReading(
            null,
            ImportConfidence.Empty,
            null,
            // Said as a fact about the conversation, not about the household: there is a way forward
            // in both halves of it, and the panel draws whichever applies.
            link is null
                ? "I can't find a recipe in what we've said."
                : "I can't find a recipe written out here, but there is a link.",
            link);
    }

    /// <summary>The first address in one message, or null. Never fetched here.</summary>
    private static string? FirstUrlIn(string? message)
    {
        if (string.IsNullOrEmpty(message)) return null;
        var match = AnyUrl().Match(message);
        return match.Success && match.Value.Length <= MealFieldLimits.Url ? match.Value : null;
    }

    /// <summary>
    /// A web address anywhere in a message.
    /// </summary>
    /// <remarks>
    /// The trailing bracket is excluded so a markdown link — `[the recipe](https://…)` — yields the
    /// address and not the address plus the syntax around it.
    /// </remarks>
    [GeneratedRegex(@"https?://[^\s""'<>()\]]+", RegexOptions.IgnoreCase)]
    private static partial Regex AnyUrl();
}
