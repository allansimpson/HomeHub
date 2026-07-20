namespace HomeHub.Api.Ai;

/// <summary>
/// Speech-to-text seam (swappable, per the seam philosophy). The architecture prefers local
/// STT (e.g. Whisper on the server) to keep voice on the LAN; the transcribed text then flows
/// through the Stage 7 <see cref="AssistantRouter"/> so voice inherits routing + the LOCAL/CLOUD
/// indicator. The kiosk can also use the browser's on-device recognizer (the demoable default);
/// this server path is used when configured.
/// </summary>
public interface ISpeechToText
{
    /// <summary>Whether server-side transcription is configured/usable.</summary>
    bool IsAvailable { get; }

    Task<string> TranscribeAsync(Stream audio, string fileName, string contentType, CancellationToken ct);
}
