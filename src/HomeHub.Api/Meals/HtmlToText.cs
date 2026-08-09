namespace HomeHub.Api.Meals;

using System.Net;
using System.Text;
using System.Text.RegularExpressions;

/// <summary>
/// Flattens a fetched page into the kind of text a person would have copied off it.
/// </summary>
/// <remarks>
/// <b>Why this is not the tag stripper <see cref="JsonLdRecipeImporter"/> already has.</b> That one
/// cleans a single field value and collapses everything to one line, which is right for a JSON-LD
/// string and useless here: <see cref="PastedRecipeImporter"/> reads <i>lines</i>, and a page
/// flattened to one line has no ingredients, no steps and no title — just a paragraph.
/// <para>
/// So the job is structural. Block elements and list items become line breaks, the parts of the
/// document that are never recipe (script, style, nav, header, footer, form) are dropped whole, and
/// what is left is handed to the same parser a paste goes through.
/// </para>
/// <para>
/// This is deliberately <b>not</b> an HTML parser. It is a best-effort flattener over markup we
/// already hold, feeding a parser whose contract is that failure means missing fields rather than
/// wrong ones — so a page it flattens badly yields a `Partial` import or none, never a confident
/// wrong recipe. Bringing in a real DOM library to do better is a reasonable later call; it is not
/// warranted to read the twenty sites a household actually cooks from.
/// </para>
/// </remarks>
public static partial class HtmlToText
{
    /// <summary>How much flattened text is worth handing on. A recipe page is tens of KB of markup.</summary>
    private const int MaxCharacters = 200_000;

    /// <summary>The page as lines, or null when there was nothing textual in it.</summary>
    public static string? Flatten(string? html)
    {
        if (string.IsNullOrWhiteSpace(html)) return null;

        // Whole subtrees that are never the recipe. Dropped before anything else so their contents
        // never reach the line splitter — a nav full of `<li>` items would otherwise arrive as a
        // very convincing ingredient list.
        var text = DeadWeight().Replace(html, "\n");

        // Comments can contain anything, including markup that would confuse the tag stripper.
        text = Comment().Replace(text, " ");

        // The structural half: anything that renders as its own line becomes one. `<br>` and `</li>`
        // are the two that matter most — an ingredient list is `<li>` per ingredient, and losing
        // those boundaries welds the whole list into a single unreadable line.
        text = LineBreaking().Replace(text, "\n");

        // Everything else goes, leaving a space so `<b>hot</b>butter` does not weld into one word.
        text = HtmlTag().Replace(text, " ");
        text = WebUtility.HtmlDecode(text);

        return Tidy(text);
    }

    /// <summary>Collapse runs of spaces and blank lines, trim each line, drop the empties.</summary>
    private static string? Tidy(string text)
    {
        var builder = new StringBuilder(Math.Min(text.Length, MaxCharacters));
        foreach (var raw in text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n'))
        {
            // Non-breaking spaces are everywhere in recipe markup and are not whitespace to `Trim`.
            var line = Spaces().Replace(raw.Replace(' ', ' '), " ").Trim();
            if (line.Length == 0) continue;
            // A gap left before punctuation that closed a tag: "Fry <b>hot</b>." → "Fry hot .".
            line = BeforePunctuation().Replace(line, "$1");
            if (builder.Length + line.Length + 1 > MaxCharacters) break;
            builder.Append(line).Append('\n');
        }

        var result = builder.ToString().TrimEnd();
        return result.Length == 0 ? null : result;
    }

    /// <summary>Subtrees that are never recipe content, dropped whole.</summary>
    [GeneratedRegex(
        @"<(script|style|noscript|svg|nav|header|footer|form|aside|iframe|template|button|select)\b[^>]*>.*?</\1\s*>",
        RegexOptions.IgnoreCase | RegexOptions.Singleline | RegexOptions.CultureInvariant)]
    private static partial Regex DeadWeight();

    [GeneratedRegex(@"<!--.*?-->", RegexOptions.Singleline | RegexOptions.CultureInvariant)]
    private static partial Regex Comment();

    /// <summary>
    /// Tags that end a visual line. Both the opening and closing forms, because a page may use
    /// either as the boundary and the parser only needs the break to land somewhere sensible.
    /// </summary>
    [GeneratedRegex(
        @"<\s*/?\s*(br|p|div|li|ul|ol|tr|td|th|h[1-6]|section|article|figcaption|blockquote|dt|dd|hr)\b[^>]*>",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex LineBreaking();

    [GeneratedRegex("<[^>]+>", RegexOptions.CultureInvariant)]
    private static partial Regex HtmlTag();

    [GeneratedRegex(@"[ \t]+", RegexOptions.CultureInvariant)]
    private static partial Regex Spaces();

    [GeneratedRegex(@"\s+([.,;:!?)\]])", RegexOptions.CultureInvariant)]
    private static partial Regex BeforePunctuation();
}
