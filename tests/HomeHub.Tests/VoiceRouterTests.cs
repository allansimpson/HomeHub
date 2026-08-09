namespace HomeHub.Tests;

using HomeHub.Api.Ai;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

/// <summary>
/// Stage 8R voice routing: the configured primary speaks, Piper covers when it can't, and an
/// utterance that misses the deadline is re-spoken rather than waited on. This is the behaviour
/// that makes the Chatterbox migration a config flip and keeps a spoken alert from ever blocking on
/// GPU warm-up.
/// </summary>
public class VoiceRouterTests
{
    private sealed class FakeEngine : ITextToSpeech
    {
        private readonly byte[]? _audio;
        private readonly TimeSpan _delay;

        public FakeEngine(string engine, bool available = true, byte[]? audio = null, TimeSpan? delay = null)
        {
            Engine = engine;
            IsAvailable = available;
            _audio = audio ?? [1, 2, 3];
            _delay = delay ?? TimeSpan.Zero;
        }

        public string Engine { get; }
        public bool IsAvailable { get; }
        public bool Throws { get; set; }
        public int Calls { get; private set; }

        public Task<VoiceHealth> GetHealthAsync(CancellationToken ct) =>
            Task.FromResult(new VoiceHealth(IsAvailable, Engine, null));

        public async Task<byte[]?> SynthesizeAsync(SpeechRequest request, CancellationToken ct)
        {
            Calls++;
            if (_delay > TimeSpan.Zero) await Task.Delay(_delay, ct);
            if (Throws) throw new InvalidOperationException("engine exploded");
            return _audio;
        }
    }

    private static VoiceRouter NewRouter(
        FakeEngine piper, FakeEngine chatterbox, string primary = "piper", double deadlineSeconds = 2.5,
        string? cacheDir = null)
    {
        var options = Options.Create(new VoiceOptions
        {
            Tts = new VoiceOptions.TtsOptions
            {
                Primary = primary,
                FirstAudioDeadlineSeconds = deadlineSeconds,
                // Point the cache at a throwaway directory so tests never touch a real one.
                CacheDirectory = cacheDir ?? Path.Combine(Path.GetTempPath(), "homehub-voice-tests-" + Guid.NewGuid()),
                PiperPath = "piper",
                VoiceModel = "voice.onnx",
                Chatterbox = new VoiceOptions.ChatterboxOptions { Endpoint = "http://gpu.test:8004" },
            },
        });

        var cache = new PhraseCache(options, NullLogger<PhraseCache>.Instance);
        return new VoiceRouter(piper, chatterbox, cache, options, NullLogger<VoiceRouter>.Instance);
    }

    [Fact]
    public async Task Uses_piper_by_default()
    {
        var piper = new FakeEngine("piper");
        var chatterbox = new FakeEngine("chatterbox");
        var router = NewRouter(piper, chatterbox);

        var result = await router.SpeakAsync(new SpeechRequest("hello"), default);

        Assert.NotNull(result);
        Assert.Equal("piper", result.Engine);
        Assert.False(result.Degraded);
        Assert.Equal(0, chatterbox.Calls);
    }

    [Fact]
    public async Task Flipping_primary_to_chatterbox_switches_engines_with_no_other_change()
    {
        var piper = new FakeEngine("piper");
        var chatterbox = new FakeEngine("chatterbox");
        var router = NewRouter(piper, chatterbox, primary: "chatterbox");

        var result = await router.SpeakAsync(new SpeechRequest("hello"), default);

        Assert.NotNull(result);
        Assert.Equal("chatterbox", result.Engine);
        Assert.Equal(0, piper.Calls);
    }

    [Fact]
    public async Task Falls_back_to_piper_and_marks_degraded_when_chatterbox_fails()
    {
        var piper = new FakeEngine("piper");
        var chatterbox = new FakeEngine("chatterbox") { Throws = true };
        var router = NewRouter(piper, chatterbox, primary: "chatterbox");

        var result = await router.SpeakAsync(new SpeechRequest("severe weather alert", Prosody.Urgent), default);

        Assert.NotNull(result);
        Assert.Equal("piper", result.Engine);
        Assert.True(result.Degraded);
    }

    [Fact]
    public async Task An_utterance_that_misses_the_deadline_is_spoken_by_piper_instead()
    {
        var piper = new FakeEngine("piper");
        var slow = new FakeEngine("chatterbox", delay: TimeSpan.FromSeconds(5));
        var router = NewRouter(piper, slow, primary: "chatterbox", deadlineSeconds: 0.15);

        var result = await router.SpeakAsync(new SpeechRequest("tornado warning", Prosody.Urgent), default);

        Assert.NotNull(result);
        Assert.Equal("piper", result.Engine);
        Assert.True(result.Degraded);
    }

    [Fact]
    public async Task Falls_back_to_chatterbox_when_piper_is_the_one_that_is_down()
    {
        var piper = new FakeEngine("piper") { Throws = true };
        var chatterbox = new FakeEngine("chatterbox");
        var router = NewRouter(piper, chatterbox); // piper primary

        var result = await router.SpeakAsync(new SpeechRequest("hello"), default);

        Assert.NotNull(result);
        Assert.Equal("chatterbox", result.Engine);
        Assert.True(result.Degraded);
    }

    [Fact]
    public async Task Returns_null_when_no_engine_can_speak()
    {
        var piper = new FakeEngine("piper", available: false);
        var chatterbox = new FakeEngine("chatterbox", available: false);
        var router = NewRouter(piper, chatterbox);

        Assert.Null(await router.SpeakAsync(new SpeechRequest("hello"), default));
        Assert.False(router.IsAvailable);
    }

    [Fact]
    public async Task Cached_phrases_are_served_without_re_synthesizing()
    {
        var cacheDir = Path.Combine(Path.GetTempPath(), "homehub-voice-tests-" + Guid.NewGuid());
        var piper = new FakeEngine("piper");
        var chatterbox = new FakeEngine("chatterbox");
        var router = NewRouter(piper, chatterbox, cacheDir: cacheDir);

        try
        {
            var first = await router.SpeakAsync(new SpeechRequest("Severe weather alert", Prosody.Urgent), default);
            var second = await router.SpeakAsync(new SpeechRequest("Severe weather alert", Prosody.Urgent), default);

            Assert.NotNull(first);
            Assert.NotNull(second);
            Assert.False(first.FromCache);
            Assert.True(second.FromCache);
            Assert.Equal(1, piper.Calls); // the second utterance cost no inference
        }
        finally
        {
            try { Directory.Delete(cacheDir, recursive: true); } catch { /* best effort */ }
        }
    }

    [Fact]
    public async Task Dynamic_text_opts_out_of_the_cache()
    {
        var cacheDir = Path.Combine(Path.GetTempPath(), "homehub-voice-tests-" + Guid.NewGuid());
        var piper = new FakeEngine("piper");
        var router = NewRouter(piper, new FakeEngine("chatterbox"), cacheDir: cacheDir);

        try
        {
            await router.SpeakAsync(new SpeechRequest("a one-off reply", Prosody.Warm, AllowCache: false), default);
            await router.SpeakAsync(new SpeechRequest("a one-off reply", Prosody.Warm, AllowCache: false), default);

            Assert.Equal(2, piper.Calls);
        }
        finally
        {
            try { Directory.Delete(cacheDir, recursive: true); } catch { /* best effort */ }
        }
    }
}
