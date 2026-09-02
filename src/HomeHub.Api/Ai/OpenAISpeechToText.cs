namespace HomeHub.Api.Ai;

using System.Net.Http.Headers;
using System.Net.Http.Json;
using Microsoft.Extensions.Options;

/// <summary>
/// Server-side STT via OpenAI's audio transcription (Whisper). Behind <see cref="ISpeechToText"/>;
/// active when <c>Ai:OpenAiApiKey</c> is set. A local Whisper server could implement the same
/// seam to keep audio on the LAN — no downstream change. (Config for a dedicated STT model/key can
/// be added later; this reuses the assistant's OpenAI key.)
/// </summary>
public sealed class OpenAISpeechToText : ISpeechToText
{
    private const string Model = "whisper-1";

    private readonly HttpClient _http;
    private readonly AiOptions _options;

    public OpenAISpeechToText(HttpClient http, IOptions<AiOptions> options)
    {
        _http = http;
        _options = options.Value;
    }

    public bool IsAvailable => _options.CloudSpeechConfigured;

    public async Task<string> TranscribeAsync(Stream audio, string fileName, string contentType, CancellationToken ct)
    {
        /*
         * The destination is checked here as well as at startup and in `IsAvailable`.
         *
         * Not redundant, and the reason is what this method does with its arguments: it is the one
         * place in the app that puts raw household audio and a bearer credential on the wire. A caller
         * that reached it without going through `SttRouter` — a direct resolve, a future code path, a
         * test — would otherwise inherit no check at all. Refused rather than sent, because the cost of
         * being wrong here is not a failed request.
         */
        if (CloudSpeechEndpoint.Refuse(_options.OpenAiBaseUrl, _options.OpenAiAllowedHosts) is { } refusal)
            throw new InvalidOperationException(refusal);

        using var content = new MultipartFormDataContent();
        var file = new StreamContent(audio);
        file.Headers.ContentType = new MediaTypeHeaderValue(string.IsNullOrWhiteSpace(contentType) ? "audio/webm" : contentType);
        content.Add(file, "file", string.IsNullOrWhiteSpace(fileName) ? "audio.webm" : fileName);
        content.Add(new StringContent(Model), "model");

        using var req = new HttpRequestMessage(HttpMethod.Post, _options.OpenAiBaseUrl.TrimEnd('/') + "/v1/audio/transcriptions")
        {
            Content = content,
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _options.OpenAiApiKey);

        using var res = await _http.SendAsync(req, ct);
        res.EnsureSuccessStatusCode();
        var body = await res.Content.ReadFromJsonAsync<TranscriptionResponse>(ct);
        return body?.Text?.Trim() ?? "";
    }

    private sealed record TranscriptionResponse(string? Text);
}
