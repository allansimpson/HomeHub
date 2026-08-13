namespace HomeHub.Api.Calendar.Capture;

/// <summary>Ceilings for a reading request, matching what the panel will send.</summary>
/// <remarks>
/// The same ten megabytes the chat composer accepts, and for the same reason: it is roughly one
/// modern phone photo at full resolution, which is the thing people actually hand over. The panel
/// reduces anything it can decode first, so this is the ceiling for the formats it cannot — HEIC
/// outside Safari, mostly. Stated here rather than borrowed from <c>Assist</c> so the calendar does
/// not acquire a dependency on the chat's field limits for a number that happens to match.
/// </remarks>
public static class EventCaptureLimits
{
    public const int MaxImageBytes = 10 * 1024 * 1024;

    /// <summary>Longest hint the panel may send alongside a photograph.</summary>
    public const int MaxContextChars = 2_000;
}

/// <summary>
/// A photograph handed to the panel, to be read for engagements.
/// </summary>
/// <param name="ImageBase64">The image bytes, base64, with no data-URL prefix.</param>
/// <param name="MediaType">Its media type. Defaults to JPEG when the device did not say.</param>
/// <param name="LocalDate">
/// The panel's own date as <c>YYYY-MM-DD</c>.
/// <para>
/// Sent by the client because it is the anchor for an unstated year, and the server's idea of today
/// can differ from the confirming device's — there is no household timezone here to reconcile them.
/// A missing or unparseable value falls back to the server's date rather than failing the request:
/// being a few hours out is survivable, and the year is marked as assumed either way.
/// </para>
/// </param>
/// <param name="Context">What the member typed alongside the photo. A hint, never an instruction.</param>
public sealed record ReadPhotoRequest(
    string? ImageBase64,
    string? MediaType,
    string? LocalDate,
    string? Context);

/// <summary>
/// What the reading found, as the panel receives it.
/// </summary>
/// <param name="Confidence"><c>Empty</c>, <c>Partial</c> or <c>Complete</c>.</param>
/// <param name="Events">The drafts. Never null; empty when nothing was found.</param>
/// <param name="Reason">A sentence for the household when there is nothing, else null.</param>
/// <param name="Available">
/// Whether a reading could be attempted at all.
/// <para>
/// Separate from an empty result on purpose. "There is no date on that photograph" and "this panel
/// cannot read photographs" are different facts, and only one of them is about the photograph — the
/// panel stays quiet for the second rather than blaming a picture that may be perfectly clear.
/// </para>
/// </param>
public sealed record ReadPhotoResponse(
    string Confidence,
    IReadOnlyList<DraftEvent> Events,
    string? Reason,
    bool Available)
{
    public static ReadPhotoResponse From(ExtractionResult result, bool available) => new(
        result.Confidence.ToString(),
        result.Events,
        result.Reason,
        available);
}
