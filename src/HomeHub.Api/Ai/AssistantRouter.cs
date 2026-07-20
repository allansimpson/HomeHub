namespace HomeHub.Api.Ai;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

/// <summary>
/// Routes every assistant request between the local (on-server) and cloud providers, per
/// hybrid-ai-routing.md: task-based routing first (tunable hints), then a confidence fallback
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

        if (origin == AssistantOrigin.Cloud)
        {
            var provider = PickForCloud(request);
            var result = await provider.CompleteAsync(request, ct);
            return AssistantResult.From(result, provider.Origin, escalated: false);
        }

        // Routed local.
        if (_local.IsAvailable)
        {
            var localResult = await _local.CompleteAsync(request, ct);
            if (IsLowConfidence(localResult) && _cloud.IsAvailable)
            {
                _logger.LogInformation("Escalating low-confidence local answer to cloud.");
                var cloudResult = await _cloud.CompleteAsync(request, ct);
                return AssistantResult.From(cloudResult, AssistantOrigin.Cloud, escalated: true);
            }
            return AssistantResult.From(localResult, AssistantOrigin.Local, escalated: false);
        }

        // No local model configured: use cloud if available, else the simulated on-device assistant.
        if (_cloud.IsAvailable)
        {
            var cloudResult = await _cloud.CompleteAsync(request, ct);
            return AssistantResult.From(cloudResult, AssistantOrigin.Cloud, escalated: false);
        }
        var sim = await _simulated.CompleteAsync(request, ct);
        return AssistantResult.From(sim, AssistantOrigin.Local, escalated: false);
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

    /// <summary>Pick the provider for a cloud-routed request, degrading gracefully.</summary>
    private IAssistantProvider PickForCloud(AssistantRequest request)
    {
        if (_cloud.IsAvailable) return _cloud;
        if (request.HasImage) return _simulated;      // supports images (canned) when no cloud
        if (_local.IsAvailable) return _local;         // text-only degrade
        return _simulated;
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
