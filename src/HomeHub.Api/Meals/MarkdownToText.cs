namespace HomeHub.Api.Meals;

using System.Text.RegularExpressions;

/// <summary>
/// Flattens the markdown an agent writes into the kind of text a person would have pasted.
/// </summary>
/// <remarks>
/// <b>The same job as <see cref="HtmlToText"/>, one carrier format along.</b> A recipe that arrives
/// in a chat is markdown — <c>## Ingredients</c>, <c>**2 cups** flour</c>, sometimes a fenced block
/// or a table — and <see cref="PastedRecipeImporter"/> reads lines of plain text. Its section
/// headings are matched <b>whole</b>, so <c>## Ingredients</c> is not the word `ingredients` to it:
/// left as they are, the headings are missed and the entire block reads as one unsectioned list.
/// <para>
/// So the markers come off and the lines stay. This is deliberately <b>not</b> a markdown parser,
/// for the same reason <see cref="HtmlToText"/> is not an HTML one: the parser downstream fails by
/// leaving a field empty rather than by filling it wrongly, so a block this flattens badly yields a
/// <c>Partial</c> reading somebody can see and correct — never a confident wrong recipe.
/// </para>
/// <para>
/// <b>Addresses are stripped, not followed.</b> A link becomes its own text; the URL is picked up
/// separately as provenance (<see cref="ConversationRecipeReader"/>) and nothing here fetches
/// anything.
/// </para>
/// </remarks>
public static partial class MarkdownToText
{
    /// <summary>How much of one message is worth reading. A long recipe with notes is a few KB.</summary>
    private const int MaxCharacters = 100_000;

    /// <summary>The message as plain lines, or null when there was nothing textual in it.</summary>
    public static string? Flatten(string? markdown)
    {
        if (string.IsNullOrWhiteSpace(markdown)) return null;

        var text = markdown.Length <= MaxCharacters ? markdown : markdown[..MaxCharacters];
        var raws = text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
        var kept = new List<string>();

        for (var i = 0; i < raws.Length; i++)
        {
            // Non-breaking spaces travel with anything copied off a page and defeat every trim
            // downstream.
            var line = raws[i].Replace(' ', ' ').Trim();

            // The fence markers go; what is inside them stays. An agent asked for a recipe often
            // puts the whole thing in a fenced block, and dropping the block would throw away the
            // one message worth reading.
            if (Fence().IsMatch(line)) continue;

            line = Heading().Replace(line, string.Empty);
            line = Quote().Replace(line, string.Empty);

            // `|---|---:|` is a table's rule, and `---` is a horizontal one. Neither is content.
            if (TableRule().IsMatch(line)) continue;
            if (line.StartsWith('|'))
            {
                // The row above the rule is the table's header — `Amount | Ingredient` — which is
                // column labels, not an ingredient. Left in, it lands immediately above the list
                // where the recipe's name would be, and gets taken for the name.
                if (RuleFollows(raws, i)) continue;
                line = TableCells(line);
            }

            line = Image().Replace(line, string.Empty);
            line = Link().Replace(line, "$1");
            line = StrongMark().Replace(line, string.Empty);
            line = EmphasisMark().Replace(line, string.Empty);
            line = line.Replace("`", string.Empty, StringComparison.Ordinal);

            line = line.Trim();
            if (line.Length == 0) continue;
            kept.Add(line);
        }

        return kept.Count == 0 ? null : string.Join('\n', kept);
    }

    /// <summary>Whether the next line with anything on it is a table's alignment rule.</summary>
    private static bool RuleFollows(string[] lines, int index)
    {
        for (var i = index + 1; i < lines.Length; i++)
        {
            var next = lines[i].Trim();
            if (next.Length == 0) continue;
            return TableRule().IsMatch(next);
        }
        return false;
    }

    /// <summary>
    /// One table row as a line — `| 2 cups | plain flour |` becomes `2 cups plain flour`.
    /// </summary>
    /// <remarks>
    /// A two-column table is how an agent lays out an ingredient list when it is being tidy, and the
    /// cells joined by a space are exactly the line a person would have pasted. Nothing is dropped:
    /// a wider table joins all of its cells, which reads oddly and parses as one unclear ingredient
    /// rather than as a silently halved one.
    /// </remarks>
    private static string TableCells(string line) =>
        string.Join(' ', line.Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));

    /// <summary>A fenced block's opening or closing marker — ``` or ~~~, with or without a language.</summary>
    [GeneratedRegex(@"^\s*(?:```|~~~)\s*\w*\s*$")]
    private static partial Regex Fence();

    /// <summary>An ATX heading's leading hashes. `## Ingredients` is the case that matters.</summary>
    [GeneratedRegex(@"^\s{0,3}#{1,6}\s*")]
    private static partial Regex Heading();

    /// <summary>Block-quote markers, however many deep.</summary>
    [GeneratedRegex(@"^(?:\s*>)+\s?")]
    private static partial Regex Quote();

    /// <summary>A table's alignment rule, or a horizontal rule. Punctuation, never content.</summary>
    [GeneratedRegex(@"^\s*\|?[\s:|*_-]*[-*_][\s:|*_-]*\|?\s*$")]
    private static partial Regex TableRule();

    /// <summary>An inline image. Dropped whole — its alt text is not part of the recipe.</summary>
    [GeneratedRegex(@"!\[[^\]]*\]\([^)]*\)")]
    private static partial Regex Image();

    /// <summary>An inline link, kept as the words it was written on.</summary>
    [GeneratedRegex(@"\[([^\]]*)\]\([^)]*\)")]
    private static partial Regex Link();

    /// <summary>Bold and its underscore spelling.</summary>
    [GeneratedRegex(@"\*\*|__")]
    private static partial Regex StrongMark();

    /// <summary>
    /// A single emphasis marker — one that opens or closes a run of words.
    /// </summary>
    /// <remarks>
    /// Written as open/close rather than as "every asterisk" so a bullet survives: `* 2 cups flour`
    /// has a marker followed by a space, which is neither an opener nor a closer, and the ingredient
    /// parser is the thing that strips list markers (it has its own list, and it knows a leading
    /// number is an amount).
    /// </remarks>
    [GeneratedRegex(@"(?<=\S)[*_](?=[\s\p{P}]|$)|(?<=^|[\s\p{P}])[*_](?=\S)")]
    private static partial Regex EmphasisMark();
}
