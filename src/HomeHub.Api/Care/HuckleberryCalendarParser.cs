namespace HomeHub.Api.Care;

using System.Globalization;
using System.Text.RegularExpressions;

/// <summary>
/// Turns one Huckleberry calendar event into a <see cref="CareEntry"/>, or refuses to.
/// </summary>
/// <remarks>
/// <para>
/// <b>The only route back into the household's own history.</b> Huckleberry's HA integration offers
/// no export and no structured history — the sensors report the *last* of each kind and nothing
/// before it. What it does publish is a calendar entity, and every entry the household has made
/// appears there as a summary and a description. That text is the migration path.
/// </para>
/// <para>
/// <b>Parsing a vendor's prose is lossy, so this is built to under-claim.</b> Every field it cannot
/// read with certainty is left null rather than guessed, and the original summary and description
/// are kept on the entry as <see cref="CareEntry.Notes"/> — so a line this parser reads badly today
/// can be re-read by a better one later without another trip upstream. The formats below were taken
/// from 426 real events over thirty days, not from documentation.
/// </para>
/// <para>
/// It deliberately does not invent a type. An event it cannot classify returns null and is counted
/// as skipped, because a mystery row in a child's medical log is worse than a gap somebody can see.
/// </para>
/// </remarks>
public static class HuckleberryCalendarParser
{
    /// <summary>`Bottle feeding: 3.75 oz` — the amount and its unit.</summary>
    private static readonly Regex BottleAmount =
        new(@"(?<amount>\d+(?:\.\d+)?)\s*(?<unit>oz|ml)\b", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>`Type: Breast Milk` — display form, folded back to the enum spelling.</summary>
    private static readonly Regex BottleType =
        new(@"Type:\s*(?<type>[^\r\n]+)", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>`Total: 7 min 22 sec`, and the per-side lines under it.</summary>
    private static readonly Regex Duration =
        new(@"(?<min>\d+)\s*min(?:\s*(?<sec>\d+)\s*sec)?", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>`Sleep duration: 56m` — the compact form sleep uses.</summary>
    private static readonly Regex CompactMinutes =
        new(@"(?<min>\d+)\s*m\b", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly Regex Color =
        new(@"Color:\s*(?<v>\w+)", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly Regex Consistency =
        new(@"Consistency:\s*(?<v>\w+)", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>
    /// One event, as a row — or null when it is not something this log keeps.
    /// </summary>
    /// <param name="summary">The calendar summary, e.g. <c>🍼 Bottle (3.75 oz)</c>.</param>
    /// <param name="description">The body, e.g. <c>Bottle feeding: 3.75 oz\nType: Breast Milk</c>.</param>
    /// <param name="startUtc">When it happened. Millisecond precision, and the dedupe key leans on it.</param>
    /// <param name="endUtc">Set only for sessions with a span; equal to start for point-in-time logs.</param>
    public static CareEntry? Parse(string? summary, string? description, DateTime startUtc, DateTime? endUtc, string childKey)
    {
        var text = $"{summary}\n{description}".Trim();
        if (text.Length == 0) return null;

        var type = Classify(summary, description);
        if (type is not { } known) return null;

        var entry = new CareEntry
        {
            ChildKey = childKey,
            Type = known,
            AtUtc = startUtc,
            CreatedUtc = DateTime.UtcNow,
            Source = CareEntrySource.HuckleberryImport,
            ExternalKey = KeyFor(childKey, known, startUtc),
            // Kept verbatim. A line this parser reads badly today can be re-read by a better one
            // later without another trip upstream — and for medicine, which the calendar records
            // with no name and no dose, this is the only detail there is.
            Notes = Clip(text, 500),
        };

        switch (known)
        {
            case CareEntryType.Bottle:
                if (BottleAmount.Match(text) is { Success: true } amount)
                {
                    entry.Amount = double.Parse(amount.Groups["amount"].Value, CultureInfo.InvariantCulture);
                    entry.Unit = amount.Groups["unit"].Value.ToLowerInvariant();
                }
                if (BottleType.Match(description ?? "") is { Success: true } kind)
                    entry.Kind = ToEnumSpelling(kind.Groups["type"].Value);
                break;

            case CareEntryType.Nursing:
                entry.DurationMinutes = ReadDuration(description) ?? Span(startUtc, endUtc);
                entry.Side = ReadSide(summary, description);
                break;

            case CareEntryType.Sleep:
                entry.DurationMinutes = ReadDuration(description) ?? Span(startUtc, endUtc);
                break;

            case CareEntryType.Diaper:
                entry.Kind = ReadDiaperKind(summary, description);
                if (Color.Match(description ?? "") is { Success: true } colour)
                    entry.Color = colour.Groups["v"].Value.ToLowerInvariant();
                if (Consistency.Match(description ?? "") is { Success: true } consistency)
                    entry.Consistency = consistency.Groups["v"].Value.ToLowerInvariant();
                break;

            case CareEntryType.Medicine:
                // The calendar says only "Health entry: medication" — no name, no dose, no unit.
                // Imported as a timestamped fact, with the raw line in Notes, because *that a dose
                // was given at 9:40* is the part that matters clinically and inventing a name would
                // be worse than leaving it blank.
                break;
        }

        return entry;
    }

    /// <summary>
    /// The dedupe key, synthesised because Huckleberry supplies none.
    /// </summary>
    /// <remarks>
    /// Its calendar events carry a <c>uid</c> field and it is null on every one, so this stands in:
    /// child, type and the instant, which the feed gives to the millisecond. Round-tripped through
    /// a fixed format so the same event always produces the same key regardless of the machine's
    /// culture or the kind of <c>DateTime</c> it arrived as.
    /// </remarks>
    internal static string KeyFor(string childKey, CareEntryType type, DateTime startUtc) =>
        $"hb:{childKey}:{type}:{startUtc.ToUniversalTime():yyyyMMddTHHmmss.fff}";

    /// <summary>
    /// Which of the ten this is, read from the vendor's own wording.
    /// </summary>
    /// <remarks>
    /// <b>Order matters, and it bit before.</b> Nursing sessions are titled <c>🍼 Feed (L:7m)</c> —
    /// "Feed", not "Nursing" — and carry the same bottle emoji as <c>🍼 Bottle (3.5 oz)</c>, so
    /// bottle must be tested first or every bottle imports as a nursing session. A bottle's
    /// description also says <c>Type: Breast Milk</c>, which false-matches a naive "breast" test.
    /// This mirrors <c>BabyEventClassifier</c>, which learned the same lesson against the same feed.
    /// </remarks>
    internal static CareEntryType? Classify(string? summary, string? description)
    {
        var s = $"{summary} {description}".ToLowerInvariant();
        if (s.Length == 0) return null;

        if (s.Contains("diaper", StringComparison.Ordinal) || s.Contains("nappy", StringComparison.Ordinal))
            return CareEntryType.Diaper;
        if (s.Contains("sleep", StringComparison.Ordinal) || s.Contains("nap", StringComparison.Ordinal))
            return CareEntryType.Sleep;
        if (s.Contains("growth", StringComparison.Ordinal) || s.Contains("weight", StringComparison.Ordinal))
            return CareEntryType.Growth;
        if (s.Contains("medication", StringComparison.Ordinal) || s.Contains("medicine", StringComparison.Ordinal))
            return CareEntryType.Medicine;
        if (s.Contains("temperature", StringComparison.Ordinal)) return CareEntryType.Temperature;
        // Before any feed test — see the remarks.
        if (s.Contains("bottle", StringComparison.Ordinal)) return CareEntryType.Bottle;
        if (s.Contains("nurs", StringComparison.Ordinal) || s.Contains("feed", StringComparison.Ordinal))
            return CareEntryType.Nursing;

        // Anything else — a "🩺 Health" entry that is not medication, a type the household logs in an
        // app HomeHub has never seen. Skipped and counted, never guessed at.
        return null;
    }

    /// <summary>`Total: 7 min 22 sec` as decimal minutes, or null.</summary>
    private static double? ReadDuration(string? description)
    {
        if (string.IsNullOrWhiteSpace(description)) return null;

        var match = Duration.Match(description);
        if (match.Success)
        {
            var minutes = double.Parse(match.Groups["min"].Value, CultureInfo.InvariantCulture);
            if (match.Groups["sec"].Success)
                minutes += double.Parse(match.Groups["sec"].Value, CultureInfo.InvariantCulture) / 60d;
            return Math.Round(minutes, 2);
        }

        var compact = CompactMinutes.Match(description);
        return compact.Success ? double.Parse(compact.Groups["min"].Value, CultureInfo.InvariantCulture) : null;
    }

    /// <summary>The span between start and end, when the description gave no duration.</summary>
    /// <remarks>
    /// A fallback, not the first choice: a point-in-time log arrives with end equal to start, which
    /// would record a zero-minute session rather than an unmeasured one.
    /// </remarks>
    private static double? Span(DateTime startUtc, DateTime? endUtc)
    {
        if (endUtc is not { } end || end <= startUtc) return null;
        return Math.Round((end - startUtc).TotalMinutes, 2);
    }

    /// <summary>`(L:7m)` in the summary, or a `Left:` line in the body.</summary>
    private static string? ReadSide(string? summary, string? description)
    {
        var s = summary ?? "";
        if (Regex.IsMatch(s, @"\(\s*L\s*:", RegexOptions.IgnoreCase)) return "left";
        if (Regex.IsMatch(s, @"\(\s*R\s*:", RegexOptions.IgnoreCase)) return "right";

        var d = description ?? "";
        var left = d.Contains("Left:", StringComparison.OrdinalIgnoreCase);
        var right = d.Contains("Right:", StringComparison.OrdinalIgnoreCase);
        return (left, right) switch
        {
            (true, true) => "both",
            (true, false) => "left",
            (false, true) => "right",
            _ => null,
        };
    }

    /// <summary>`pee`, `poo`, `both`, `dry` — the API's own four, matched against the vendor's text.</summary>
    private static string? ReadDiaperKind(string? summary, string? description)
    {
        var s = $"{summary} {description}".ToLowerInvariant();
        // `both` first: its description reads "Diaper change: both" and its summary carries both
        // emoji, so testing pee or poo first would claim it.
        if (s.Contains("both", StringComparison.Ordinal)) return "both";
        if (s.Contains("dry", StringComparison.Ordinal)) return "dry";
        if (s.Contains("poo", StringComparison.Ordinal)) return "poo";
        if (s.Contains("pee", StringComparison.Ordinal)) return "pee";
        return null;
    }

    /// <summary>`Breast Milk` → `breast_milk`, the spelling the rest of HomeHub already stores.</summary>
    private static string ToEnumSpelling(string display) =>
        display.Trim().ToLowerInvariant().Replace(' ', '_');

    private static string? Clip(string? value, int max)
    {
        var text = value?.Trim();
        if (string.IsNullOrEmpty(text)) return null;
        return text.Length > max ? text[..max] : text;
    }
}
