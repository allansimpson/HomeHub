namespace HomeHub.Tests;

using System.Text;
using HomeHub.Api.Ai;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

/// <summary>
/// STT routing: local-first with cloud fallback, the privacy toggle (no cloud when disabled), and the
/// reported engine reflecting the one that actually ran. Uses a fake ISpeechToText so no network or
/// sidecar is touched — mirrors <see cref="AssistantRouterTests"/>.
/// </summary>
public class SttRouterTests
{
    private sealed class FakeStt : ISpeechToText
    {
        private readonly string _text;
        private readonly bool _throws;
        public int Calls { get; private set; }

        public FakeStt(bool available, string text = "transcript", bool throws = false)
        {
            IsAvailable = available;
            _text = text;
            _throws = throws;
        }

        public bool IsAvailable { get; }

        public Task<string> TranscribeAsync(Stream audio, string fileName, string contentType, CancellationToken ct)
        {
            Calls++;
            using var reader = new StreamReader(audio);   // drain the buffered stream like a real read
            _ = reader.ReadToEnd();
            if (_throws) throw new HttpRequestException("sidecar down");
            return Task.FromResult(_text);
        }
    }

    private static SttRouter Router(FakeStt local, FakeStt cloud, bool allowCloudFallback = true, string prefer = "local") =>
        new(local, cloud,
            Options.Create(new VoiceOptions { Stt = new VoiceOptions.SttOptions { AllowCloudFallback = allowCloudFallback, Prefer = prefer } }),
            NullLogger<SttRouter>.Instance);

    private static Stream Audio() => new MemoryStream(Encoding.UTF8.GetBytes("fake-audio-bytes"));

    [Fact]
    public async Task Prefers_local_when_available()
    {
        var local = new FakeStt(true, "local text");
        var cloud = new FakeStt(true, "cloud text");
        var result = await Router(local, cloud).TranscribeAsync(Audio(), "a.wav", "audio/wav", default);

        Assert.Equal(SttEngine.Local, result.Engine);
        Assert.Equal("local text", result.Text);
        Assert.Equal(1, local.Calls);
        Assert.Equal(0, cloud.Calls);
    }

    [Fact]
    public async Task Falls_back_to_cloud_when_local_unavailable()
    {
        var local = new FakeStt(available: false);
        var cloud = new FakeStt(true, "cloud text");
        var result = await Router(local, cloud).TranscribeAsync(Audio(), "a.wav", "audio/wav", default);

        Assert.Equal(SttEngine.Cloud, result.Engine);
        Assert.Equal(1, cloud.Calls);
        Assert.Equal(0, local.Calls);
    }

    [Fact]
    public async Task Falls_back_to_cloud_when_local_throws()
    {
        var local = new FakeStt(true, throws: true);
        var cloud = new FakeStt(true, "cloud rescued it");
        var result = await Router(local, cloud).TranscribeAsync(Audio(), "a.wav", "audio/wav", default);

        Assert.Equal(SttEngine.Cloud, result.Engine);
        Assert.Equal("cloud rescued it", result.Text);
        Assert.Equal(1, local.Calls);
        Assert.Equal(1, cloud.Calls);
    }

    [Fact]
    public async Task Does_not_use_cloud_when_fallback_disabled()
    {
        var local = new FakeStt(true, throws: true);   // local is the only allowed engine, and it fails
        var cloud = new FakeStt(true, "should not be used");
        var router = Router(local, cloud, allowCloudFallback: false);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => router.TranscribeAsync(Audio(), "a.wav", "audio/wav", default));
        Assert.Equal(0, cloud.Calls);
    }

    [Fact]
    public async Task Prefer_cloud_uses_cloud_first()
    {
        var local = new FakeStt(true, "local text");
        var cloud = new FakeStt(true, "cloud text");
        var result = await Router(local, cloud, prefer: "cloud").TranscribeAsync(Audio(), "a.wav", "audio/wav", default);

        Assert.Equal(SttEngine.Cloud, result.Engine);
        Assert.Equal(1, cloud.Calls);
        Assert.Equal(0, local.Calls);
    }

    [Fact]
    public async Task Reports_unavailable_when_nothing_configured()
    {
        var router = Router(new FakeStt(available: false), new FakeStt(available: false));

        Assert.False(router.AnyAvailable);
        await Assert.ThrowsAsync<InvalidOperationException>(
            () => router.TranscribeAsync(Audio(), "a.wav", "audio/wav", default));
    }
}
