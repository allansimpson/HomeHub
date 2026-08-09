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

    /// <summary>Base URL for the transcription call.</summary>
    public string OpenAiBaseUrl { get; set; } = "https://api.openai.com";

    /// <summary>True when cloud STT is available. Local Whisper is the alternative.</summary>
    public bool CloudSpeechConfigured => !string.IsNullOrWhiteSpace(OpenAiApiKey);
}
