namespace HomeHub.Api.Ai;

/// <summary>
/// The AI seam: complete an assistant turn. Each implementation is a fixed <see cref="Origin"/>
/// (local server model vs cloud). The <see cref="AssistantRouter"/> sits in front of these;
/// controllers/UI depend on the router or this seam, never a vendor SDK.
/// </summary>
public interface IAssistantProvider
{
    AssistantOrigin Origin { get; }

    /// <summary>Whether this provider is configured/usable right now.</summary>
    bool IsAvailable { get; }

    /// <summary>Whether this provider can analyze an attached image.</summary>
    bool SupportsImages { get; }

    Task<ProviderResult> CompleteAsync(AssistantRequest request, CancellationToken ct);
}
