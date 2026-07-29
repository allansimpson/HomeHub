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
    string? ForceOrigin,
    /// <summary>The signed-in profile, so tool actions (add a task, …) run as that member.</summary>
    int? ProfileId = null)
{
    public bool HasImage => !string.IsNullOrEmpty(ImageBase64);
}

/// <summary>What a single provider returns (its origin is known from which provider ran).
/// <see cref="Action"/> is set (e.g. "task") when the turn performed an in-app action, so the UI
/// can refresh the affected screen.</summary>
public record ProviderResult(string Text, double? Confidence = null, string? Model = null, string? Action = null);

/// <summary>The router's final answer, carrying the origin, whether it escalated, and any action taken.</summary>
public record AssistantResult(string Text, AssistantOrigin Origin, bool Escalated, string? Model, string? Action)
{
    public static AssistantResult From(ProviderResult r, AssistantOrigin origin, bool escalated) =>
        new(r.Text, origin, escalated, r.Model, r.Action);
}
