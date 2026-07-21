namespace HomeHub.Api.Controllers;

using HomeHub.Api.Ai;
using Microsoft.AspNetCore.Mvc;

/// <summary>
/// Voice support endpoints. The kiosk's default path uses the browser's on-device recognizer +
/// speech synthesis (no server round-trip), so voice is demoable without any keys. When server STT
/// is configured, the client (or the Pi voice bridge) posts captured audio here; it is transcribed
/// local-first with cloud fallback via <see cref="SttRouter"/>, and the text flows through the same
/// assistant router. TTS is done off the server (browser today; Piper on the bridge later).
/// </summary>
[ApiController]
[Route("api/[controller]")]
public class VoiceController : ControllerBase
{
    private readonly SttRouter _stt;

    public VoiceController(SttRouter stt) => _stt = stt;

    /// <summary>Tells the client whether to use server STT (and which engines are available) or the browser recognizer.</summary>
    [HttpGet("capabilities")]
    public VoiceCapabilities Capabilities() =>
        new(ServerStt: _stt.AnyAvailable, LocalStt: _stt.LocalAvailable, CloudStt: _stt.CloudAvailable);

    /// <summary>Transcribe uploaded audio to text (server STT). 501 when no engine is configured, 502 if all fail.</summary>
    [HttpPost("transcribe")]
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

/// <summary>Which voice capabilities the server offers, and which STT engines back them.</summary>
public record VoiceCapabilities(bool ServerStt, bool LocalStt, bool CloudStt);

/// <summary>Transcription result plus the engine that produced it (<c>local</c> / <c>cloud</c>).</summary>
public record TranscriptionResult(string Text, string Engine = "cloud");
