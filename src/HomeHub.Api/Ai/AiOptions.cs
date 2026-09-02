namespace HomeHub.Api.Ai;

/// <summary>
/// What remains of the <c>Ai</c> section: **speech credentials only**.
/// </summary>
/// <remarks>
/// <para>
/// This class used to configure HomeHub's own assistant — a cloud model, a local Ollama model, and
/// the hint-scored routing between them. All of that is gone. Model, provider, tier, route,
/// escalation, fallback and locality are Hermes's decisions now, made inside the agent's own profile;
/// HomeHub chooses an agent and nothing else (see <see cref="HermesOptions"/>).
/// </para>
/// <para>
/// <b>Why an OpenAI key survives here.</b> Speech stays HomeHub's — wake word, capture, Whisper,
/// Piper/Chatterbox, barge-in, the voice-state UX — and cloud transcription is one of its two STT
/// backends (<see cref="OpenAISpeechToText"/>). That is a *speech* credential that happens to be
/// OpenAI's, not an assistant model choice, and it never reaches the agent path.
/// </para>
/// <para>
/// Removed, and not to be reintroduced without an explicit decision:
/// <c>Ai:LocalEndpoint</c>, <c>Ai:LocalModel</c>, <c>Ai:Routing</c>, <c>Ai:Agent</c>,
/// <c>Ai:Agents</c>, and the assistant's use of <c>Ai:OpenAiModel</c>.
/// </para>
/// </remarks>
public sealed class AiOptions
{
    public const string Section = "Ai";

    /// <summary>OpenAI key, used **only** for cloud speech-to-text. Server-side; never committed.</summary>
    public string? OpenAiApiKey { get; set; }

    /// <summary>Base URL for the transcription call. Must name an allowed destination — see
    /// <see cref="CloudSpeechEndpoint"/>.</summary>
    public string OpenAiBaseUrl { get; set; } = "https://api.openai.com";

    /// <summary>
    /// Hosts permitted to receive household audio. Empty means the provider's own host.
    /// </summary>
    /// <remarks>
    /// Stating a host here is how a deployment using an OpenAI-compatible endpoint elsewhere says so
    /// deliberately, on a protected configuration value, rather than by editing a URL and having the
    /// destination follow silently.
    /// </remarks>
    public List<string> OpenAiAllowedHosts { get; set; } = [];

    /// <summary>
    /// True when cloud STT is available. Local Whisper is the alternative.
    /// </summary>
    /// <remarks>
    /// <b>A key is no longer the whole condition.</b> It used to be, and that made
    /// <see cref="OpenAISpeechToText"/> available for any base URL at all — including cleartext or a
    /// mistyped host, to which it would then post raw audio and the bearer. A destination that is not
    /// permitted now reads as no cloud engine, so the router skips it and no request is built. That is
    /// the fail-closed half of the check that <see cref="AiOptionsValidator"/> makes loudly at startup.
    /// </remarks>
    public bool CloudSpeechConfigured =>
        !string.IsNullOrWhiteSpace(OpenAiApiKey)
        && CloudSpeechEndpoint.IsPermitted(OpenAiBaseUrl, OpenAiAllowedHosts);
}

/// <summary>
/// Refuses to start a deployment whose cloud speech destination is not one somebody chose.
/// </summary>
/// <remarks>
/// The companion to <see cref="VoiceOptionsValidator"/>, and the division between them is the two
/// questions a cloud transcription asks: <i>may audio leave the LAN</i>, which is the household's
/// consent and lives in <c>Voice:Stt</c>, and <i>where may it go</i>, which is this. Consent to the
/// first was being read as consent to both.
/// <para>
/// Only fires when a key is present — a deployment with no cloud credential has no destination to get
/// wrong, and failing its startup over a default URL it never uses would be noise.
/// </para>
/// </remarks>
public sealed class AiOptionsValidator(bool requiresDeploymentSafeguards)
    : Microsoft.Extensions.Options.IValidateOptions<AiOptions>
{
    public Microsoft.Extensions.Options.ValidateOptionsResult Validate(string? name, AiOptions options)
    {
        if (!requiresDeploymentSafeguards) return Microsoft.Extensions.Options.ValidateOptionsResult.Success;
        if (string.IsNullOrWhiteSpace(options.OpenAiApiKey))
            return Microsoft.Extensions.Options.ValidateOptionsResult.Success;

        return CloudSpeechEndpoint.Refuse(options.OpenAiBaseUrl, options.OpenAiAllowedHosts) is { } refusal
            ? Microsoft.Extensions.Options.ValidateOptionsResult.Fail(refusal)
            : Microsoft.Extensions.Options.ValidateOptionsResult.Success;
    }
}
