namespace HomeHub.Api.Ai;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

/// <summary>
/// Fronts the two <see cref="ISpeechToText"/> engines (local faster-whisper + cloud Whisper) the way
/// <see cref="AssistantRouter"/> fronts the assistant providers: local-first by default, degrading to
/// cloud on failure when <c>Voice:Stt:AllowCloudFallback</c> allows it. Returns the engine that
/// actually ran so the LOCAL/CLOUD indicator stays honest after a fallback. Voice/UI depend on this,
/// not a vendor.
/// </summary>
public sealed class SttRouter
{
    /// <summary>DI keys distinguishing the two STT engines behind the seam.</summary>
    public const string LocalKey = "stt-local";
    public const string CloudKey = "stt-cloud";

    private readonly ISpeechToText _local;
    private readonly ISpeechToText _cloud;
    private readonly VoiceOptions.SttOptions _stt;
    private readonly ILogger<SttRouter> _logger;

    public SttRouter(
        [FromKeyedServices(LocalKey)] ISpeechToText local,
        [FromKeyedServices(CloudKey)] ISpeechToText cloud,
        IOptions<VoiceOptions> options,
        ILogger<SttRouter> logger)
    {
        _local = local;
        _cloud = cloud;
        _stt = options.Value.Stt;
        _logger = logger;
    }

    private bool PrefersCloud => string.Equals(_stt.Prefer, "cloud", StringComparison.OrdinalIgnoreCase);

    /// <summary>Cloud may run only as the explicit preference or when fallback is allowed (privacy toggle).</summary>
    private bool CloudUsable => _cloud.IsAvailable && (_stt.AllowCloudFallback || PrefersCloud);

    public bool LocalAvailable => _local.IsAvailable;
    public bool CloudAvailable => _cloud.IsAvailable;

    /// <summary>Whether any engine can actually run under the current fallback policy.</summary>
    public bool AnyAvailable => _local.IsAvailable || CloudUsable;

    public async Task<SttResult> TranscribeAsync(Stream audio, string fileName, string contentType, CancellationToken ct)
    {
        // The incoming stream is forward-only, but a fallback needs the bytes again — buffer once.
        // Bounded by the controller's RequestSizeLimit, so holding it in memory is safe.
        byte[] bytes;
        await using (var buffer = new MemoryStream())
        {
            await audio.CopyToAsync(buffer, ct);
            bytes = buffer.ToArray();
        }

        var order = PrefersCloud
            ? new[] { (Provider: _cloud, Engine: SttEngine.Cloud), (Provider: _local, Engine: SttEngine.Local) }
            : new[] { (Provider: _local, Engine: SttEngine.Local), (Provider: _cloud, Engine: SttEngine.Cloud) };

        var attempted = false;
        foreach (var (provider, engine) in order)
        {
            if (!provider.IsAvailable) continue;
            if (engine == SttEngine.Cloud && !CloudUsable) continue;

            attempted = true;
            try
            {
                using var stream = new MemoryStream(bytes, writable: false);
                var text = await provider.TranscribeAsync(stream, fileName, contentType, ct);
                return new SttResult(text, engine);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "STT engine {Engine} failed; trying the next option.", engine);
            }
        }

        throw new InvalidOperationException(
            attempted ? "All configured speech-to-text engines failed." : "No speech-to-text engine is available.");
    }
}
