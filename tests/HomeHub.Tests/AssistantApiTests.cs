namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Controllers;

/// <summary>
/// Stage 7 assistant endpoint. With no AI keys configured (the test environment), the router
/// degrades to the built-in simulated on-device assistant — so a turn still returns a coherent
/// answer tagged Local, proving the wiring end-to-end.
/// </summary>
public class AssistantApiTests
{
    [Fact]
    public async Task Chat_returns_a_local_tagged_answer_via_the_fallback()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/assistant/chat",
            new AssistantChatRequest(null, "How many teaspoons in a tablespoon?", null, null, null));
        res.EnsureSuccessStatusCode();
        var body = await res.Content.ReadFromJsonAsync<AssistantChatResponse>();

        Assert.NotNull(body);
        Assert.Equal("Local", body!.Origin);
        Assert.Contains("3 teaspoons", body.Text);
    }

    [Fact]
    public async Task Chat_requires_a_prompt_or_image()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/assistant/chat",
            new AssistantChatRequest(null, "", null, null, null));

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }
}
