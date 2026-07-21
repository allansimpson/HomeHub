namespace HomeHub.Api.Ai;

using System.Net.Http.Headers;
using System.Net.Http.Json;
using Microsoft.Extensions.Options;

/// <summary>
/// Cloud assistant via OpenAI's Chat Completions API (text + vision). The API key stays
/// server-side. Only used behind <see cref="IAssistantProvider"/>; active when
/// <c>Ai:OpenAiApiKey</c> is configured. Image turns send the picture as a data URL content part.
/// </summary>
public sealed class OpenAIAssistantProvider : IAssistantProvider
{
    private readonly HttpClient _http;
    private readonly AiOptions _options;

    public OpenAIAssistantProvider(HttpClient http, IOptions<AiOptions> options)
    {
        _http = http;
        _options = options.Value;
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

        using var req = new HttpRequestMessage(HttpMethod.Post, _options.OpenAiBaseUrl.TrimEnd('/') + "/v1/chat/completions")
        {
            Content = JsonContent.Create(new { model = _options.OpenAiModel, messages }),
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _options.OpenAiApiKey);

        using var res = await _http.SendAsync(req, ct);
        if (!res.IsSuccessStatusCode)
        {
            // Surface OpenAI's own error body (e.g. "insufficient_quota") instead of a bare status —
            // the router catches this and degrades, and the reason lands in the logs. HttpRequestException
            // keeps the status code so callers can still distinguish a 429 if they care.
            var body = await res.Content.ReadAsStringAsync(ct);
            var detail = string.IsNullOrWhiteSpace(body) ? res.ReasonPhrase : body.Trim();
            if (detail?.Length > 500) detail = detail[..500];
            throw new HttpRequestException(
                $"OpenAI request failed: {(int)res.StatusCode} {res.StatusCode} — {detail}", null, res.StatusCode);
        }
        var reply = await res.Content.ReadFromJsonAsync<ChatResponse>(ct);
        var text = reply?.Choices?.FirstOrDefault()?.Message?.Content?.Trim() ?? "";
        return new ProviderResult(text, Model: _options.OpenAiModel);
    }

    private sealed record ChatResponse(List<Choice>? Choices);
    private sealed record Choice(ResponseMessage? Message);
    private sealed record ResponseMessage(string? Role, string? Content);
}
