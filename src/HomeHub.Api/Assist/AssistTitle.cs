namespace HomeHub.Api.Assist;

/// <summary>
/// Turns an opening turn into a conversation title.
/// </summary>
/// <remarks>
/// One rule, shared by the row HomeHub shows and the title given to the Hermes session, so the two
/// systems name the same conversation the same way when somebody looks at Hermes directly.
/// <para>
/// This is the <b>provisional</b> title — the one the row can carry the instant the chat exists,
/// before anything has had time to think about it. <see cref="ConversationTitler"/> replaces it with
/// a few words that summarise the conversation once the first turn has been answered, and only ever
/// where this rule's output is still in place (see there for why the comparison matters).
/// </para>
/// </remarks>
public static class AssistTitle
{
    public const int MaxLength = AssistFieldLimits.Title;

    /// <summary>A generated title longer than this is not a title, whatever it claims to be.</summary>
    /// <remarks>
    /// The row is one line with an ellipsis at roughly this width, so a model that answered with a
    /// sentence has not done the thing that was asked and its output is discarded rather than cut
    /// down — half a sentence reads worse than the prompt it was meant to improve on.
    /// </remarks>
    public const int MaxGeneratedLength = 60;

    /// <summary>First line of the opening turn, whitespace collapsed, trimmed to fit.</summary>
    public static string From(string? prompt)
    {
        var t = (prompt ?? "").Replace('\r', ' ').Replace('\n', ' ').Trim();
        while (t.Contains("  ")) t = t.Replace("  ", " ");
        // Unreachable from a turn — an empty prompt is rejected before a chat is opened — so this is
        // the fallback for an image-only turn, which has words for nobody to name it with.
        if (t.Length == 0) return "New chat";
        return t.Length <= MaxLength ? t : t[..MaxLength];
    }

    /// <summary>
    /// Make a model's answer usable as a title, or decide it is not one.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Everything here is defence against the ways an instruction to "reply with the title only" gets
    /// answered anyway: a preamble (<c>Title: Bin day</c>), quotation marks around it, a trailing full
    /// stop, a markdown bullet, or several lines of reasoning followed by the answer. The first line
    /// is taken because that is where a model that ignored the instruction still puts the title; the
    /// length ceiling is what rejects the case where it put an essay there instead.
    /// </para>
    /// <para>
    /// Returns null rather than a best effort. A title nobody can vouch for is worse than the opening
    /// turn verbatim, which is at least the household's own words.
    /// </para>
    /// </remarks>
    public static string? Clean(string? raw)
    {
        var first = (raw ?? "")
            .Replace('\r', '\n')
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .FirstOrDefault(line => line.Length > 0);
        if (first is null) return null;

        var t = first;

        // A markdown list marker, from a model that answered with "options".
        t = t.TrimStart('-', '*', '•', '#', ' ');

        // "Title:", "Chat title —", and the rest of the family.
        //
        // Matched against a closed list of labels rather than "anything short before a colon", because
        // the punctuation is not the signal: "Boiler: annual service" is a perfectly good title whose
        // subject happens to be six characters long, and a positional rule eats it.
        foreach (var label in Preambles)
        {
            if (!t.StartsWith(label, StringComparison.OrdinalIgnoreCase)) continue;
            var rest = t[label.Length..].TrimStart();
            if (rest.Length == 0 || rest[0] is not (':' or '—' or '–' or '-')) continue;
            t = rest[1..].TrimStart();
            break;
        }

        t = t.Trim().Trim('"', '\'', '`', '“', '”', '‘', '’').Trim();

        // A full stop at the end of a fragment is noise; a question mark is part of the fragment.
        t = t.TrimEnd('.', ',', ';').Trim();

        while (t.Contains("  ")) t = t.Replace("  ", " ");

        if (t.Length == 0 || t.Length > MaxGeneratedLength) return null;
        return t;
    }

    /// <summary>Labels a model puts in front of a title it was told not to put a label in front of.</summary>
    /// <remarks>Longest first, so <c>Conversation title</c> is not half-matched by <c>Title</c>.</remarks>
    private static readonly string[] Preambles =
        ["Conversation title", "Chat title", "Suggested title", "Title", "Heading", "Name"];
}
