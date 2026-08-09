namespace HomeHub.Api.Ai;

using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;

/// <summary>
/// Chatterbox-backed TTS: HTTP to a self-hosted Chatterbox-TTS-Server exposing an OpenAI-compatible
/// <c>/v1/audio/speech</c> endpoint. This is the expressive voice — the only open model tier with
/// real emotion control, which is what <see cref="Prosody"/> exists to drive.
/// </summary>
/// <remarks>
/// Deliberately thin. The OpenAI-compatible surface is a community wrapper around a young model, so
/// the wrapper's API is treated as the contract and everything engine-specific stops here; swapping
/// wrappers should be a change to this one class.
/// <para>
/// Needs CUDA to be conversationally fast. Until a GPU is installed this stays configured-off and
/// <see cref="VoiceRouter"/> keeps Piper primary — the migration is flipping <c>Voice:Tts:Primary</c>,
/// not a rewrite.
/// </para>
/// </remarks>
public sealed class ChatterboxTextToSpeech : ITextToSpeech
{
    private readonly HttpClient _http;
    private readonly VoiceOptions.TtsOptions _tts;
    private readonly VoiceOptions.ChatterboxOptions _options;
    private readonly ILogger<ChatterboxTextToSpeech> _logger;

    public ChatterboxTextToSpeech(HttpClient http, IOptions<VoiceOptions> options, ILogger<ChatterboxTextToSpeech> logger)
    {
        _http = http;
        _tts = options.Value.Tts;
        _options = _tts.Chatterbox;
        _logger = logger;

        if (_options.IsConfigured)
        {
            _http.BaseAddress = new Uri(_options.Endpoint!.TrimEnd('/') + "/");
            _http.Timeout = TimeSpan.FromSeconds(Math.Max(1, _options.TimeoutSeconds));
        }
    }

    public bool IsAvailable => _options.IsConfigured;

    public string Engine => "chatterbox";

    public async Task<VoiceHealth> GetHealthAsync(CancellationToken ct)
    {
        if (!IsAvailable) return new VoiceHealth(false, Engine, "Chatterbox endpoint not configured.");
        try
        {
            // The wrapper exposes the OpenAI-style model list; a 200 means the service is up and loaded.
            using var res = await _http.GetAsync("v1/models", ct);
            return res.IsSuccessStatusCode
                ? new VoiceHealth(true, Engine, null)
                : new VoiceHealth(false, Engine, $"Chatterbox returned {(int)res.StatusCode}.");
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            return new VoiceHealth(false, Engine, ex.Message);
        }
    }

    public async Task<byte[]?> SynthesizeAsync(SpeechRequest request, CancellationToken ct)
    {
        if (!IsAvailable || string.IsNullOrWhiteSpace(request.Text)) return null;

        var p = ParamsFor(request.Prosody);
        var payload = new SpeechPayload(
            Model: _options.Model,
            Input: request.Text.ReplaceLineEndings(" ").Trim(),
            Voice: _options.Voice,
            ResponseFormat: _options.ResponseFormat,
            Speed: p.Speed,
            Exaggeration: p.Exaggeration,
            CfgWeight: p.Cfg);

        try
        {
            using var res = await _http.PostAsJsonAsync("v1/audio/speech", payload, ct);
            if (!res.IsSuccessStatusCode)
            {
                _logger.LogError("Chatterbox synthesis returned {Status}.", (int)res.StatusCode);
                return null;
            }
            return await res.Content.ReadAsByteArrayAsync(ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Chatterbox synthesis failed.");
            return null;
        }
    }

    /// <summary>Prosody → emotion parameters, falling back to Neutral then to the built-in defaults.</summary>
    private VoiceOptions.ProsodyParams ParamsFor(Prosody prosody) =>
        _options.Prosody.GetValueOrDefault(prosody.ToString())
        ?? _options.Prosody.GetValueOrDefault(nameof(Prosody.Neutral))
        ?? new VoiceOptions.ProsodyParams();

    /// <summary>
    /// OpenAI's speech payload plus Chatterbox's emotion extensions. Servers that don't understand
    /// the extra fields ignore them, so this stays compatible with a plain OpenAI-compatible host.
    /// </summary>
    private sealed record SpeechPayload(
        [property: JsonPropertyName("model")] string Model,
        [property: JsonPropertyName("input")] string Input,
        [property: JsonPropertyName("voice")] string Voice,
        [property: JsonPropertyName("response_format")] string ResponseFormat,
        [property: JsonPropertyName("speed")] double Speed,
        [property: JsonPropertyName("exaggeration")] double Exaggeration,
        [property: JsonPropertyName("cfg_weight")] double CfgWeight);
}
