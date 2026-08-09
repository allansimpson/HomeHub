namespace HomeHub.Api.Ai;

using System.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

/// <summary>
/// Fronts the two <see cref="ITextToSpeech"/> engines the way <see cref="SttRouter"/> fronts STT:
/// the configured primary speaks, and Piper covers for it when it can't. Migration to Chatterbox is
/// a change to <c>Voice:Tts:Primary</c> — no call site moves.
/// </summary>
/// <remarks>
/// The deadline is the important part. An utterance that misses
/// <c>Voice:Tts:FirstAudioDeadlineSeconds</c> is abandoned and re-spoken by Piper, so a spoken alert
/// never waits on GPU warm-up, VRAM contention, or a down service. A different voice that speaks
/// beats the right voice that doesn't — the result reports which engine actually spoke so the panel
/// can show its degraded chip honestly.
/// </remarks>
public sealed class VoiceRouter
{
    /// <summary>DI keys distinguishing the two engines behind the seam.</summary>
    public const string PiperKey = "tts-piper";
    public const string ChatterboxKey = "tts-chatterbox";

    private readonly ITextToSpeech _piper;
    private readonly ITextToSpeech _chatterbox;
    private readonly PhraseCache _cache;
    private readonly VoiceOptions.TtsOptions _options;
    private readonly ILogger<VoiceRouter> _logger;

    public VoiceRouter(
        [FromKeyedServices(PiperKey)] ITextToSpeech piper,
        [FromKeyedServices(ChatterboxKey)] ITextToSpeech chatterbox,
        PhraseCache cache,
        IOptions<VoiceOptions> options,
        ILogger<VoiceRouter> logger)
    {
        _piper = piper;
        _chatterbox = chatterbox;
        _cache = cache;
        _options = options.Value.Tts;
        _logger = logger;
    }

    /// <summary>Whether any engine can speak at all; drives the client's server-TTS capability flag.</summary>
    public bool IsAvailable => _piper.IsAvailable || _chatterbox.IsAvailable;

    /// <summary>The engine config asks for, whether or not it is currently healthy.</summary>
    public string PrimaryEngine => Primary.Engine;

    private ITextToSpeech Primary => _options.PrefersChatterbox && _chatterbox.IsAvailable ? _chatterbox : _piper;

    private ITextToSpeech Fallback => ReferenceEquals(Primary, _piper) ? _chatterbox : _piper;

    /// <summary>Health of both engines, for diagnostics and the panel's degraded indicator.</summary>
    public async Task<IReadOnlyList<VoiceHealth>> GetHealthAsync(CancellationToken ct)
    {
        var piper = await _piper.GetHealthAsync(ct);
        var chatterbox = await _chatterbox.GetHealthAsync(ct);
        return [piper, chatterbox];
    }

    /// <summary>
    /// Speaks a line, falling back when the primary can't deliver in time. Returns null only when no
    /// engine produced audio.
    /// </summary>
    public async Task<SpeechResult?> SpeakAsync(SpeechRequest request, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Text)) return null;

        var primary = Primary;
        var fallback = Fallback;

        // A cached render of the primary voice is instant and bypasses the deadline entirely — the
        // whole point of the cache for Urgent lines.
        var cached = await _cache.TryGetAsync(request, primary.Engine, ct);
        if (cached is not null)
            return new SpeechResult(cached, primary.Engine, Degraded: false, FromCache: true);

        var audio = await TryEngineAsync(primary, request, applyDeadline: true, ct);
        if (audio is not null)
        {
            await _cache.StoreAsync(request, primary.Engine, audio, ct);
            return new SpeechResult(audio, primary.Engine, Degraded: false, FromCache: false);
        }

        if (!fallback.IsAvailable) return null;

        _logger.LogWarning("Primary voice engine {Engine} could not speak; falling back to {Fallback}.",
            primary.Engine, fallback.Engine);

        // No deadline on the fallback: it is the last thing that can speak, so let it finish.
        var fallbackCached = await _cache.TryGetAsync(request, fallback.Engine, ct);
        if (fallbackCached is not null)
            return new SpeechResult(fallbackCached, fallback.Engine, Degraded: true, FromCache: true);

        var fallbackAudio = await TryEngineAsync(fallback, request, applyDeadline: false, ct);
        if (fallbackAudio is null) return null;

        await _cache.StoreAsync(request, fallback.Engine, fallbackAudio, ct);
        return new SpeechResult(fallbackAudio, fallback.Engine, Degraded: true, FromCache: false);
    }

    private async Task<byte[]?> TryEngineAsync(ITextToSpeech engine, SpeechRequest request, bool applyDeadline, CancellationToken ct)
    {
        if (!engine.IsAvailable) return null;

        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        if (applyDeadline)
            deadline.CancelAfter(TimeSpan.FromSeconds(Math.Max(0.1, _options.FirstAudioDeadlineSeconds)));

        var started = Stopwatch.GetTimestamp();
        try
        {
            return await engine.SynthesizeAsync(request, deadline.Token);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw; // The caller went away — not a synthesis failure.
        }
        catch (OperationCanceledException)
        {
            _logger.LogWarning("Voice engine {Engine} missed the {Deadline}s deadline (took {Elapsed}).",
                engine.Engine, _options.FirstAudioDeadlineSeconds, Stopwatch.GetElapsedTime(started));
            return null;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Voice engine {Engine} failed.", engine.Engine);
            return null;
        }
    }
}

/// <summary>Synthesized audio plus which engine actually produced it.</summary>
/// <param name="Degraded">True when the primary engine couldn't speak and the fallback covered.</param>
public sealed record SpeechResult(byte[] Audio, string Engine, bool Degraded, bool FromCache);
