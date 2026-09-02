namespace HomeHub.Api.Ai;

using HomeHub.Api.Net;
using Microsoft.Extensions.Options;

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
        /// <remarks>
        /// <b>"Local" was a name rather than a constraint, and that was the finding.</b> Any non-empty
        /// string was accepted, and <see cref="LocalWhisperSpeechToText"/> posts raw household audio
        /// straight to it — so a panel with cloud fallback off, `Prefer=local`, and no egress
        /// acknowledgement at all could still be sending every recording to a public host over
        /// cleartext, while the operator, the validator and the panel's own boundary indicator all
        /// called it local. The privacy claim was resting on the field's name.
        /// <para>
        /// It is now checked as what it claims to be: on this machine or this house's own network. A
        /// destination outside that is not a local sidecar, and if a deployment genuinely wants one it
        /// belongs behind the same explicit egress consent and destination allowlist as cloud speech —
        /// see <see cref="LocalAllowedHosts"/>.
        /// </para>
        /// </remarks>
        public string? LocalEndpoint { get; set; }

        /// <summary>
        /// Hosts permitted for <see cref="LocalEndpoint"/> beyond the private-network rule.
        /// </summary>
        /// <remarks>
        /// Empty — and it should stay empty — means the endpoint must resolve onto this machine or this
        /// house's network, which is the whole meaning of "local". Naming a host here is how a
        /// deployment says out loud that its "local" sidecar is somewhere else; it then also needs
        /// <see cref="CloudAudioEgressAcknowledged"/>, because that is exactly what it is.
        /// </remarks>
        public List<string> LocalAllowedHosts { get; set; } = [];

        /// <summary>The rule for the local sidecar, shared by startup, availability and the request sink.</summary>
        public EgressRule LocalRule => LocalAllowedHosts.Count > 0
            ? EgressRule.Internet("Voice:Stt:LocalEndpoint", LocalAllowedHosts)
            : EgressRule.HouseholdLan("Voice:Stt:LocalEndpoint");

        /// <summary>Whisper model the sidecar loads (e.g. <c>tiny.en</c> / <c>base.en</c> / <c>small.en</c>).</summary>
        public string LocalModel { get; set; } = "base.en";

        /// <summary>
        /// When local STT is unavailable or errors, fall back to cloud (OpenAI Whisper). Off = LAN-only.
        /// </summary>
        /// <remarks>
        /// <para>
        /// <b>Off by default, and it used to be on.</b> An ordinary local outage — the sidecar not up
        /// yet after a reboot, a model still loading, one bad request — silently moved the household's
        /// speech off the LAN and into a third party's hands. Nothing about that decision was
        /// deployed: it was the default in this class and in the shipped <c>appsettings.json</c>, so
        /// the privacy boundary of the house changed because a process was slow to start.
        /// </para>
        /// <para>
        /// Sending recorded household speech to a vendor is a decision somebody has to make on
        /// purpose. Unset, the panel stays local and says so; a local outage becomes an error the
        /// operator can see rather than an export nobody was told about.
        /// </para>
        /// </remarks>
        public bool AllowCloudFallback { get; set; }

        /// <summary>
        /// Acknowledges that enabling cloud speech sends household audio off the LAN.
        /// </summary>
        /// <remarks>
        /// <para>
        /// <b>Required in deployment environments before any cloud STT runs</b> — whether reached by
        /// <see cref="AllowCloudFallback"/> or by <see cref="Prefer"/><c> = cloud</c>. See
        /// <see cref="VoiceOptionsValidator"/>: without it, startup fails rather than quietly
        /// exporting audio.
        /// </para>
        /// <para>
        /// A second key rather than trusting the first, because the two say different things. One is
        /// a routing preference of the kind an operator changes while chasing a bug; this is the
        /// household's consent to speech leaving the house, and consent should not be a side effect of
        /// tuning. Development and the automated Test environment do not require it — the safeguard is
        /// about deployments, and a developer with no local sidecar should still get a working panel.
        /// </para>
        /// </remarks>
        public bool CloudAudioEgressAcknowledged { get; set; }

        /// <summary>Preferred engine when both are available: <c>local</c> or <c>cloud</c>.</summary>
        public string Prefer { get; set; } = "local";

        /// <summary>Per-request timeout for the local sidecar (large audio / cold model guard).</summary>
        public int TimeoutSeconds { get; set; } = 120;

        /// <summary>
        /// True when a local sidecar is configured <i>and</i> is somewhere audio may be sent.
        /// </summary>
        /// <remarks>
        /// A non-empty string used to be the whole condition. A destination that fails the rule now
        /// reads as no local engine, so <see cref="SttRouter"/> skips it and no request is built —
        /// the fail-closed half of the check <see cref="VoiceOptionsValidator"/> makes loudly at
        /// startup, and the half that still holds in Development where startup is lenient.
        /// </remarks>
        public bool LocalConfigured =>
            !string.IsNullOrWhiteSpace(LocalEndpoint) && EgressGuard.IsPermitted(LocalEndpoint, LocalRule);

        /// <summary>Whether this configuration permits household audio to leave the LAN at all.</summary>
        /// <remarks>
        /// The one place the question is answered, so the router, the validator and the status the
        /// operator reads cannot disagree about it. <see cref="SttRouter"/> asks the same question of
        /// the engines it actually holds; this asks it of the configuration alone, which is what can
        /// be checked at startup and printed.
        /// </remarks>
        public bool PermitsCloudAudio =>
            AllowCloudFallback || string.Equals(Prefer, "cloud", StringComparison.OrdinalIgnoreCase);
    }
}

/// <summary>
/// Refuses to start a deployment that would send household speech to a third party by accident.
/// </summary>
/// <remarks>
/// <para>
/// <b>The failure this exists to prevent is silence, not misconfiguration.</b> Cloud STT was reached
/// by an ordinary local outage under a default nobody had chosen, and the only trace of it was an
/// engine label on a response somebody would have had to be looking at. A privacy boundary that moves
/// without anybody being told is worse than one that is configured wrongly and says so at boot.
/// </para>
/// <para>
/// So enabling cloud audio in a deployment takes two keys that mean different things — the routing
/// decision and the household's acknowledgement that speech leaves the house — and the absence or
/// contradiction of either fails startup rather than degrading to the export. Development and the
/// automated Test environment are exempt: the safeguard is about deployments, and a developer's panel
/// should work without a consent flag being demanded of it.
/// </para>
/// </remarks>
public sealed class VoiceOptionsValidator(bool requiresDeploymentSafeguards) : IValidateOptions<VoiceOptions>
{
    public ValidateOptionsResult Validate(string? name, VoiceOptions options)
    {
        var errors = new List<string>();
        var stt = options.Stt;

        if (!string.Equals(stt.Prefer, "local", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(stt.Prefer, "cloud", StringComparison.OrdinalIgnoreCase))
        {
            // A misspelling used to mean "local" by falling through the comparison in `SttRouter`,
            // which is the right behaviour and the wrong way to arrive at it: nobody would ever learn
            // that the value they set was not a value.
            errors.Add($"Voice:Stt:Prefer must be 'local' or 'cloud'; found '{stt.Prefer}'.");
        }

        /*
         * The local sidecar's destination, checked as a destination rather than trusted as a name.
         *
         * Checked in every environment, unlike the acknowledgement below, because this is not a policy
         * question a deployment can answer differently — a URL with userinfo, a query string, or a
         * public address is not a local sidecar anywhere. A developer pointing at 127.0.0.1 is
         * unaffected, which is the whole of what Development needs.
         */
        if (!string.IsNullOrWhiteSpace(stt.LocalEndpoint)
            && EgressGuard.Refuse(stt.LocalEndpoint, stt.LocalRule) is { } localRefusal)
        {
            errors.Add(localRefusal);
        }

        /*
         * A "local" endpoint named as being off the house network is cloud egress wearing another
         * name, so it needs the same consent. Without this the acknowledgement below could be walked
         * around entirely by moving the destination rather than changing the routing.
         */
        if (requiresDeploymentSafeguards && stt.LocalAllowedHosts.Count > 0
            && !stt.CloudAudioEgressAcknowledged)
        {
            errors.Add(
                "Voice:Stt:LocalAllowedHosts names a host outside this house's network, which sends "
                + "household audio off the LAN exactly as cloud speech-to-text does. Set "
                + "Voice:Stt:CloudAudioEgressAcknowledged=true to confirm that is intended, or leave "
                + "the list empty so the local sidecar must be local.");
        }

        if (requiresDeploymentSafeguards && stt.PermitsCloudAudio && !stt.CloudAudioEgressAcknowledged)
        {
            errors.Add(
                "Cloud speech-to-text sends household audio to a third party. Set "
                + "Voice:Stt:CloudAudioEgressAcknowledged=true to confirm that is intended, or leave "
                + "Voice:Stt:AllowCloudFallback unset and Voice:Stt:Prefer=local to stay on the LAN.");
        }

        // Acknowledged but not enabled is not an error — it is a household that has consented and
        // switched the routing back off, which is a state they are entitled to be in.

        return errors.Count > 0 ? ValidateOptionsResult.Fail(errors) : ValidateOptionsResult.Success;
    }
}
