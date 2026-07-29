namespace HomeHub.Api.Ai;

using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Options;

/// <summary>
/// Engine-independent cache of synthesized fixed phrases — alert preambles, timer chimes,
/// "reconnecting", mic on/off cues. Playback of a time-critical fixed phrase then costs zero
/// inference on any engine, which matters most exactly when inference is least available (a spoken
/// alert during GPU warm-up).
/// </summary>
/// <remarks>
/// Invalidation is a <b>startup hash check</b>, chosen over an explicit pre-render task: a deploy
/// step that must be remembered eventually isn't, and the failure is silent — the panel keeps
/// announcing alerts in the previous voice while everything else has moved on. The hash covers the
/// primary engine, the voice model / house voice, and the prosody parameters, so any of those
/// changing wipes the cache and the next utterance re-renders.
/// <para>Populated lazily on first use rather than pre-rendered from a fixed list, so a phrase that
/// changes wording never leaves a stale entry behind.</para>
/// </remarks>
public sealed class PhraseCache
{
    private const string StampFile = "voice-config.hash";

    private readonly string _directory;
    private readonly ILogger<PhraseCache> _logger;
    private readonly bool _enabled;

    public PhraseCache(IOptions<VoiceOptions> options, ILogger<PhraseCache> logger)
    {
        _logger = logger;
        var tts = options.Value.Tts;
        _directory = string.IsNullOrWhiteSpace(tts.CacheDirectory)
            ? Path.Combine(Path.GetTempPath(), "homehub-voice-cache")
            : tts.CacheDirectory!;

        _enabled = TryPrepare(ComputeConfigHash(tts));
    }

    /// <summary>Serves a cached render, or null on a miss.</summary>
    public async Task<byte[]?> TryGetAsync(SpeechRequest request, string engine, CancellationToken ct)
    {
        if (!_enabled || !request.AllowCache) return null;
        var path = PathFor(request, engine);
        try
        {
            return File.Exists(path) ? await File.ReadAllBytesAsync(path, ct) : null;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Phrase cache read failed; synthesizing instead.");
            return null;
        }
    }

    /// <summary>Stores a render. Best-effort — a cache write failure must never fail the utterance.</summary>
    public async Task StoreAsync(SpeechRequest request, string engine, byte[] audio, CancellationToken ct)
    {
        if (!_enabled || !request.AllowCache || audio.Length == 0) return;
        try
        {
            // Write-then-move so a crash mid-write can't leave a truncated WAV to be served forever.
            var path = PathFor(request, engine);
            var temp = path + ".tmp";
            await File.WriteAllBytesAsync(temp, audio, ct);
            File.Move(temp, path, overwrite: true);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Phrase cache write failed; continuing without caching.");
        }
    }

    private string PathFor(SpeechRequest request, string engine)
    {
        var key = $"{engine}|{request.Prosody}|{request.Text}";
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)));
        return Path.Combine(_directory, $"{hash}.wav");
    }

    /// <summary>Everything that changes how a phrase sounds. Any change invalidates the whole cache.</summary>
    private static string ComputeConfigHash(VoiceOptions.TtsOptions tts)
    {
        var sb = new StringBuilder()
            .Append(tts.Primary).Append('|')
            .Append(tts.VoiceModel).Append('|')
            .Append(tts.Chatterbox.Model).Append('|')
            .Append(tts.Chatterbox.Voice).Append('|')
            .Append(tts.Chatterbox.ResponseFormat);

        foreach (var (name, p) in tts.Chatterbox.Prosody.OrderBy(kv => kv.Key, StringComparer.Ordinal))
            sb.Append('|').Append(name).Append(':').Append(p.Exaggeration).Append(',').Append(p.Cfg).Append(',').Append(p.Speed);

        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sb.ToString())));
    }

    /// <summary>Creates the cache directory and clears it when the voice config has changed.</summary>
    private bool TryPrepare(string configHash)
    {
        try
        {
            Directory.CreateDirectory(_directory);
            var stampPath = Path.Combine(_directory, StampFile);
            var previous = File.Exists(stampPath) ? File.ReadAllText(stampPath) : null;

            if (!string.Equals(previous, configHash, StringComparison.Ordinal))
            {
                if (previous is not null)
                    _logger.LogInformation("Voice config changed; clearing the pre-rendered phrase cache.");

                foreach (var file in Directory.EnumerateFiles(_directory, "*.wav"))
                {
                    try { File.Delete(file); } catch { /* a locked file just re-renders */ }
                }
                File.WriteAllText(stampPath, configHash);
            }
            return true;
        }
        catch (Exception ex)
        {
            // A cache we can't prepare is a performance loss, not a failure — speak uncached.
            _logger.LogWarning(ex, "Phrase cache unavailable at {Directory}; speech will not be cached.", _directory);
            return false;
        }
    }
}
