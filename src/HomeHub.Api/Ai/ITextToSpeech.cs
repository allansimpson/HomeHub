namespace HomeHub.Api.Ai;

/// <summary>
/// Server-side text-to-speech seam. When available, the whole app speaks in one central voice via
/// <c>POST /api/voice/speak</c>; otherwise the client uses the browser's on-device synthesizer.
/// </summary>
/// <remarks>
/// Stage 8R extended this in place rather than introducing a parallel <c>IVoiceProvider</c>: the
/// requirement was prosody at every call site, which an overload delivers without forking a shipped
/// seam. Implementations must not leak their engine (Piper, Chatterbox) past this interface.
/// </remarks>
public interface ITextToSpeech
{
    /// <summary>True when a synth engine is configured and usable.</summary>
    bool IsAvailable { get; }

    /// <summary>Which engine this is, for the degraded-mode indicator. <c>piper</c> | <c>chatterbox</c>.</summary>
    string Engine { get; }

    /// <summary>Synthesize with prosody and cache policy. Null when unavailable / on failure.</summary>
    Task<byte[]?> SynthesizeAsync(SpeechRequest request, CancellationToken ct);

    /// <summary>Whether the engine can actually speak right now (process present, service reachable).</summary>
    Task<VoiceHealth> GetHealthAsync(CancellationToken ct);
}

/// <summary>
/// How a line should be delivered. Chosen at every call site from Stage 8R onward, even though
/// Piper ignores it — when Chatterbox lands the whole app becomes emotion-capable with no call-site
/// changes.
/// </summary>
public enum Prosody
{
    /// <summary>Default reading voice.</summary>
    Neutral,

    /// <summary>Severe weather, threshold alerts. Must never wait on a slow engine.</summary>
    Urgent,

    /// <summary>Assistant chat, greetings.</summary>
    Warm,

    /// <summary>Night hours — pairs with night-dim.</summary>
    Subdued,
}

/// <summary>
/// A line to speak. <paramref name="AllowCache"/> is false for dynamic text (an assistant reply);
/// fixed strings leave it true so they can be served from the pre-rendered phrase cache.
/// </summary>
public sealed record SpeechRequest(string Text, Prosody Prosody = Prosody.Neutral, bool AllowCache = true);

/// <summary>Engine health, for router selection and the panel's degraded chip.</summary>
public sealed record VoiceHealth(bool Healthy, string Engine, string? Detail);

/// <summary>Convenience wrappers so simple call sites stay readable.</summary>
public static class TextToSpeechExtensions
{
    /// <summary>Speak neutral text with caching allowed.</summary>
    public static Task<byte[]?> SynthesizeAsync(this ITextToSpeech tts, string text, CancellationToken ct) =>
        tts.SynthesizeAsync(new SpeechRequest(text), ct);
}
