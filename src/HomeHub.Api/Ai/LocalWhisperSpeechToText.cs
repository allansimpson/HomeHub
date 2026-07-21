namespace HomeHub.Api.Ai;

using System.Net.Http.Headers;
using System.Net.Http.Json;
using Microsoft.Extensions.Options;

/// <summary>
/// Local server-side STT via a faster-whisper sidecar exposing OpenAI's audio-transcription contract
/// (<c>POST /v1/audio/transcriptions</c>, multipart). Keeps voice on the LAN. Same seam as
/// <see cref="OpenAISpeechToText"/> — only the base URL differs and there is no auth header — so the
/// <see cref="SttRouter"/> can pick local first and fall back to cloud with no downstream change.
/// </summary>
public sealed class LocalWhisperSpeechToText : ISpeechToText
{
    private readonly HttpClient _http;
    private readonly VoiceOptions.SttOptions _stt;

    public LocalWhisperSpeechToText(HttpClient http, IOptions<VoiceOptions> options)
    {
        _http = http;
        _stt = options.Value.Stt;
    }

    public bool IsAvailable => _stt.LocalConfigured;

    public async Task<string> TranscribeAsync(Stream audio, string fileName, string contentType, CancellationToken ct)
    {
        using var content = new MultipartFormDataContent();
        var file = new StreamContent(audio);
        // Pass the real content type through (the Pi posts wav, the browser posts webm); the sidecar's
        // ffmpeg picks the decoder from it. Default to wav for the Pi bridge's typical clip.
        file.Headers.ContentType = new MediaTypeHeaderValue(string.IsNullOrWhiteSpace(contentType) ? "audio/wav" : contentType);
        content.Add(file, "file", string.IsNullOrWhiteSpace(fileName) ? "audio.wav" : fileName);
        content.Add(new StringContent(_stt.LocalModel), "model");

        var url = _stt.LocalEndpoint!.TrimEnd('/') + "/v1/audio/transcriptions";
        using var res = await _http.PostAsync(url, content, ct);
        res.EnsureSuccessStatusCode();
        var body = await res.Content.ReadFromJsonAsync<TranscriptionResponse>(ct);
        return body?.Text?.Trim() ?? "";
    }

    private sealed record TranscriptionResponse(string? Text);
}
