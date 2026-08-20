namespace HomeHub.Api.Controllers;

using HomeHub.Api.Ai;
using HomeHub.Api.Auth;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

/// <summary>
/// Voice support endpoints. The kiosk's default path uses the browser's on-device recognizer +
/// speech synthesis (no server round-trip), so voice is demoable without any keys. When server STT
/// is configured, the client (or the Pi voice bridge) posts captured audio here; it is transcribed
/// local-first with cloud fallback via <see cref="SttRouter"/>, and the text flows through the same
/// assistant router. Server TTS goes through <see cref="VoiceRouter"/>, so both the panel and the
/// Pi voice bridge speak in the same voice from one place.
/// </summary>
[ApiController]
[Route("api/[controller]")]
public class VoiceController : ControllerBase
{
    private readonly SttRouter _stt;
    private readonly VoiceRouter _tts;

    public VoiceController(SttRouter stt, VoiceRouter tts)
    {
        _stt = stt;
        _tts = tts;
    }

    /// <summary>Tells the client whether to use server STT/TTS (and which engines) or the browser.</summary>
    [HttpGet("capabilities")]
    public VoiceCapabilities Capabilities() =>
        new(ServerStt: _stt.AnyAvailable, LocalStt: _stt.LocalAvailable, CloudStt: _stt.CloudAvailable,
            ServerTts: _tts.IsAvailable, TtsEngine: _tts.PrimaryEngine);

    /// <summary>
    /// Synthesize text to speech in the app's central voice. 501 when no engine is configured.
    /// The engine that actually spoke is returned in <c>X-Voice-Engine</c>, and
    /// <c>X-Voice-Degraded</c> marks a fallback so the panel can show its degraded chip.
    /// </summary>
    [HttpPost("speak")]
    [Authorize(Policy = Household.VoiceBridgePolicy)]
    public async Task<IActionResult> Speak([FromBody] SpeakInput input, CancellationToken ct)
    {
        if (!_tts.IsAvailable)
            return StatusCode(StatusCodes.Status501NotImplemented, "Server TTS is not configured; use the on-device synthesizer.");
        if (input is null || string.IsNullOrWhiteSpace(input.Text))
            return BadRequest("No text provided.");
        if (!TryParseProsody(input.Prosody, out var prosody))
            return BadRequest($"Unknown prosody '{input.Prosody}'. Use neutral, urgent, warm or subdued.");

        var result = await _tts.SpeakAsync(new SpeechRequest(input.Text, prosody, input.AllowCache), ct);
        if (result is null)
            return StatusCode(StatusCodes.Status502BadGateway, "Speech synthesis failed.");

        Response.Headers["X-Voice-Engine"] = result.Engine;
        Response.Headers["X-Voice-Degraded"] = result.Degraded ? "1" : "0";
        return File(result.Audio, "audio/wav");
    }

    private static bool TryParseProsody(string? value, out Prosody prosody)
    {
        if (string.IsNullOrWhiteSpace(value)) { prosody = Prosody.Neutral; return true; }
        return Enum.TryParse(value, ignoreCase: true, out prosody);
    }

    /// <summary>Transcribe uploaded audio to text (server STT). 501 when no engine is configured, 502 if all fail.</summary>
    [HttpPost("transcribe")]
    [Authorize(Policy = Household.VoiceBridgePolicy)]
    [RequestSizeLimit(25_000_000)]
    public async Task<ActionResult<TranscriptionResult>> Transcribe(IFormFile audio, CancellationToken ct)
    {
        if (!_stt.AnyAvailable)
            return StatusCode(StatusCodes.Status501NotImplemented, "Server STT is not configured; use the on-device recognizer.");
        if (audio is null || audio.Length == 0)
            return BadRequest("No audio provided.");

        await using var stream = audio.OpenReadStream();
        try
        {
            var result = await _stt.TranscribeAsync(stream, audio.FileName, audio.ContentType, ct);
            return new TranscriptionResult(result.Text, result.Engine.ToString().ToLowerInvariant());
        }
        catch (InvalidOperationException ex)
        {
            // Every configured engine failed (sidecar down + fallback disabled/also down).
            return StatusCode(StatusCodes.Status502BadGateway, ex.Message);
        }
    }
}

/// <summary>Which voice capabilities the server offers, and which engines back them.</summary>
public record VoiceCapabilities(bool ServerStt, bool LocalStt, bool CloudStt, bool ServerTts, string TtsEngine = "piper");

/// <summary>
/// Text to synthesize. <paramref name="Prosody"/> is how the line should be delivered
/// (<c>neutral</c> | <c>urgent</c> | <c>warm</c> | <c>subdued</c>); set
/// <paramref name="AllowCache"/> false for dynamic text that will never be spoken again.
/// </summary>
public record SpeakInput(string Text, string? Prosody = null, bool AllowCache = true);

/// <summary>Transcription result plus the engine that produced it (<c>local</c> / <c>cloud</c>).</summary>
public record TranscriptionResult(string Text, string Engine = "cloud");
