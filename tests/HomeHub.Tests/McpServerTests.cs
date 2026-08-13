namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using HomeHub.Api.Mcp;
using Microsoft.AspNetCore.Mvc.Testing;

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
    private const string BarnabyKey = "test-barnaby-key";

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

    /// <summary>
    /// What an agent actually arrives as: a bearer token, and nothing else.
    ///
    /// <para>
    /// Every other test in this file signs in first, because <see cref="HubAppFactory.CreateSeededClient"/>
    /// is the convenient one — and a signed-in client carries a household cookie. That cookie
    /// satisfied the app's fallback authorisation policy, which the MCP endpoints are subject to
    /// like any other endpoint that states no policy of its own, so the suite never noticed that
    /// reaching the transport required a session as well as a token. Hermes has no session. It has a
    /// token, which is the entire point of issuing it one.
    /// </para>
    /// </summary>
    [Fact]
    public async Task An_agent_holding_only_its_bearer_token_reaches_the_transport()
    {
        using var app = new HubAppFactory
        {
            McpCredentials = new() { ["barnaby"] = (BarnabyKey, [.. McpMethods.All]) },
        };

        // Redirects unfollowed, so a bounce towards the SPA shows up as a 3xx here rather than
        // arriving disguised as a successful request for a page nobody asked for.
        var client = app.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", BarnabyKey);
        client.DefaultRequestHeaders.Accept.Clear();
        client.DefaultRequestHeaders.Accept.ParseAdd("application/json, text/event-stream");

        var init = await client.PostAsync("/mcp", Rpc("initialize", new
        {
            protocolVersion = "2024-11-05",
            capabilities = new { },
            clientInfo = new { name = "hermes", version = "0.20.0" },
        }));

        Assert.False(init.StatusCode is HttpStatusCode.Redirect or HttpStatusCode.MovedPermanently,
            "the MCP endpoint redirected an agent, which sends it to the SPA rather than the transport.");
        Assert.Equal(HttpStatusCode.OK, init.StatusCode);

        // The exact failure Hermes reports at startup: "returned Content-Type 'text/html', not an MCP
        // response". HTML here means the request fell past the transport into the SPA fallback.
        var mediaType = init.Content.Headers.ContentType?.MediaType;
        Assert.True(mediaType is "application/json" or "text/event-stream",
            $"initialize answered '{mediaType}', which is not an MCP response.");

        // Streamable HTTP may hand back a session to carry; when it does, the next call must use it.
        var session = init.Headers.TryGetValues("Mcp-Session-Id", out var ids) ? ids.FirstOrDefault() : null;
        var listing = new HttpRequestMessage(HttpMethod.Post, "/mcp") { Content = Rpc("tools/list") };
        if (session is not null) listing.Headers.Add("Mcp-Session-Id", session);

        var res = await client.SendAsync(listing);
        res.EnsureSuccessStatusCode();
        Assert.NotEqual("text/html", res.Content.Headers.ContentType?.MediaType);

        Assert.Equal(
            new[] { "add_todo", "get_calendar", "get_climate_zones", "get_sensor_readings", "set_climate_mode", "set_climate_setpoint" },
            ResultOfNames(await ResultOf(res)).Order().ToArray());

        // And the door is still the token. Reaching the transport without a session must not mean
        // reaching it without a credential.
        var refused = await app.CreateAnonymousClient().PostAsync("/mcp", Rpc("tools/list"));
        Assert.Equal(HttpStatusCode.Unauthorized, refused.StatusCode);
    }

    /// <summary>
    /// The request that actually produced the reported failure.
    ///
    /// <para>
    /// The transport is stateless — there is no server-to-client stream to hold open — so the SDK
    /// maps no GET at this route. An unmapped GET is then claimed by the SPA fallback, and an agent
    /// that probes the endpoint before speaking JSON-RPC is handed the HTML shell and concludes the
    /// URL "most likely points at a web page rather than an MCP endpoint". That is the exact wording
    /// Barnaby logged at startup, and no other request shape on this host returns <c>text/html</c>.
    /// </para>
    ///
    /// <para>
    /// 405 is what the Streamable HTTP spec has a server without an SSE stream answer GET with, and
    /// clients are required to handle it — so the agent moves on to POST rather than giving up on the
    /// endpoint entirely.
    /// </para>
    /// </summary>
    [Fact]
    public async Task Validating_the_endpoint_with_GET_is_answered_as_MCP_not_as_the_spa()
    {
        using var app = new HubAppFactory
        {
            McpCredentials = new() { ["barnaby"] = (BarnabyKey, [.. McpMethods.All]) },
        };

        var client = app.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", BarnabyKey);
        client.DefaultRequestHeaders.Accept.Clear();
        client.DefaultRequestHeaders.Accept.ParseAdd("text/event-stream");

        var res = await client.GetAsync("/mcp");

        Assert.NotEqual("text/html", res.Content.Headers.ContentType?.MediaType);
        Assert.Equal(HttpStatusCode.MethodNotAllowed, res.StatusCode);

        // The bearer gate is in front of this too: probing the endpoint is not a way around the door.
        var anonymous = app.CreateAnonymousClient();
        anonymous.DefaultRequestHeaders.Accept.ParseAdd("text/event-stream");
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/mcp")).StatusCode);
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
