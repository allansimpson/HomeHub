namespace HomeHub.Api.Controllers;

using HomeHub.Api.Ai;
using Microsoft.AspNetCore.Mvc;

/// <summary>
/// The in-app assistant. One endpoint handles text and image turns; the hybrid router decides
/// local vs cloud and the response carries the origin for the LOCAL/CLOUD indicator. Session
/// context is passed by the client each turn (session-only; nothing persisted server-side). No
/// AI keys or vendor specifics reach the client.
/// </summary>
[ApiController]
[Route("api/[controller]")]
public class AssistantController : ControllerBase
{
    private readonly AssistantRouter _router;
    private readonly AssistantActions _actions;

    public AssistantController(AssistantRouter router, AssistantActions actions)
    {
        _router = router;
        _actions = actions;
    }

    [HttpPost("chat")]
    public async Task<ActionResult<AssistantChatResponse>> Chat(AssistantChatRequest req, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(req.Prompt) && string.IsNullOrEmpty(req.ImageBase64))
            return BadRequest("A prompt or an image is required.");

        // Actions-first: a text turn that is a recognized command (e.g. "add carrots to the grocery
        // list") is executed directly — deterministic, instant, works without a model. Anything else
        // routes to the LLM (which can still call tools for flexible phrasing when cloud is available).
        if (!string.IsNullOrWhiteSpace(req.Prompt) && string.IsNullOrEmpty(req.ImageBase64))
        {
            var handled = await _actions.TryHandleCommandAsync(req.Prompt, req.ProfileId, ct);
            if (handled is { } outcome)
                return new AssistantChatResponse(outcome.Message, "Local", false, "actions", outcome.Action);
        }

        var history = (req.History ?? [])
            .Where(m => !string.IsNullOrWhiteSpace(m.Role) && m.Text is not null)
            .Select(m => new ChatMessage(m.Role, m.Text))
            .ToList();

        var request = new AssistantRequest(history, req.Prompt ?? "", req.ImageBase64, req.ImageMediaType, req.Force, req.ProfileId);
        var result = await _router.RouteAsync(request, ct);

        return new AssistantChatResponse(result.Text, result.Origin.ToString(), result.Escalated, result.Model, result.Action);
    }
}

/// <summary>Chat request from the client. History is prior turns; force optionally pins routing;
/// profileId scopes any in-app action to the signed-in member.</summary>
public record AssistantChatRequest(
    IReadOnlyList<ChatMessage>? History,
    string? Prompt,
    string? ImageBase64,
    string? ImageMediaType,
    string? Force,
    int? ProfileId = null);

/// <summary>Chat response: the answer, which backend produced it, and any in-app action taken.</summary>
public record AssistantChatResponse(string Text, string Origin, bool Escalated, string? Model, string? Action = null);
