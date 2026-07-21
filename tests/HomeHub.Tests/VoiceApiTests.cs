namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using HomeHub.Api.Ai;
using HomeHub.Api.Controllers;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;

/// <summary>
/// Stage 8 voice endpoints. With no STT configured (the test environment), server STT is unavailable —
/// capabilities report it and transcribe returns 501 so the client falls back to the browser recognizer.
/// A stubbed local engine proves the local-first path returns the transcript tagged with its engine.
/// </summary>
public class VoiceApiTests
{
    private sealed class StubStt(string text) : ISpeechToText
    {
        public bool IsAvailable => true;
        public Task<string> TranscribeAsync(Stream audio, string fileName, string contentType, CancellationToken ct)
            => Task.FromResult(text);
    }

    [Fact]
    public async Task Capabilities_report_no_server_stt_without_a_key()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var caps = await client.GetFromJsonAsync<VoiceCapabilities>("/api/voice/capabilities");

        Assert.NotNull(caps);
        Assert.False(caps!.ServerStt);
        Assert.False(caps.LocalStt);
        Assert.False(caps.CloudStt);
    }

    [Fact]
    public async Task Transcribe_returns_501_when_server_stt_not_configured()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsync("/api/voice/transcribe", AudioClip());

        Assert.Equal(HttpStatusCode.NotImplemented, res.StatusCode);
    }

    [Fact]
    public async Task Transcribe_uses_local_engine_when_configured()
    {
        using var app = new HubAppFactory();
        // Override the keyed local STT with an available stub (last keyed registration wins). No DB
        // needed — the transcribe endpoint doesn't touch it — so a plain client is enough.
        var client = app.WithWebHostBuilder(b => b.ConfigureServices(services =>
            services.AddKeyedScoped<ISpeechToText>(SttRouter.LocalKey, (_, _) => new StubStt("hello from local"))))
            .CreateClient();

        var res = await client.PostAsync("/api/voice/transcribe", AudioClip());
        res.EnsureSuccessStatusCode();

        var result = await res.Content.ReadFromJsonAsync<TranscriptionResult>();
        Assert.NotNull(result);
        Assert.Equal("hello from local", result!.Text);
        Assert.Equal("local", result.Engine);
    }

    private static MultipartFormDataContent AudioClip()
    {
        var content = new MultipartFormDataContent();
        var audio = new ByteArrayContent([1, 2, 3, 4]);
        audio.Headers.ContentType = new MediaTypeHeaderValue("audio/wav");
        content.Add(audio, "audio", "clip.wav");
        return content;
    }
}
