namespace HomeHub.Api.Baby;

/// <summary>
/// Maps Huckleberry's calendar events onto domain kinds and display text. Pure functions, kept
/// separate from the provider because they encode a set of upstream formatting quirks that are worth
/// testing directly.
/// </summary>
/// <remarks>
/// Verified against real <c>calendar.{child}_events</c> payloads at Gate H0.3.
/// </remarks>
public static class BabyEventClassifier
{
    /// <summary>
    /// Infers the event kind from its summary.
    /// </summary>
    /// <remarks>
    /// Gate H0.3 corrected a real defect here: nursing sessions are titled <c>"🍼 Feed (R:6m)"</c> —
    /// <b>"Feed", not "Nursing"</b> — and carry the same emoji as <c>"🍼 Bottle (3.5 oz)"</c>. So
    /// <c>bottle</c> must be tested <em>before</em> any <c>feed</c> match, and a bare "feed" means
    /// nursing. The original ordering labelled every nursing session a bottle — invisible in the
    /// daily counts (both are "feeds") but wrong in the history drill-in.
    /// <para>
    /// Classified on the summary only, never the description: a bottle's description reads
    /// "Type: Breast Milk", which would false-match a naive nursing test.
    /// </para>
    /// </remarks>
    public static string ClassifyKind(string summary)
    {
        var s = summary.ToLowerInvariant();
        if (s.Contains("sleep") || s.Contains("nap")) return "sleep";
        if (s.Contains("diaper") || s.Contains("nappy")) return "diaper";
        if (s.Contains("growth") || s.Contains("weight") || s.Contains("height")) return "growth";
        // Observed in real payloads as "🩺 Health (Medication)" — the calendar carries kinds the
        // five sensors never expose, so this list is open-ended by nature.
        if (s.Contains("health") || s.Contains("medication") || s.Contains("temperature")) return "health";
        // Order matters — see remarks.
        if (s.Contains("bottle")) return "bottle";
        if (s.Contains("nurs") || s.Contains("breast") || s.Contains("feed")) return "nursing";
        return "other";
    }

    /// <summary>Kinds that count as a feed for the dashboard's daily tally.</summary>
    public static bool IsFeed(string kind) => kind is "bottle" or "nursing";

    /// <summary>
    /// Strips the leading emoji/pictograph and whitespace, leaving <c>"Bottle (3.5 oz)"</c> from
    /// <c>"🍼 Bottle (3.5 oz)"</c>.
    /// </summary>
    /// <remarks>
    /// The panel renders its own icon from the kind via the sprite, per the design system's austere
    /// typography — passing upstream emoji through to the ledger would fight it. Falls back to the
    /// original text if stripping would leave nothing.
    /// </remarks>
    public static string CleanSummary(string summary)
    {
        var i = 0;
        while (i < summary.Length && !char.IsAsciiLetterOrDigit(summary[i])) i++;
        var trimmed = summary[i..].Trim();
        return trimmed.Length > 0 ? trimmed : summary.Trim();
    }
}
