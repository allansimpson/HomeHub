namespace HomeHub.Api.Ai;

/// <summary>Which STT engine transcribed a clip. Surfaced to the UI as LOCAL / CLOUD, like <see cref="AssistantOrigin"/>.</summary>
public enum SttEngine
{
    Local = 0,
    Cloud = 1,
}

/// <summary>
/// A transcription plus the engine that actually produced it — which can differ from the configured
/// preference after a fallback, so the UI's LOCAL/CLOUD indicator reflects reality, not intent.
/// </summary>
public sealed record SttResult(string Text, SttEngine Engine);
