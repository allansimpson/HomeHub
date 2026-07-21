namespace HomeHub.Api.Ai;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

/// <summary>
/// Routes every assistant request between the local (on-server) and cloud providers, per
/// PROJECT.md §6: task-based routing first (tunable hints), then a confidence fallback
/// that escalates a weak local answer to cloud. Falls back to the built-in simulated assistant
/// when nothing is configured. Everything downstream depends on this, not on a vendor.
/// </summary>
public sealed class AssistantRouter
{
    private static readonly string[] RefusalHints =
        ["i don't know", "i do not know", "i'm not sure", "not sure", "as an ai", "cannot help", "can't help", "unable to"];

    /// <summary>DI keys distinguishing the three providers behind the seam.</summary>
    public const string LocalKey = "local";
    public const string CloudKey = "cloud";
    public const string SimulatedKey = "simulated";

    private readonly IAssistantProvider _local;
    private readonly IAssistantProvider _cloud;
    private readonly IAssistantProvider _simulated;
    private readonly AiOptions.RoutingOptions _routing;
    private readonly ILogger<AssistantRouter> _logger;

    public AssistantRouter(
        [FromKeyedServices(LocalKey)] IAssistantProvider local,
        [FromKeyedServices(CloudKey)] IAssistantProvider cloud,
        [FromKeyedServices(SimulatedKey)] IAssistantProvider simulated,
        IOptions<AiOptions> options,
        ILogger<AssistantRouter> logger)
    {
        _local = local;
        _cloud = cloud;
        _simulated = simulated;
        _routing = options.Value.Routing;
        _logger = logger;
    }

    public async Task<AssistantResult> RouteAsync(AssistantRequest request, CancellationToken ct)
    {
        var origin = Decide(request);

        // Cloud-routed: cloud → local (text only) → simulated. A runtime cloud failure — an
        // exhausted-quota 429, an outage, a network blip — degrades instead of crashing the turn.
        if (origin == AssistantOrigin.Cloud)
        {
            if (_cloud.IsAvailable)
            {
                var cloud = await TryCompleteAsync(_cloud, request, ct);
                if (cloud is { } c) return AssistantResult.From(c, AssistantOrigin.Cloud, escalated: false);
            }
            if (!request.HasImage && _local.IsAvailable)
            {
                var local = await TryCompleteAsync(_local, request, ct);   // text-only degrade
                if (local is { } l) return AssistantResult.From(l, AssistantOrigin.Local, escalated: false);
            }
            var sim = await _simulated.CompleteAsync(request, ct);          // canned images + always-available last resort
            return AssistantResult.From(sim, AssistantOrigin.Local, escalated: false);
        }

        // Routed local.
        if (_local.IsAvailable)
        {
            var localResult = await TryCompleteAsync(_local, request, ct);
            if (localResult is { } lr)
            {
                if (IsLowConfidence(lr) && _cloud.IsAvailable)
                {
                    _logger.LogInformation("Escalating low-confidence local answer to cloud.");
                    var escalated = await TryCompleteAsync(_cloud, request, ct);
                    if (escalated is { } er) return AssistantResult.From(er, AssistantOrigin.Cloud, escalated: true);
                    _logger.LogWarning("Cloud escalation failed; returning the local answer.");
                }
                return AssistantResult.From(lr, AssistantOrigin.Local, escalated: false);
            }
            // Local failed outright — degrade to cloud/simulated below.
        }

        // No local model (or it just failed): cloud if available, else the simulated on-device assistant.
        if (_cloud.IsAvailable)
        {
            var cloudResult = await TryCompleteAsync(_cloud, request, ct);
            if (cloudResult is { } cr) return AssistantResult.From(cr, AssistantOrigin.Cloud, escalated: false);
        }
        var simulated = await _simulated.CompleteAsync(request, ct);
        return AssistantResult.From(simulated, AssistantOrigin.Local, escalated: false);
    }

    /// <summary>
    /// Runs a provider, returning <c>null</c> instead of throwing when it fails at runtime, so the
    /// router can fall back to the next option (cloud quota 429, cloud/local outage, model down, …).
    /// Cancellation still propagates.
    /// </summary>
    private async Task<ProviderResult?> TryCompleteAsync(IAssistantProvider provider, AssistantRequest request, CancellationToken ct)
    {
        try
        {
            return await provider.CompleteAsync(request, ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Assistant provider {Origin} failed; falling back.", provider.Origin);
            return null;
        }
    }

    private AssistantOrigin Decide(AssistantRequest request)
    {
        if (string.Equals(request.ForceOrigin, "local", StringComparison.OrdinalIgnoreCase)) return AssistantOrigin.Local;
        if (string.Equals(request.ForceOrigin, "cloud", StringComparison.OrdinalIgnoreCase)) return AssistantOrigin.Cloud;

        // Images go to cloud unless a local VLM is available (local is text-only by default).
        if (request.HasImage) return AssistantOrigin.Cloud;

        var p = request.Prompt.ToLowerInvariant();
        var localScore = _routing.LocalHints.Count(h => p.Contains(h));
        var cloudScore = _routing.CloudHints.Count(h => p.Contains(h));
        if (cloudScore > localScore) return AssistantOrigin.Cloud;
        if (localScore > cloudScore) return AssistantOrigin.Local;
        return _routing.DefaultOrigin.Equals("local", StringComparison.OrdinalIgnoreCase)
            ? AssistantOrigin.Local
            : AssistantOrigin.Cloud;
    }

    private bool IsLowConfidence(ProviderResult result)
    {
        if (string.IsNullOrWhiteSpace(result.Text)) return true;
        if (result.Text.Trim().Length < _routing.MinConfidentLength) return true;
        var lower = result.Text.ToLowerInvariant();
        if (RefusalHints.Any(lower.Contains)) return true;
        if (result.Confidence is { } c && c < 0.4) return true;
        return false;
    }
}
