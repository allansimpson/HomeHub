namespace HomeHub.Api.Ai;

using System.Diagnostics;
using Microsoft.Extensions.Options;

/// <summary>
/// Piper-backed TTS: shells out to the local Piper binary with a fixed voice model, feeding text on
/// stdin and reading the WAV it writes. One process per request — fine for a household kiosk's
/// occasional replies. The same binary/model the Pi voice bridge uses (e.g. en_US-norman-medium),
/// so the panel speaks in the same voice as the bridge.
/// </summary>
/// <remarks>
/// Ignores <see cref="Prosody"/> — Piper has no emotion controls. That is expected and is why the
/// prosody lives in the contract rather than in the engine: call sites are already annotated, so
/// Chatterbox picks the intent up for free. Piper stays the permanent fallback because it always
/// speaks: CPU-only, no warm-up, no VRAM.
/// </remarks>
public sealed class PiperTextToSpeech : ITextToSpeech
{
    private readonly VoiceOptions.TtsOptions _options;
    private readonly ILogger<PiperTextToSpeech> _logger;

    public PiperTextToSpeech(IOptions<VoiceOptions> options, ILogger<PiperTextToSpeech> logger)
    {
        _options = options.Value.Tts;
        _logger = logger;
    }

    public bool IsAvailable => _options.IsConfigured;

    public string Engine => "piper";

    public Task<VoiceHealth> GetHealthAsync(CancellationToken ct)
    {
        if (!IsAvailable)
            return Task.FromResult(new VoiceHealth(false, Engine, "Piper path / voice model not configured."));

        // Cheap and honest: a missing binary or model is the realistic failure, and it's a file check.
        if (!File.Exists(_options.PiperPath))
            return Task.FromResult(new VoiceHealth(false, Engine, $"Piper binary not found at {_options.PiperPath}."));
        if (!File.Exists(_options.VoiceModel))
            return Task.FromResult(new VoiceHealth(false, Engine, $"Voice model not found at {_options.VoiceModel}."));

        return Task.FromResult(new VoiceHealth(true, Engine, null));
    }

    public async Task<byte[]?> SynthesizeAsync(SpeechRequest request, CancellationToken ct)
    {
        if (!IsAvailable || string.IsNullOrWhiteSpace(request.Text)) return null;

        // Piper reads one utterance per stdin line — collapse newlines so multi-line replies stay one clip.
        var line = request.Text.ReplaceLineEndings(" ").Trim();
        var wavPath = Path.Combine(Path.GetTempPath(), $"homehub-tts-{Guid.NewGuid():N}.wav");
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = _options.PiperPath!,
                RedirectStandardInput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            psi.ArgumentList.Add("--model");
            psi.ArgumentList.Add(_options.VoiceModel!);
            psi.ArgumentList.Add("--output_file");
            psi.ArgumentList.Add(wavPath);

            using var proc = Process.Start(psi);
            if (proc is null) { _logger.LogError("Piper failed to start ({Path}).", _options.PiperPath); return null; }

            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(Math.Max(1, _options.TimeoutSeconds)));

            await proc.StandardInput.WriteLineAsync(line);
            proc.StandardInput.Close();
            await proc.WaitForExitAsync(timeout.Token);

            if (proc.ExitCode != 0)
            {
                var err = await proc.StandardError.ReadToEndAsync(ct);
                _logger.LogError("Piper exited {Code}: {Error}", proc.ExitCode, err.Length > 500 ? err[..500] : err);
                return null;
            }
            return File.Exists(wavPath) ? await File.ReadAllBytesAsync(wavPath, ct) : null;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Piper synthesis failed.");
            return null;
        }
        finally
        {
            try { if (File.Exists(wavPath)) File.Delete(wavPath); } catch { /* temp cleanup best-effort */ }
        }
    }
}
