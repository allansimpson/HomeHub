namespace HomeHub.Api.Ai;

/// <summary>Which backend answered a turn. Surfaced to the UI as the LOCAL / CLOUD indicator.</summary>
public enum AssistantOrigin
{
    Local = 0,
    Cloud = 1,
}

/// <summary>One prior turn in the conversation. Role is "user" or "assistant".</summary>
public record ChatMessage(string Role, string Text);

/// <summary>
/// A provider-agnostic assistant request: prior turns + the new prompt, an optional uploaded
/// image, and an optional origin override ("local"/"cloud"). No vendor specifics.
/// </summary>
public record AssistantRequest(
    IReadOnlyList<ChatMessage> History,
    string Prompt,
    string? ImageBase64,
    string? ImageMediaType,
    string? ForceOrigin)
{
    public bool HasImage => !string.IsNullOrEmpty(ImageBase64);
}

/// <summary>What a single provider returns (its origin is known from which provider ran).</summary>
public record ProviderResult(string Text, double? Confidence = null, string? Model = null);

/// <summary>The router's final answer, carrying the origin and whether it escalated local→cloud.</summary>
public record AssistantResult(string Text, AssistantOrigin Origin, bool Escalated, string? Model)
{
    public static AssistantResult From(ProviderResult r, AssistantOrigin origin, bool escalated) =>
        new(r.Text, origin, escalated, r.Model);
}
