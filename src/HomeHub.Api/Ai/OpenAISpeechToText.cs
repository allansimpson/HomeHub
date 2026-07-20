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

    public bool IsAvailable => _options.CloudConfigured;

    public async Task<string> TranscribeAsync(Stream audio, string fileName, string contentType, CancellationToken ct)
    {
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
