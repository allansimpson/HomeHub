namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Controllers;

/// <summary>
/// Stage 8 voice endpoints. With no AI key configured (the test environment), server STT is
/// unavailable — capabilities report it, and transcribe returns 501 so the client falls back to
/// the browser's on-device recognizer. (The browser STT/TTS path itself is exercised in the UI.)
/// </summary>
public class VoiceApiTests
{
    [Fact]
    public async Task Capabilities_report_no_server_stt_without_a_key()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var caps = await client.GetFromJsonAsync<VoiceCapabilities>("/api/voice/capabilities");

        Assert.NotNull(caps);
        Assert.False(caps!.ServerStt);
    }

    [Fact]
    public async Task Transcribe_returns_501_when_server_stt_not_configured()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        using var content = new MultipartFormDataContent();
        var audio = new ByteArrayContent([1, 2, 3, 4]);
        audio.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("audio/webm");
        content.Add(audio, "audio", "clip.webm");

        var res = await client.PostAsync("/api/voice/transcribe", content);

        Assert.Equal(HttpStatusCode.NotImplemented, res.StatusCode);
    }
}
