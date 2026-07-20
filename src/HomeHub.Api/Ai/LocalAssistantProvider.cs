namespace HomeHub.Api.Ai;

using System.Net.Http.Json;
using Microsoft.Extensions.Options;

/// <summary>
/// Local model on the home server via an Ollama-compatible chat endpoint (<c>/api/chat</c>).
/// Keeps routine/private requests on the LAN. Text-only by default (no image support unless the
/// local model is a VLM). Only used behind <see cref="IAssistantProvider"/>; active when
/// <c>Ai:LocalEndpoint</c> is configured.
/// </summary>
public sealed class LocalAssistantProvider : IAssistantProvider
{
    private readonly HttpClient _http;
    private readonly AiOptions _options;

    public LocalAssistantProvider(HttpClient http, IOptions<AiOptions> options)
    {
        _http = http;
        _options = options.Value;
    }

    public AssistantOrigin Origin => AssistantOrigin.Local;
    public bool IsAvailable => _options.LocalConfigured;
    public bool SupportsImages => false;

    public async Task<ProviderResult> CompleteAsync(AssistantRequest request, CancellationToken ct)
    {
        var messages = request.History
            .Select(m => new { role = m.Role, content = m.Text })
            .Append(new { role = "user", content = request.Prompt })
            .ToList();

        var url = _options.LocalEndpoint!.TrimEnd('/') + "/api/chat";
        var body = new { model = _options.LocalModel, messages, stream = false };
        using var res = await _http.PostAsJsonAsync(url, body, ct);
        res.EnsureSuccessStatusCode();
        var reply = await res.Content.ReadFromJsonAsync<OllamaChatResponse>(ct);
        return new ProviderResult(reply?.Message?.Content?.Trim() ?? "", Model: _options.LocalModel);
    }

    private sealed record OllamaChatResponse(OllamaMessage? Message);
    private sealed record OllamaMessage(string? Role, string? Content);
}
