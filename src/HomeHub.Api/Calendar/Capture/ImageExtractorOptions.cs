namespace HomeHub.Api.Calendar.Capture;

/// <summary>
/// The private image-extractor listener (<c>ImageExtractor:*</c>).
/// </summary>
/// <remarks>
/// <para>
/// <b>A service dependency, not an agent.</b> This is deliberately not an entry in
/// <c>Hermes:Agents:*</c>: that collection is the household's roster, and everything in it is offered
/// in the Assist switcher. The extractor is a least-privilege vision component with no tools, no
/// memory and one job — Hermes's own guidance is that it must be "an internal HomeHub service
/// dependency, not a third household-facing agent in the UI", and offering it would invite somebody
/// to hold a conversation with a profile built to refuse one.
/// </para>
/// <para>
/// <b>Nothing here reaches the browser.</b> The base URL and credential are server-side only, and no
/// request field may be taken from a client: not the URL, not the profile, and not a model, provider
/// or route — those stay inside the extractor profile, which is what makes its guarantees the
/// profile's to keep rather than ours to assert per call.
/// </para>
/// </remarks>
public sealed class ImageExtractorOptions
{
    public const string Section = "ImageExtractor";

    /// <summary>Loopback address of the listener, e.g. <c>http://127.0.0.1:8644</c>.</summary>
    /// <remarks>
    /// Loopback for the same reason the agent gateways are: the key has no route-level scoping, so
    /// the listener is never exposed to the LAN.
    /// </remarks>
    public string BaseUrl { get; set; } = "";

    /// <summary>The listener's own <c>API_SERVER_KEY</c>. Server-side; never committed, never sent out.</summary>
    /// <remarks>
    /// Unique to this profile. The agent gateways' keys are rejected here and this one is rejected
    /// there, which is what keeps a compromise of one from reaching the other.
    /// </remarks>
    public string? ApiKey { get; set; }

    /// <summary>
    /// How long a reading may take before the panel gives up on it.
    /// </summary>
    /// <remarks>
    /// A patience budget rather than a network one — somebody is watching a progress hairline while
    /// this runs. Failing at thirty seconds and saying so beats a bar that never fills.
    /// </remarks>
    public int TimeoutSeconds { get; set; } = 30;

    /// <summary>
    /// How many readings may be in flight at once.
    /// </summary>
    /// <remarks>
    /// The listener admits a fixed number of concurrent runs, and a reading now runs on every attached
    /// image. Two keeps a batch of photographs from spending the whole admission budget, and the
    /// extractor has its own listener so this no longer competes with the household's chat turns —
    /// only with other readings.
    /// </remarks>
    public int MaxConcurrent { get; set; } = 2;

    /// <summary>
    /// Whether the panel may read photographs at all.
    /// </summary>
    /// <remarks>
    /// <b>Off unless switched on</b>, per the qualification's delivery order: the client and the closed
    /// event mode land behind a disabled flag, the fixture tests run, and only then is it enabled in
    /// DEV. A configured base URL and key are necessary but not sufficient — somebody has to say so.
    /// </remarks>
    public bool Enabled { get; set; }

    /// <summary>True when a reading can be attempted at all.</summary>
    public bool Configured =>
        Enabled && !string.IsNullOrWhiteSpace(BaseUrl) && !string.IsNullOrWhiteSpace(ApiKey);
}

/// <summary>
/// What HomeHub asked the extractor to look for.
/// </summary>
/// <remarks>
/// <b>Chosen by trusted server-side code, never by anything in the image.</b> The mode fixes the
/// prompt, the response shape and the validators, so letting a photograph influence it would let a
/// photograph choose which rules it is judged by. Only <see cref="Event"/> exists today; the rest of
/// the allowlist arrives one at a time, each with its own DTO and acceptance tests.
/// </remarks>
public enum ImageAnalysisMode
{
    /// <summary>Engagements a household would want on a calendar.</summary>
    Event,
}

/// <summary>
/// How a reading ended.
/// </summary>
/// <remarks>
/// <b>The distinctions exist because they are said out loud.</b> A panel that collapses these reports
/// "I can't find a date on that one" for a provider outage, a timeout and a genuinely blank
/// photograph alike — which is a lie in two of the three cases, and the kind that sends somebody off
/// to re-photograph a flyer that was never the problem.
/// </remarks>
public enum ImageExtractionStatus
{
    /// <summary>A validated proposal. The only status that carries one.</summary>
    Success,

    /// <summary>The reading ran and found nothing usable in the image.</summary>
    UnreadableOrInsufficient,

    /// <summary>
    /// The model run failed — <c>finish_reason=error</c>, or Hermes reported a failure.
    /// </summary>
    /// <remarks>
    /// <b>An HTTP 200 is not a successful extraction.</b> The envelope completes while the run inside
    /// it fails, and reading that as empty output blames the photograph for a provider's outage.
    /// </remarks>
    ModelRunFailed,

    /// <summary>The answer was not one JSON object, even after transport recovery.</summary>
    MalformedOutput,

    /// <summary>Well-formed JSON that says something impossible. Still no proposal.</summary>
    SemanticValidationFailed,

    /// <summary>The listener is at its admission limit, or HomeHub is at its own.</summary>
    Busy,

    /// <summary>Not configured, not switched on, or unreachable.</summary>
    Unavailable,

    /// <summary>The patience budget ran out.</summary>
    TimedOut,

    /// <summary>The caller went away.</summary>
    Cancelled,
}

/// <summary>
/// What became of one reading.
/// </summary>
/// <param name="Status">See <see cref="ImageExtractionStatus"/>.</param>
/// <param name="Proposal">The untrusted proposal, and only on <see cref="ImageExtractionStatus.Success"/>.</param>
/// <param name="SessionDeleted">
/// Whether the disposable extractor session was deleted.
/// <para>
/// <b>Carried, not hidden, and never load-bearing.</b> A cleanup failure is a privacy and operations
/// condition to retry and report — it must never turn invalid output into valid output, and it must
/// never trigger a side effect. It is reported so somebody can act on it, not so the caller can
/// decide differently because of it.
/// </para>
/// </param>
/// <param name="Detail">A safe, non-sensitive reason for a failure. Never raw model output.</param>
public sealed record ImageExtractionResult<T>(
    ImageExtractionStatus Status,
    T? Proposal,
    bool SessionDeleted,
    string? Detail = null)
    where T : class
{
    public bool IsSuccess => Status == ImageExtractionStatus.Success && Proposal is not null;
}

/// <summary>
/// Builders for <see cref="ImageExtractionResult{T}"/>.
/// </summary>
/// <remarks>
/// A non-generic home for what would otherwise be a static member on a generic type — the analyser is
/// right that <c>ImageExtractionResult&lt;Foo&gt;.Failed(...)</c> reads as though the type argument
/// mattered to a failure, and it does not.
/// </remarks>
public static class ImageExtraction
{
    public static ImageExtractionResult<T> Failed<T>(ImageExtractionStatus status, bool sessionDeleted, string? detail = null)
        where T : class => new(status, null, sessionDeleted, detail);
}
