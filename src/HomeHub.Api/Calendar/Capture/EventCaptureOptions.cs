namespace HomeHub.Api.Calendar.Capture;

/// <summary>
/// Credentials and model for reading engagements off photographs (<c>EventCapture:*</c>).
/// </summary>
/// <remarks>
/// <para>
/// <b>Its own section, not <see cref="Ai.AiOptions"/>.</b> The obvious shortcut is to reuse the
/// OpenAI key already in <c>Ai:</c>, and it is the wrong one twice over. That key is documented as a
/// <i>speech</i> credential that never reaches the agent path, and every other model decision in
/// this app belongs to Hermes rather than to HomeHub. Reading a flyer is neither: it is HomeHub's
/// own structured call, made with no tools and a fixed schema, and it says so by holding its own
/// configuration. A household that wants photo capture off simply does not set this.
/// </para>
/// <para>
/// <b>This is the one origin that leaves the LAN.</b> Images have no on-LAN path — the local and
/// agent models have no vision — so a photograph handed to this reaches a third party. The panel
/// says so before the send, and <c>PROJECT.md</c> §6's "only deliberate image uploads go out" is the
/// line this stays inside.
/// </para>
/// </remarks>
public sealed class EventCaptureOptions
{
    public const string Section = "EventCapture";

    /// <summary>
    /// Which reader does the work: <c>hermes</c> (the house agent) or <c>openai</c>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Defaults to the house agent, because it costs nothing extra and adds no destination.</b>
    /// Every attached image already reaches that agent on the ordinary chat turn, so reading it there
    /// sends the household's post to one provider rather than two — and to the one they have already
    /// chosen and are already paying for.
    /// </para>
    /// <para>
    /// <c>openai</c> buys one thing: a schema the provider *enforces* rather than merely requests.
    /// Hermes ignores <c>response_format</c> and answers prose, so the agent path asks for JSON in
    /// words and tolerates the wrappings that come back. A household that would rather pay for the
    /// guarantee sets this to <c>openai</c> and supplies <see cref="ApiKey"/>.
    /// </para>
    /// </remarks>
    public string Provider { get; set; } = "hermes";

    /// <summary>Which agent reads, when <see cref="Provider"/> is <c>hermes</c>.</summary>
    /// <remarks>
    /// Named rather than assumed, because a household renames its agents and the roster is theirs.
    /// An agent that is not configured makes the reader unavailable, which the panel treats exactly
    /// as it treats an unset key — it stays quiet rather than blaming the photograph.
    /// </remarks>
    public string Agent { get; set; } = "barnaby";

    /// <summary>Key for the vision endpoint, when <see cref="Provider"/> is <c>openai</c>. Never committed.</summary>
    public string? ApiKey { get; set; }

    /// <summary>Base URL of an OpenAI-compatible chat-completions API.</summary>
    public string BaseUrl { get; set; } = "https://api.openai.com";

    /// <summary>The vision model to ask. Any model that accepts an image part and answers JSON.</summary>
    public string Model { get; set; } = "gpt-4o-mini";

    /// <summary>
    /// How long a reading may take before the panel gives up on it.
    /// </summary>
    /// <remarks>
    /// A person is watching a progress hairline while this runs, so the ceiling is a patience budget
    /// rather than a network one. Failing at thirty seconds and saying so beats a spinner that never
    /// resolves.
    /// </remarks>
    public int TimeoutSeconds { get; set; } = 30;

    /// <summary>
    /// Where kept photographs live. Empty means <c>event-photos/</c> under the content root.
    /// </summary>
    /// <remarks>
    /// Never <c>wwwroot</c>: that directory is the SPA build output and is replaced wholesale on
    /// every deploy, so anything cached there is destroyed by the next publish. Same reasoning, and
    /// the same default shape, as <c>Meals:ImagePath</c>.
    /// </remarks>
    public string? PhotoPath { get; set; }

    /// <summary>Whether the household asked for the house agent rather than a vision vendor.</summary>
    public bool UsesHouseAgent =>
        !string.Equals(Provider, "openai", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// True when a reading can be attempted at all.
    /// </summary>
    /// <remarks>
    /// On the agent path this cannot be answered here — whether the agent is configured is the
    /// Hermes roster's business, and <see cref="HermesEventExtractor.IsAvailable"/> asks it. This
    /// property answers only for the vendor path, where a key is the whole question.
    /// </remarks>
    public bool Configured => !string.IsNullOrWhiteSpace(ApiKey);
}
