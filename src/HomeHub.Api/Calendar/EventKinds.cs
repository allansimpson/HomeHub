namespace HomeHub.Api.Calendar;

using System.Text.RegularExpressions;

/// <summary>
/// What a calendar event <i>is</i>, so a day can carry an icon rather than only a count.
/// </summary>
/// <remarks>
/// Every kind here maps to a signal that actually exists — Google's own <c>eventType</c>, a calendar
/// whose id identifies it, or a title that says so outright. Nothing is guessed from duration, time
/// of day or attendee count; a wrong cake on a funeral is worse than no cake at all.
///
/// <para>The household's own mapping of calendar → icon is a <i>separate</i> axis, stored per synced
/// calendar. This is the per-event axis, and it wins where the two disagree: a birthday on the Work
/// calendar is still a birthday.</para>
/// </remarks>
public static partial class EventKinds
{
    /// <summary>Nothing identifiable — the great majority of events.</summary>
    public const string Default = "default";

    /// <summary>A birthday, per Google or per a title that says so.</summary>
    public const string Birthday = "birthday";

    /// <summary>A wedding/other anniversary. Google models these alongside birthdays.</summary>
    public const string Anniversary = "anniversary";

    /// <summary>From a holiday calendar Google publishes (per-region, read-only).</summary>
    public const string Holiday = "holiday";

    /// <summary>Google's own out-of-office block.</summary>
    public const string OutOfOffice = "out-of-office";

    /// <summary>Google's own focus-time block.</summary>
    public const string FocusTime = "focus-time";

    /// <summary>Google's own working-location marker (home / office / somewhere else).</summary>
    public const string WorkingLocation = "working-location";

    /// <summary>Auto-created by Google from a Gmail message — a flight, a hotel, a delivery.</summary>
    public const string FromGmail = "from-gmail";

    /// <summary>Every kind the API can emit, for the client's exhaustiveness check.</summary>
    public static readonly IReadOnlyList<string> All =
    [
        Default, Birthday, Anniversary, Holiday, OutOfOffice, FocusTime, WorkingLocation, FromGmail,
    ];

    /// <summary>
    /// Google's synthesized holiday calendars all end this way, e.g.
    /// <c>en.usa#holiday@group.v.calendar.google.com</c>.
    /// </summary>
    private const string HolidayCalendarSuffix = "#holiday@group.v.calendar.google.com";

    /// <summary>
    /// Contact birthdays live on this calendar. Kept for identification only — Google does not serve
    /// its events through the Calendar API, so nothing from it ever reaches the panel.
    /// </summary>
    public const string ContactsBirthdayCalendarId = "addressbook#contacts@group.v.calendar.google.com";

    /// <summary>
    /// "Dave's Birthday", "Birthday: Dave", "Dave's 40th birthday" — but not "Birthday party planning"
    /// or "Buy birthday card", which are tasks *about* a birthday rather than the day itself.
    /// </summary>
    [GeneratedRegex(@"\bbirthdays?\b", RegexOptions.IgnoreCase)]
    private static partial Regex BirthdayWord();

    [GeneratedRegex(@"\banniversar(y|ies)\b", RegexOptions.IgnoreCase)]
    private static partial Regex AnniversaryWord();

    /// <summary>
    /// A title mentioning a birthday while being about arranging one. Errs towards <i>not</i>
    /// classifying: an unmarked birthday reads as an ordinary event, while a marked errand reads as a
    /// birthday that is not happening.
    /// </summary>
    [GeneratedRegex(@"\b(party|card|gift|present|shopping|plan|planning|cake|dinner|lunch|invite|invitation|rsvp)\b",
        RegexOptions.IgnoreCase)]
    private static partial Regex AboutRatherThanIs();

    /// <summary>
    /// Classify an event. <paramref name="googleEventType"/> is Google's own word for it and is
    /// believed outright; the title is consulted only when Google offered nothing.
    /// </summary>
    /// <remarks>
    /// Precedence — Google's <c>eventType</c>, then the calendar's identity, then the title. The order
    /// runs from stated to inferred, so a better signal is never overruled by a worse one.
    /// </remarks>
    public static string Classify(string? googleEventType, string? googleCalendarId, string? title)
    {
        // 1. Google said so.
        var stated = googleEventType switch
        {
            "birthday" => Birthday,
            "outOfOffice" => OutOfOffice,
            "focusTime" => FocusTime,
            "workingLocation" => WorkingLocation,
            "fromGmail" => FromGmail,
            _ => null,
        };
        if (stated is not null) return stated;

        // 2. The calendar it lives on identifies it.
        if (googleCalendarId is not null && googleCalendarId.EndsWith(HolidayCalendarSuffix, StringComparison.OrdinalIgnoreCase))
            return Holiday;

        // 3. The title says so — the only signal that catches a birthday typed by hand onto an
        //    ordinary calendar, which is how most households actually record them.
        if (!string.IsNullOrWhiteSpace(title) && !AboutRatherThanIs().IsMatch(title))
        {
            if (BirthdayWord().IsMatch(title)) return Birthday;
            if (AnniversaryWord().IsMatch(title)) return Anniversary;
        }

        return Default;
    }

    /// <summary>
    /// Google's <c>birthdayProperties.type</c> refines a birthday event into what it really marks.
    /// Applied after <see cref="Classify"/>, since only Google can tell these apart.
    /// </summary>
    public static string Refine(string kind, string? birthdayType) =>
        kind == Birthday && birthdayType is "anniversary" ? Anniversary : kind;
}
