namespace HomeHub.Api.Calendar.Capture;

using System.Globalization;
using System.Text;

/// <summary>
/// What a photograph did not say, decided by rule rather than by the model.
/// </summary>
/// <remarks>
/// <para>
/// <b>The inferences live here, out of the prompt.</b> A flyer prints "Saturday 14 September" and
/// leaves the year to the reader; it prints a start and leaves the finish to common sense. Something
/// has to fill those in, and it must not be the model — an inference made inside a generation is
/// invisible, unrepeatable and impossible to test, and this is precisely the class of guess that
/// produces an event on the right day of the wrong year. Made here, each one is a line of code with
/// a test on it, and each one is *reported*: every field filled by rule arrives on the sheet under
/// an amber underline rather than as a fact.
/// </para>
/// <para>
/// The one inference deliberately not made is a time. A flyer with a date and no hour is an all-day
/// engagement, which is what most school and deadline flyers are — inventing 9 AM would produce a
/// value nobody could tell from a read one.
/// </para>
/// </remarks>
internal static class DraftEventRules
{
    /// <summary>Column widths, so a long read is trimmed here rather than 500-ing at the write.</summary>
    private const int MaxTitle = 200;
    private const int MaxWhere = 300;
    private const int MaxNote = 2000;

    /// <summary>Field names the sheet knows how to underline. Anything else is dropped.</summary>
    private static readonly string[] KnownFields = ["title", "date", "begins", "ends", "where"];

    /// <summary>
    /// A whole reading, normalised and judged.
    /// </summary>
    /// <remarks>
    /// Shared by every implementation of <see cref="IEventExtractor"/> so the verdict cannot drift
    /// between them: whether a photograph produced a complete engagement is a question about the
    /// drafts, not about which provider read it.
    /// </remarks>
    public static ExtractionResult Assemble(IEnumerable<RawDraft> raw, DateOnly today)
    {
        var drafts = raw
            .Select((r, i) => Normalize(r, today, i))
            .OfType<DraftEvent>()
            .ToList();

        if (drafts.Count == 0)
            return ExtractionResult.Nothing("I can't find a date or a time on that one.");

        // "Partial" is anything the household should look at twice: a gap the rules filled, a line
        // the reading struggled with, or an engagement with no name on it.
        var thin = drafts.Any(d => d.Assumed.Count > 0 || d.LowConfidence.Count > 0 || d.Title.Length == 0);
        return new ExtractionResult(
            thin ? ExtractionConfidence.Partial : ExtractionConfidence.Complete,
            drafts,
            null);
    }

    /// <summary>
    /// One raw reading, normalised — or null when there is no engagement in it.
    /// </summary>
    /// <remarks>
    /// A date is the one thing that cannot be inferred from anything else, so a reading without one
    /// is not a thin engagement, it is not an engagement. A title *can* be missing: the sheet shows
    /// the gap and the offer stays silent (see <see cref="ExtractionResult.OffersAnEvent"/>).
    /// </remarks>
    public static DraftEvent? Normalize(RawDraft raw, DateOnly today, int index)
    {
        if (raw.Month is not { } month || raw.Day is not { } day) return null;
        if (month is < 1 or > 12 || day is < 1 or > 31) return null;

        var assumed = new List<string>();
        var date = ResolveDate(raw.Year, month, day, today, assumed);
        if (date is not { } on) return null;

        var begins = ParseTime(raw.Begins);
        var ends = ParseTime(raw.Ends);

        // No hour on the photograph is a statement, not a gap: this is an all-day engagement.
        var allDay = begins is null;
        if (allDay) ends = null;
        else if (ends is null && begins is { } from)
        {
            ends = DefaultEnd(from);
            assumed.Add("ends");
        }

        // A finish before the start is a misread rather than an overnight event — a flyer that means
        // "9 PM to 1 AM" is rare, and silently writing a negative-length engagement is worse than
        // proposing an hour and marking it.
        if (!allDay && begins is { } b && ends is { } e && e <= b)
        {
            ends = DefaultEnd(b);
            if (!assumed.Contains("ends")) assumed.Add("ends");
        }

        return new DraftEvent(
            Id: index.ToString(CultureInfo.InvariantCulture),
            Title: Clean(raw.Title, MaxTitle) ?? "",
            Date: on,
            AllDay: allDay,
            Begins: begins,
            Ends: ends,
            Where: Clean(raw.Where, MaxWhere),
            // The one field that keeps its line breaks — see `Clean`.
            Note: Clean(raw.Note, MaxNote, allowNewlines: true),
            LowConfidence: Known(raw.LowConfidence),
            Assumed: assumed);
    }

    /// <summary>
    /// The year a flyer did not print: the nearest occurrence that has not already gone.
    /// </summary>
    /// <remarks>
    /// <b>Forward, not nearest in either direction.</b> A flyer is an invitation to something that
    /// has not happened yet, so a December photograph naming "7 January" means the January five weeks
    /// away and never the one eleven months behind. Today itself counts as future — a flyer read on
    /// the morning of the event is the ordinary case, not a stale one.
    /// <para>
    /// 29 February is the one date this can fail on: it exists in the stated year or it does not, and
    /// rolling it to the 28th or to the 1st would both be inventions. It is dropped instead.
    /// </para>
    /// </remarks>
    private static DateOnly? ResolveDate(int? year, int month, int day, DateOnly today, List<string> assumed)
    {
        if (year is { } stated)
            return Build(stated, month, day);

        assumed.Add("year");
        var thisYear = Build(today.Year, month, day);
        if (thisYear is { } candidate && candidate >= today) return candidate;
        return Build(today.Year + 1, month, day);
    }

    private static DateOnly? Build(int year, int month, int day)
    {
        if (year is < 1 or > 9999) return null;
        if (day > DateTime.DaysInMonth(year, month)) return null;
        return new DateOnly(year, month, day);
    }

    /// <summary>
    /// An hour after the start, which is what a household means by "and then it finished".
    /// </summary>
    /// <remarks>
    /// Clamped to the end of the day rather than wrapping: an engagement that begins at 23:30 and
    /// runs to 00:30 belongs to two dates, and a draft carries one. The sheet's steppers are right
    /// there for the rare evening that really does cross midnight.
    /// </remarks>
    private static TimeOnly DefaultEnd(TimeOnly begins) =>
        begins.Hour >= 23 ? new TimeOnly(23, 59) : begins.AddHours(1);

    /// <summary>
    /// A printed time, in the shapes a flyer prints them.
    /// </summary>
    /// <remarks>
    /// Invariant culture and an explicit format list, because the panel's culture is not the flyer's
    /// and "7.30" parsing as a number on one machine and a time on another is the kind of difference
    /// that only shows up in somebody's house.
    /// </remarks>
    internal static TimeOnly? ParseTime(string? raw)
    {
        var text = raw?.Trim();
        if (string.IsNullOrEmpty(text)) return null;

        string[] formats =
        [
            "H:mm", "HH:mm", "h:mm tt", "hh:mm tt", "h:mmtt", "hh:mmtt",
            // "%H" rather than "H": a single-character format string is read as a *standard*
            // specifier, and there is no standard "H", so the bare form throws rather than failing
            // to match — which turned "tea time" into an exception instead of a null.
            "h tt", "hh tt", "htt", "hhtt", "%H", "HH",
        ];

        // Flyers write "7:30PM", "7.30 pm" and "19:30"; normalising the separator and the meridiem's
        // spacing here keeps the format list short enough to read.
        var normalized = text.Replace(".", ":", StringComparison.Ordinal).ToUpperInvariant();
        return TimeOnly.TryParseExact(normalized, formats, CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed)
            ? parsed
            : null;
    }

    /// <summary>
    /// Free text off a photograph, made safe to store, draw and hand onwards.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Every implementation of <see cref="IEventExtractor"/> funnels through here</b>, which is why
    /// the cleaning lives in the rules rather than in a provider. A title read by the house agent and
    /// a title read by a vision API are equally untrusted: both are words somebody else printed on a
    /// piece of paper, and neither has been seen by a person at the point this runs.
    /// </para>
    /// <para>
    /// <b>What this can and cannot do.</b> It removes the tricks that work on *machines* — the
    /// invisible and direction-flipping characters that make a string render as something other than
    /// what it contains, and the control characters that break the rows, logs and CSV-ish places a
    /// title ends up in. It does <i>not</i> and cannot neutralise a sentence that simply asks a model
    /// to do something; no character filter can, and pretending otherwise would be the more dangerous
    /// error. That risk is answered structurally instead: the reading has no tools, and nothing
    /// reaches the calendar without a person confirming it on the sheet.
    /// </para>
    /// <para>
    /// <b>The vector worth naming</b> is second-order. A title lands on the calendar, and the agent
    /// reads the calendar back through <c>get_calendar</c> — so a flyer's words can reach a
    /// tool-bearing model later, by a route nobody is watching at the time. Stripping bidi overrides
    /// matters there: a title that displays as "Book club" on the confirm sheet while containing
    /// something else entirely is the one case where a person's confirmation is not informed consent.
    /// </para>
    /// </remarks>
    /// <param name="allowNewlines">
    /// Notes keep their line breaks — a flyer's "bring a packed lunch / cost $5" is two lines and
    /// reads as one run-on sentence without them. Titles and places are collapsed to a single line,
    /// because a newline in a calendar row is a rendering bug wherever that row is drawn.
    /// </param>
    internal static string? Clean(string? value, int max, bool allowNewlines = false)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;

        // NFC first: the same character can arrive decomposed, and comparing or truncating a
        // half-composed sequence is how a trailing accent ends up orphaned.
        var text = value.Normalize(NormalizationForm.FormC);

        var clean = new StringBuilder(text.Length);
        var lastWasSpace = false;

        // A separator becomes one ordinary space, never nothing. Deleting a tab outright ran the
        // words either side of it together — "Camp<tab>Open House" arrived as "CampOpen House" — and
        // a title that has silently lost a word boundary is worse than one with odd spacing, because
        // nothing about it looks wrong.
        void Separate()
        {
            if (lastWasSpace || clean.Length == 0) return;
            clean.Append(' ');
            lastWasSpace = true;
        }

        foreach (var ch in text)
        {
            if (Invisible(ch)) continue;

            if (ch is '\n' or '\r')
            {
                if (!allowNewlines) { Separate(); continue; }
                if (ch == '\r') continue;
                // Collapse a run of blank lines; a flyer read badly can produce dozens.
                if (clean.Length > 0 && clean[^1] != '\n') clean.Append('\n');
                lastWasSpace = true;
                continue;
            }

            // Non-printing and *not* a separator — NUL, BEL and friends. They have no business in a
            // title and every business breaking a log line.
            if (char.IsControl(ch) && !char.IsWhiteSpace(ch)) continue;

            // Tabs, form feeds, and the non-breaking and exotic spaces a copy-paste drags in.
            if (char.IsWhiteSpace(ch)) { Separate(); continue; }

            lastWasSpace = false;
            clean.Append(ch);
        }

        var result = clean.ToString().Trim();
        if (result.Length == 0) return null;
        return result.Length > max ? result[..max].TrimEnd() : result;
    }

    /// <summary>
    /// Characters that occupy no space, or reverse the order of what follows them.
    /// </summary>
    /// <remarks>
    /// The Trojan-Source family. A right-to-left override inside a title makes the rendered string and
    /// the stored string two different sentences, which defeats the confirm sheet's entire purpose —
    /// somebody approves what they can see. Zero-width characters do the quieter version of the same
    /// job, and also let two titles that look identical compare as different.
    /// </remarks>
    private static bool Invisible(char ch) => ch switch
    {
        '­' => true,                       // soft hyphen
        '﻿' => true,                       // zero-width no-break space (BOM)
        >= '​' and <= '‏' => true,    // zero-width space/joiners, LRM/RLM
        >= '‪' and <= '‮' => true,    // embedding and override
        >= '⁠' and <= '⁤' => true,    // word joiner, invisible operators
        >= '⁦' and <= '⁩' => true,    // isolates
        _ => false,
    };

    private static IReadOnlyList<string> Known(IReadOnlyList<string>? fields) =>
        fields is null
            ? []
            : fields
                .Select(f => f?.Trim().ToLowerInvariant() ?? "")
                .Where(f => KnownFields.Contains(f))
                .Distinct(StringComparer.Ordinal)
                .ToList();
}

/// <summary>
/// One engagement exactly as the reading reported it, before any rule has been applied.
/// </summary>
/// <remarks>
/// Deliberately loose — every field optional, times as printed text, the year separate from the day
/// and month. A model that must answer in normalised form has to make the inferences itself, out of
/// sight; keeping the raw shape means a flyer that printed no year produces a null here and an entry
/// in <see cref="DraftEvent.Assumed"/> there.
/// </remarks>
/// <param name="LowConfidence">Field names the reading is unsure of; unknown names are discarded.</param>
internal sealed record RawDraft(
    string? Title,
    int? Year,
    int? Month,
    int? Day,
    string? Begins,
    string? Ends,
    string? Where,
    string? Note,
    IReadOnlyList<string>? LowConfidence);
