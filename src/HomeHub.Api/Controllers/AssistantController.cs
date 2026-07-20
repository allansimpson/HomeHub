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

    public AssistantController(AssistantRouter router) => _router = router;

    [HttpPost("chat")]
    public async Task<ActionResult<AssistantChatResponse>> Chat(AssistantChatRequest req, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(req.Prompt) && string.IsNullOrEmpty(req.ImageBase64))
            return BadRequest("A prompt or an image is required.");

        var history = (req.History ?? [])
            .Where(m => !string.IsNullOrWhiteSpace(m.Role) && m.Text is not null)
            .Select(m => new ChatMessage(m.Role, m.Text))
            .ToList();

        var request = new AssistantRequest(history, req.Prompt ?? "", req.ImageBase64, req.ImageMediaType, req.Force);
        var result = await _router.RouteAsync(request, ct);

        return new AssistantChatResponse(result.Text, result.Origin.ToString(), result.Escalated, result.Model);
    }
}

/// <summary>Chat request from the client. History is prior turns; force optionally pins routing.</summary>
public record AssistantChatRequest(
    IReadOnlyList<ChatMessage>? History,
    string? Prompt,
    string? ImageBase64,
    string? ImageMediaType,
    string? Force);

/// <summary>Chat response: the answer plus which backend produced it.</summary>
public record AssistantChatResponse(string Text, string Origin, bool Escalated, string? Model);
