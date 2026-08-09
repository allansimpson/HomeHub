namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

/// <summary>
/// Stage A4 — the MCP seam: the house exposed as tools an agent can call (ai-assistant.md).
///
/// These go over the wire as real JSON-RPC rather than through the SDK's client, because the
/// contract that matters here is the one Hermes will actually speak to: an HTTP endpoint, a bearer
/// token, and a tool list. A client library agreeing with the server it ships alongside would prove
/// less.
/// </summary>
public class McpServerTests
{
    private const string Key = "test-mcp-key";

    private static HubAppFactory Configured() => new() { McpApiKey = Key };

    private static HttpClient Authed(HubAppFactory app)
    {
        var client = app.CreateSeededClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", Key);
        client.DefaultRequestHeaders.Accept.Clear();
        client.DefaultRequestHeaders.Accept.ParseAdd("application/json, text/event-stream");
        return client;
    }

    private static HttpContent Rpc(string method, object? @params = null) =>
        JsonContent.Create(new
        {
            jsonrpc = "2.0",
            id = 1,
            method,
            @params = @params ?? new { },
        });

    /// <summary>
    /// Streamable HTTP may answer as a single JSON body or as an SSE stream depending on negotiation;
    /// both carry the same JSON-RPC envelope, so unwrap either into the `result` element.
    /// </summary>
    private static async Task<JsonElement> ResultOf(HttpResponseMessage res)
    {
        var body = await res.Content.ReadAsStringAsync();
        var json = body.TrimStart().StartsWith('{')
            ? body
            : string.Concat(body
                .Split('\n')
                .Where(l => l.StartsWith("data:", StringComparison.Ordinal))
                .Select(l => l["data:".Length..].Trim()));

        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.GetProperty("result").Clone();
    }

    [Fact]
    public async Task The_seam_is_unmapped_unless_a_key_is_configured()
    {
        // The default factory carries no key — and neither does a fresh install. An MCP endpoint
        // that exists before anyone asked for one is a write surface nobody decided to open.
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsync("/mcp", Rpc("tools/list"));

        // 405 rather than 404 because the SPA fallback claims every unmatched *GET* path for
        // client-side routing, so routing reports the path as known but the method as not. Either
        // way no MCP transport is mounted and no tool list exists to leak — which is the assertion
        // that matters.
        Assert.Equal(HttpStatusCode.MethodNotAllowed, res.StatusCode);
    }

    [Fact]
    public async Task A_request_without_the_bearer_token_is_rejected()
    {
        using var app = Configured();
        var client = app.CreateSeededClient();

        var res = await client.PostAsync("/mcp", Rpc("tools/list"));

        // 401 before the transport, so an unauthenticated caller never learns the tool list.
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    [Fact]
    public async Task A_request_with_the_wrong_bearer_token_is_rejected()
    {
        using var app = Configured();
        var client = app.CreateSeededClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "not-the-key");

        var res = await client.PostAsync("/mcp", Rpc("tools/list"));

        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    [Fact]
    public async Task Tools_list_advertises_the_house_surface()
    {
        using var app = Configured();
        var client = Authed(app);

        var res = await client.PostAsync("/mcp", Rpc("tools/list"));
        res.EnsureSuccessStatusCode();

        var names = ResultOfNames(await ResultOf(res));

        // The surface is deliberately short (ai-assistant.md): tool-calling accuracy falls off as it
        // grows, and the model driving it may be small. If this assertion starts failing because
        // tools were added, that is the moment to ask whether they earn their place.
        Assert.Equal(
            new[] { "add_todo", "get_calendar", "get_climate_zones", "get_sensor_readings", "set_climate_mode", "set_climate_setpoint" },
            names.Order().ToArray());
    }

    [Fact]
    public async Task Write_tools_take_ids_not_names()
    {
        using var app = Configured();
        var client = Authed(app);

        var res = await client.PostAsync("/mcp", Rpc("tools/list"));
        var setpoint = (await ResultOf(res)).GetProperty("tools").EnumerateArray()
            .Single(t => t.GetProperty("name").GetString() == "set_climate_setpoint");

        var props = setpoint.GetProperty("inputSchema").GetProperty("properties");

        // "List, then act by id." A name here would invite the agent to guess at a zone rather than
        // read one — and the DI-injected provider must not have leaked into the schema.
        Assert.True(props.TryGetProperty("zoneId", out _));
        Assert.True(props.TryGetProperty("setPointF", out _));
        Assert.False(props.TryGetProperty("climate", out _));
        Assert.False(props.TryGetProperty("ct", out _));
    }

    [Fact]
    public async Task Reading_the_climate_zones_returns_the_seeded_house()
    {
        using var app = Configured();
        var client = Authed(app);

        var res = await client.PostAsync("/mcp", Rpc("tools/call", new { name = "get_climate_zones", arguments = new { } }));
        res.EnsureSuccessStatusCode();

        var result = await ResultOf(res);
        var text = result.GetProperty("content")[0].GetProperty("text").GetString();

        Assert.False(result.TryGetProperty("isError", out var e) && e.GetBoolean());
        Assert.NotNull(text);
    }

    [Fact]
    public async Task A_set_point_outside_the_safe_range_is_refused_rather_than_applied()
    {
        using var app = Configured();
        var client = Authed(app);

        var res = await client.PostAsync("/mcp", Rpc("tools/call",
            new { name = "set_climate_setpoint", arguments = new { zoneId = 1, setPointF = 250 } }));
        res.EnsureSuccessStatusCode();

        var text = (await ResultOf(res)).GetProperty("content")[0].GetProperty("text").GetString();

        // A tool call is model output. 250°F must come back as a refusal, not a thermostat command.
        Assert.Contains("outside the allowed range", text);
    }

    [Fact]
    public async Task Adding_a_todo_with_nobody_signed_in_refuses_rather_than_guessing()
    {
        using var app = Configured();
        var client = Authed(app);

        var res = await client.PostAsync("/mcp", Rpc("tools/call",
            new { name = "add_todo", arguments = new { list = "grocery", item = "carrots" } }));
        res.EnsureSuccessStatusCode();

        var text = (await ResultOf(res)).GetProperty("content")[0].GetProperty("text").GetString();

        // The seed leaves ActiveProfileId null. A to-do belongs to a person, and the agent has no
        // session of its own — filing it under a guessed profile would be worse than not filing it.
        Assert.Contains("signed in", text);
    }

    private static string[] ResultOfNames(JsonElement result) =>
        result.GetProperty("tools").EnumerateArray()
            .Select(t => t.GetProperty("name").GetString()!)
            .ToArray();
}
