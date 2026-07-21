namespace HomeHub.Api.Ai;

/// <summary>
/// Voice configuration, bound from the <c>Voice</c> section. Kept separate from <see cref="AiOptions"/>
/// so speech-to-text can point at a different host than the local LLM and toggle cloud fallback on its
/// own. Cloud STT reuses the assistant's <c>Ai:OpenAiApiKey</c> (see <see cref="OpenAISpeechToText"/>).
/// </summary>
public sealed class VoiceOptions
{
    public const string Section = "Voice";

    public SttOptions Stt { get; set; } = new();

    public sealed class SttOptions
    {
        /// <summary>Base URL of the local faster-whisper sidecar (OpenAI-compatible). Empty = local STT off.</summary>
        public string? LocalEndpoint { get; set; }

        /// <summary>Whisper model the sidecar loads (e.g. <c>tiny.en</c> / <c>base.en</c> / <c>small.en</c>).</summary>
        public string LocalModel { get; set; } = "base.en";

        /// <summary>When local STT is unavailable or errors, fall back to cloud (OpenAI Whisper). Off = LAN-only.</summary>
        public bool AllowCloudFallback { get; set; } = true;

        /// <summary>Preferred engine when both are available: <c>local</c> or <c>cloud</c>.</summary>
        public string Prefer { get; set; } = "local";

        /// <summary>Per-request timeout for the local sidecar (large audio / cold model guard).</summary>
        public int TimeoutSeconds { get; set; } = 120;

        public bool LocalConfigured => !string.IsNullOrWhiteSpace(LocalEndpoint);
    }
}
