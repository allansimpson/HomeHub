namespace HomeHub.Api.Controllers;

using HomeHub.Api.Ai;
using Microsoft.AspNetCore.Mvc;

/// <summary>
/// Voice support endpoints. The kiosk's default path uses the browser's on-device recognizer +
/// speech synthesis (no server round-trip), so voice is demoable without any keys. When server
/// STT is configured (<see cref="ISpeechToText.IsAvailable"/>), the client can post captured
/// audio here instead; the resulting text flows through the same assistant router. TTS is done
/// on-device in the browser.
/// </summary>
[ApiController]
[Route("api/[controller]")]
public class VoiceController : ControllerBase
{
    private readonly ISpeechToText _stt;

    public VoiceController(ISpeechToText stt) => _stt = stt;

    /// <summary>Tells the client whether to use server STT or the browser recognizer.</summary>
    [HttpGet("capabilities")]
    public VoiceCapabilities Capabilities() => new(ServerStt: _stt.IsAvailable);

    /// <summary>Transcribe uploaded audio to text (server STT). 501 when not configured.</summary>
    [HttpPost("transcribe")]
    [RequestSizeLimit(25_000_000)]
    public async Task<ActionResult<TranscriptionResult>> Transcribe(IFormFile audio, CancellationToken ct)
    {
        if (!_stt.IsAvailable)
            return StatusCode(StatusCodes.Status501NotImplemented, "Server STT is not configured; use the on-device recognizer.");
        if (audio is null || audio.Length == 0)
            return BadRequest("No audio provided.");

        await using var stream = audio.OpenReadStream();
        var text = await _stt.TranscribeAsync(stream, audio.FileName, audio.ContentType, ct);
        return new TranscriptionResult(text);
    }
}

/// <summary>Which voice capabilities the server offers.</summary>
public record VoiceCapabilities(bool ServerStt);

/// <summary>Transcription result.</summary>
public record TranscriptionResult(string Text);
