namespace HomeHub.Api.Calendar.Capture;

/// <summary>
/// Reads engagements off a photograph. Parses and judges; never persists.
/// </summary>
/// <remarks>
/// <para>
/// <b>Its own seam, and deliberately not an assistant turn.</b> The household attaches the photo in
/// a chat and Barnaby offers the event in prose, so the obvious implementation is to let the agent
/// read it. That is exactly what this avoids. A flyer is untrusted text that a model is being asked
/// to read, and the agent holds house tools through the MCP seam — <c>set_climate_setpoint</c>,
/// <c>set_climate_mode</c>, <c>add_todo</c>. Printed words that reach a tool-bearing model are an
/// injection surface, and no prompt wording closes it. This call carries no tools, answers a fixed
/// schema, and cannot write anything; the prose turn is generated *from* its result.
/// </para>
/// <para>
/// It is also the only way to get the confirm sheet what it needs. A turn streams text and nothing
/// else; the sheet is bound to typed drafts with confidence and assumption flags on them.
/// </para>
/// </remarks>
public interface IEventExtractor
{
    /// <summary>Whether a reading can be attempted at all. False means no provider is configured.</summary>
    bool IsAvailable { get; }

    Task<ExtractionResult> ReadAsync(ExtractionRequest request, CancellationToken ct);
}

/// <summary>
/// One photograph, and the day the panel believes it is.
/// </summary>
/// <param name="ImageBase64">The image bytes, base64, without a data-URL prefix.</param>
/// <param name="MediaType">Its media type, e.g. <c>image/jpeg</c>.</param>
/// <param name="LocalToday">
/// The confirming device's own date.
/// <para>
/// Sent by the caller rather than read from the server's clock because it is the anchor for every
/// inference about an unstated year — "Saturday 14 September" is next September or last September
/// depending on what today is, and a flyer photographed on a phone in another timezone can be a day
/// out from the server. There is no household timezone in HomeHub to consult instead.
/// </para>
/// </param>
/// <param name="Context">
/// What the member typed alongside the photo, or null. Read as a hint, never as an instruction — it
/// helps with "the camp one, not the concert" and cannot change what the extractor is allowed to do.
/// </param>
public sealed record ExtractionRequest(NormalizedImage Image, DateOnly LocalToday, string? Context)
{
    public string ImageBase64 => Image.Base64;
    public string MediaType => Image.MediaType;
}

/// <summary>How much of an engagement came off the photograph.</summary>
/// <remarks>
/// The same three words the recipe importer answers with, on purpose: a household that has met
/// "partial, and here is what is missing" once should not have to learn a second vocabulary for the
/// same idea. Defined here rather than shared with <c>Meals</c> because the two say the same thing
/// about different things, and a common enum would tie the calendar to the recipe importer for
/// nothing but a name.
/// </remarks>
public enum ExtractionConfidence
{
    /// <summary>Nothing with a date on it. No sheet, and Barnaby says so.</summary>
    Empty,

    /// <summary>An engagement, with something read poorly or filled by rule.</summary>
    Partial,

    /// <summary>Everything the sheet shows was read off the photograph.</summary>
    Complete,
}

/// <summary>
/// What a reading produced.
/// </summary>
/// <param name="Confidence">See <see cref="ExtractionConfidence"/>.</param>
/// <param name="Events">The drafts, in the order they appear on the photograph. Empty when none.</param>
/// <param name="Reason">
/// Why there is nothing, or what is thin about what there is — in the household's words, because it
/// is drawn on a turn. Null when there is nothing to explain.
/// </param>
public sealed record ExtractionResult(
    ExtractionConfidence Confidence,
    IReadOnlyList<DraftEvent> Events,
    string? Reason)
{
    /// <summary>Nothing found, with a sentence saying so.</summary>
    public static ExtractionResult Nothing(string reason) => new(ExtractionConfidence.Empty, [], reason);

    /// <summary>
    /// Whether this is worth interrupting the household with.
    /// </summary>
    /// <remarks>
    /// <b>The gate on the offer, and the whole reason the read is allowed to be automatic.</b> Every
    /// attached image is read, because the only way to find out whether a photo has a date on it is
    /// to look. What must not be automatic is Barnaby speaking about it: a photo of the cat, or of a
    /// rash somebody is asking a question about, pays for one reading and then says nothing at all.
    /// A date and a title together are the bar — a date alone is as likely to be a price as an
    /// engagement.
    /// </remarks>
    public bool OffersAnEvent => Events.Any(e => e.Title.Length > 0);
}

/// <summary>
/// One engagement as read, before anybody has confirmed it.
/// </summary>
/// <remarks>
/// <para>
/// <b>Dates without zones.</b> <see cref="Date"/>, <see cref="Begins"/> and <see cref="Ends"/> are
/// calendar values, not instants: the sheet resolves them to UTC when the household confirms,
/// because the confirming device is the only thing in the system that knows a timezone. Handing a
/// <c>DateTime</c> out of here would force the server to guess one.
/// </para>
/// <para>
/// <b>No calendar, no ids, no schedule.</b> Nothing here says which calendar the event belongs on or
/// what else is already there. The extractor never learns either, so a flyer cannot influence them.
/// </para>
/// </remarks>
/// <param name="Id">Stable within one reading, so the sheet can tick and untick rows.</param>
/// <param name="Title">What the engagement is. Empty when the photograph named no event.</param>
/// <param name="Date">The day it falls on.</param>
/// <param name="AllDay">
/// Whole days rather than an hour of one. <b>True whenever the photograph gave a date and no hour</b>
/// — most school and deadline flyers — because the alternative is inventing a time, and an invented
/// 9 AM is indistinguishable from a read one.
/// </param>
/// <param name="Begins">Start time, or null when <see cref="AllDay"/>.</param>
/// <param name="Ends">Finish, or null when <see cref="AllDay"/>.</param>
/// <param name="Where">Where it is, or null when the photograph did not say.</param>
/// <param name="Note">Anything else worth keeping — cost, what to bring, a contact.</param>
/// <param name="LowConfidence">
/// Field names that were read badly — a fold through the line, glare, small print. Drives the amber
/// underline on the sheet.
/// </param>
/// <param name="Assumed">
/// Field names that were not on the photograph at all and were filled by rule: <c>year</c> when the
/// flyer printed a day and a month, <c>ends</c> when it printed a start and no finish. Same amber,
/// different sentence underneath.
/// </param>
public sealed record DraftEvent(
    string Id,
    string Title,
    DateOnly Date,
    bool AllDay,
    TimeOnly? Begins,
    TimeOnly? Ends,
    string? Where,
    string? Note,
    IReadOnlyList<string> LowConfidence,
    IReadOnlyList<string> Assumed);
