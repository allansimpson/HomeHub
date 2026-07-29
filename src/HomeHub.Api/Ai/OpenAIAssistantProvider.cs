namespace HomeHub.Api.Ai;

using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;

/// <summary>
/// Cloud assistant via OpenAI's Chat Completions API (text + vision + tool calling). The API key
/// stays server-side. Only used behind <see cref="IAssistantProvider"/>; active when
/// <c>Ai:OpenAiApiKey</c> is configured. When the model calls a tool (e.g. add_task) it is executed
/// via <see cref="AssistantActions"/> and the result fed back for a natural confirmation.
/// </summary>
public sealed class OpenAIAssistantProvider : IAssistantProvider
{
    private const int MaxToolRounds = 3;

    private readonly HttpClient _http;
    private readonly AiOptions _options;
    private readonly AssistantActions _actions;

    public OpenAIAssistantProvider(HttpClient http, IOptions<AiOptions> options, AssistantActions actions)
    {
        _http = http;
        _options = options.Value;
        _actions = actions;
    }

    public AssistantOrigin Origin => AssistantOrigin.Cloud;
    public bool IsAvailable => _options.CloudConfigured;
    public bool SupportsImages => true;

    public async Task<ProviderResult> CompleteAsync(AssistantRequest request, CancellationToken ct)
    {
        var messages = new List<object>();
        foreach (var m in request.History)
            messages.Add(new { role = m.Role, content = m.Text });

        // The new user turn: plain text, or text + image content parts.
        if (request.HasImage)
        {
            messages.Add(new
            {
                role = "user",
                content = new object[]
                {
                    new { type = "text", text = string.IsNullOrWhiteSpace(request.Prompt) ? "What's in this image?" : request.Prompt },
                    new { type = "image_url", image_url = new { url = $"data:{request.ImageMediaType ?? "image/jpeg"};base64,{request.ImageBase64}" } },
                },
            });
        }
        else
        {
            messages.Add(new { role = "user", content = request.Prompt });
        }

        // Tool-call loop: the model may ask to run an action; we execute it, feed the result back,
        // and let it produce the final natural-language reply. Capped so it can't spin.
        string? action = null;
        for (var round = 0; round < MaxToolRounds; round++)
        {
            var reply = await SendAsync(messages, ct);
            var message = reply?.Choices?.FirstOrDefault()?.Message;
            var toolCalls = message?.ToolCalls;

            if (toolCalls is null || toolCalls.Count == 0)
                return new ProviderResult(message?.Content?.Trim() ?? "", Model: _options.OpenAiModel, Action: action);

            // Echo the assistant's tool-call message back, then append each tool result.
            messages.Add(new
            {
                role = "assistant",
                content = (string?)null,
                tool_calls = toolCalls
                    .Where(tc => tc.Function is not null)
                    .Select(tc => new { id = tc.Id, type = "function", function = new { name = tc.Function!.Name, arguments = tc.Function.Arguments } })
                    .ToArray(),
            });
            foreach (var tc in toolCalls)
            {
                var outcome = await _actions.DispatchToolAsync(tc.Function?.Name ?? "", tc.Function?.Arguments ?? "{}", request.ProfileId, ct);
                if (outcome.Action is not null) action = outcome.Action;
                messages.Add(new { role = "tool", tool_call_id = tc.Id, content = outcome.Message });
            }
        }
        return new ProviderResult("Done.", Model: _options.OpenAiModel, Action: action);
    }

    private async Task<ChatResponse?> SendAsync(List<object> messages, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, _options.OpenAiBaseUrl.TrimEnd('/') + "/v1/chat/completions")
        {
            Content = JsonContent.Create(new { model = _options.OpenAiModel, messages, tools = AssistantActions.ToolCatalog }),
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _options.OpenAiApiKey);

        using var res = await _http.SendAsync(req, ct);
        if (!res.IsSuccessStatusCode)
        {
            // Surface OpenAI's own error body (e.g. "insufficient_quota") instead of a bare status —
            // the router catches this and degrades, and the reason lands in the logs.
            var body = await res.Content.ReadAsStringAsync(ct);
            var detail = string.IsNullOrWhiteSpace(body) ? res.ReasonPhrase : body.Trim();
            if (detail?.Length > 500) detail = detail[..500];
            throw new HttpRequestException(
                $"OpenAI request failed: {(int)res.StatusCode} {res.StatusCode} — {detail}", null, res.StatusCode);
        }
        return await res.Content.ReadFromJsonAsync<ChatResponse>(ct);
    }

    private sealed record ChatResponse(List<Choice>? Choices);
    private sealed record Choice(ResponseMessage? Message);
    private sealed record ResponseMessage(
        string? Role,
        string? Content,
        [property: JsonPropertyName("tool_calls")] List<ToolCall>? ToolCalls);
    private sealed record ToolCall(string? Id, string? Type, FunctionCall? Function);
    private sealed record FunctionCall(string? Name, string? Arguments);
}
