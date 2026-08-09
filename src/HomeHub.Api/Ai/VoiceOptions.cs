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

    public TtsOptions Tts { get; set; } = new();

    /// <summary>
    /// Central text-to-speech. Piper (local binary) is the default and the permanent fallback;
    /// Chatterbox becomes primary once a GPU is installed, which is a change to
    /// <see cref="TtsOptions.Primary"/> and nothing else.
    /// </summary>
    public sealed class TtsOptions
    {
        /// <summary>Preferred engine: <c>piper</c> or <c>chatterbox</c>. Migration is flipping this value.</summary>
        public string Primary { get; set; } = "piper";

        /// <summary>
        /// How long the primary engine gets to produce audio before the router gives up and lets
        /// Piper speak instead. Guards against GPU warm-up and VRAM contention delaying a spoken alert.
        /// </summary>
        public double FirstAudioDeadlineSeconds { get; set; } = 2.5;

        /// <summary>
        /// Directory for the pre-rendered phrase cache. Empty = a <c>homehub-voice-cache</c> folder
        /// under the system temp path.
        /// </summary>
        public string? CacheDirectory { get; set; }

        /// <summary>Path to the Piper executable (e.g. <c>/opt/piper/piper</c> or <c>C:\piper\piper.exe</c>).</summary>
        public string? PiperPath { get; set; }

        /// <summary>Path to the voice model (e.g. <c>…/en_US-norman-medium.onnx</c>); its <c>.json</c> sits beside it.</summary>
        public string? VoiceModel { get; set; }

        /// <summary>Per-request synthesis timeout (guards a hung/cold Piper process).</summary>
        public int TimeoutSeconds { get; set; } = 30;

        public ChatterboxOptions Chatterbox { get; set; } = new();

        public bool IsConfigured => !string.IsNullOrWhiteSpace(PiperPath) && !string.IsNullOrWhiteSpace(VoiceModel);

        /// <summary>True when config asks for Chatterbox and Chatterbox is actually configured.</summary>
        public bool PrefersChatterbox =>
            string.Equals(Primary, "chatterbox", StringComparison.OrdinalIgnoreCase) && Chatterbox.IsConfigured;
    }

    /// <summary>
    /// Chatterbox-TTS-Server (Resemble AI's Chatterbox behind an OpenAI-compatible
    /// <c>/v1/audio/speech</c> API), self-hosted on the server. Requires CUDA for conversational
    /// latency, which is why it is not the default.
    /// </summary>
    public sealed class ChatterboxOptions
    {
        /// <summary>Base URL of the Chatterbox server, e.g. <c>http://server.lan:8004</c>. Empty = off.</summary>
        public string? Endpoint { get; set; }

        /// <summary>Model name. Turbo is the panel target (~75ms latency, ~6x real-time).</summary>
        public string Model { get; set; } = "chatterbox-turbo";

        /// <summary>
        /// The house voice — a neutral custom reference clip. Deliberately not a family member's
        /// cloned voice: this panel announces emergencies and 3am alerts.
        /// </summary>
        public string Voice { get; set; } = "house";

        /// <summary>Audio format requested from the server. WAV keeps the client playback path unchanged.</summary>
        public string ResponseFormat { get; set; } = "wav";

        public int TimeoutSeconds { get; set; } = 30;

        /// <summary>
        /// Per-prosody emotion parameters, keyed by <see cref="Prosody"/> name. Defaults follow the
        /// design doc's table; final values are tuned by ear after the GPU migration, which is why
        /// they are config rather than constants.
        /// </summary>
        public Dictionary<string, ProsodyParams> Prosody { get; set; } = new(StringComparer.OrdinalIgnoreCase)
        {
            [nameof(Ai.Prosody.Neutral)] = new() { Exaggeration = 0.5, Cfg = 0.5 },
            [nameof(Ai.Prosody.Urgent)] = new() { Exaggeration = 0.7, Cfg = 0.3 },
            [nameof(Ai.Prosody.Warm)] = new() { Exaggeration = 0.55, Cfg = 0.5 },
            [nameof(Ai.Prosody.Subdued)] = new() { Exaggeration = 0.4, Cfg = 0.5, Speed = 0.95 },
        };

        public bool IsConfigured => !string.IsNullOrWhiteSpace(Endpoint);
    }

    /// <summary>Chatterbox emotion controls for one prosody.</summary>
    public sealed class ProsodyParams
    {
        /// <summary>Emotional intensity. Higher = more expressive.</summary>
        public double Exaggeration { get; set; } = 0.5;

        /// <summary>Classifier-free guidance. Lower = looser, faster-feeling delivery.</summary>
        public double Cfg { get; set; } = 0.5;

        /// <summary>Playback pacing multiplier.</summary>
        public double Speed { get; set; } = 1.0;
    }

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
