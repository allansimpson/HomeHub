namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using HomeHub.Api.Mcp;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

/// <summary>
/// Per-method authorisation on the MCP seam — the credential is authorised at every method.
/// </summary>
/// <remarks>
/// <para>
/// The property under test is not "Geist sees fewer tools". It is that a **read-only credential
/// cannot change the house**, even when it asks for a write directly and never consults the tool
/// list. So the central test calls a write with the wrong credential and then goes and reads the
/// thermostat back through the ordinary API: a refusal that still moved the set point would pass
/// any assertion made about the response alone.
/// </para>
/// <para>
/// Real JSON-RPC over the wire, like <see cref="McpServerTests"/>, because that is what Hermes
/// speaks — and because this enforcement lives in an SDK filter whose documented scope was ambiguous
/// about tools registered up front. A test through the SDK's own client would not have settled it.
/// </para>
/// </remarks>
public class McpMethodScopingTests
{
    private const string BarnabyKey = "barnaby-mcp-key";
    private const string GeistKey = "geist-mcp-key";

    /// <summary>Barnaby writes; Geist reads. The policy Hermes-side, enforced here independently.</summary>
    private static HubAppFactory TwoAgents() => new()
    {
        McpCredentials = new()
        {
            ["barnaby"] = (BarnabyKey, [.. McpMethods.All]),
            ["geist"] = (GeistKey, [.. McpMethods.ReadOnly]),
        },
    };

    private static HttpClient As(HubAppFactory app, string key)
    {
        var client = app.CreateSeededClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", key);
        client.DefaultRequestHeaders.Accept.Clear();
        client.DefaultRequestHeaders.Accept.ParseAdd("application/json, text/event-stream");
        return client;
    }

    private static HttpContent Rpc(string method, object? @params = null) =>
        JsonContent.Create(new { jsonrpc = "2.0", id = 1, method, @params = @params ?? new { } });

    /// <summary>The whole JSON-RPC envelope, so a test can assert on `error` as well as `result`.</summary>
    private static async Task<JsonElement> EnvelopeOf(HttpResponseMessage res)
    {
        var body = await res.Content.ReadAsStringAsync();
        var json = body.TrimStart().StartsWith('{')
            ? body
            : string.Concat(body.Split('\n')
                .Where(l => l.StartsWith("data:", StringComparison.Ordinal))
                .Select(l => l["data:".Length..].Trim()));
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.Clone();
    }

    private static string[] ToolNames(JsonElement envelope) =>
        [.. envelope.GetProperty("result").GetProperty("tools").EnumerateArray()
            .Select(t => t.GetProperty("name").GetString()!).Order()];

    // ---- discovery ----

    [Fact]
    public async Task Each_credential_is_shown_only_the_tools_it_may_call()
    {
        using var app = TwoAgents();

        var barnaby = ToolNames(await EnvelopeOf(await As(app, BarnabyKey).PostAsync("/mcp", Rpc("tools/list"))));
        var geist = ToolNames(await EnvelopeOf(await As(app, GeistKey).PostAsync("/mcp", Rpc("tools/list"))));

        Assert.Equal(
            ["add_todo", "get_calendar", "get_climate_zones", "get_sensor_readings", "set_climate_mode", "set_climate_setpoint"],
            barnaby);

        // Not merely fewer — none that write. The tool list is a description of the house handed to
        // something that talks to people, so showing a thermostat it cannot set invites it both to
        // try and to say it can.
        Assert.Equal(["get_calendar", "get_climate_zones", "get_sensor_readings"], geist);
    }

    // ---- the boundary itself ----

    [Fact]
    public async Task A_read_only_credential_cannot_change_the_house_even_asking_directly()
    {
        using var app = TwoAgents();
        var before = await SetPointOfZoneOne(app);

        var res = await As(app, GeistKey).PostAsync("/mcp", Rpc("tools/call",
            new { name = "set_climate_setpoint", arguments = new { zoneId = 1, setPointF = 61 } }));

        var result = (await EnvelopeOf(res)).GetProperty("result");
        var text = result.GetProperty("content")[0].GetProperty("text").GetString()!;

        Assert.True(result.GetProperty("isError").GetBoolean());

        // Worded as a refusal, not as a fault. The agent reads this text and tells somebody what
        // happened; "an error occurred setting the thermostat" would be a lie about the house, and
        // the kind of lie that invites a retry.
        Assert.Contains("Not authorised", text, StringComparison.Ordinal);
        Assert.DoesNotContain("An error occurred", text, StringComparison.Ordinal);

        // And the house did not move. This is the assertion the whole mechanism exists for: the
        // response could say anything and still be wrong if the set point changed.
        Assert.Equal(before, await SetPointOfZoneOne(app));
    }

    [Fact]
    public async Task The_write_credential_still_writes()
    {
        using var app = TwoAgents();

        var res = await As(app, BarnabyKey).PostAsync("/mcp", Rpc("tools/call",
            new { name = "set_climate_setpoint", arguments = new { zoneId = 1, setPointF = 68 } }));
        res.EnsureSuccessStatusCode();

        var envelope = await EnvelopeOf(res);
        Assert.False(envelope.TryGetProperty("error", out _));

        // Scoping that denied everyone would pass every test above and be useless.
        Assert.Equal(68, await SetPointOfZoneOne(app));
    }

    [Fact]
    public async Task A_read_only_credential_can_still_read()
    {
        using var app = TwoAgents();

        var res = await As(app, GeistKey).PostAsync("/mcp", Rpc("tools/call",
            new { name = "get_climate_zones", arguments = new { } }));
        res.EnsureSuccessStatusCode();

        var envelope = await EnvelopeOf(res);
        Assert.False(envelope.TryGetProperty("error", out _));
        Assert.NotNull(envelope.GetProperty("result").GetProperty("content")[0].GetProperty("text").GetString());
    }

    [Fact]
    public async Task An_unknown_token_is_refused_before_it_learns_anything()
    {
        using var app = TwoAgents();
        var client = app.CreateSeededClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "neither-agent");

        var res = await client.PostAsync("/mcp", Rpc("tools/list"));

        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    // ---- the deprecated shared key ----

    [Fact]
    public async Task The_legacy_shared_key_still_works_but_is_granted_its_methods_explicitly()
    {
        // A panel already running the house must not lose its agent's tools on update. The key keeps
        // working — but through the same enumerated-method path as anything else, so there is no
        // code path where holding a valid token means "may do everything".
        using var app = new HubAppFactory { McpApiKey = "legacy" };

        var names = ToolNames(await EnvelopeOf(await As(app, "legacy").PostAsync("/mcp", Rpc("tools/list"))));

        Assert.Equal([.. McpMethods.All.Order()], names);
    }

    [Fact]
    public void A_method_that_no_credential_lists_is_reachable_by_nobody()
    {
        // The allowlist is the authority, so a tool added to HouseTools next year reaches no agent
        // until somebody writes its name down. The failure mode of forgetting is an agent that
        // cannot do something — not an agent that quietly can.
        var registry = new McpCallerRegistry(
            Options.Create(new McpOptions
            {
                Credentials = new() { ["geist"] = new McpCredential { ApiKey = GeistKey, Methods = [.. McpMethods.ReadOnly] } },
            }),
            NullLogger<McpCallerRegistry>.Instance);

        var caller = registry.Resolve(GeistKey);

        Assert.NotNull(caller);
        Assert.False(caller!.May(McpMethods.AddTodo));
        Assert.False(caller.May("a_tool_invented_next_year"));
        Assert.True(caller.May(McpMethods.GetCalendar));
    }

    [Fact]
    public void An_unknown_token_resolves_to_nobody_rather_than_to_a_default()
    {
        var registry = new McpCallerRegistry(
            Options.Create(new McpOptions
            {
                Credentials = new() { ["geist"] = new McpCredential { ApiKey = GeistKey, Methods = [.. McpMethods.ReadOnly] } },
            }),
            NullLogger<McpCallerRegistry>.Instance);

        Assert.Null(registry.Resolve("wrong"));
        Assert.Null(registry.Resolve(""));
    }

    // ---- startup validation ----

    [Theory]
    // A key that authorises nothing fails as a puzzling 403 at 6am rather than as a config error.
    [InlineData("key-but-no-methods")]
    // An intention written down and never enabled.
    [InlineData("methods-but-no-key")]
    // Two agents behind one token cannot be told apart — so neither can be scoped, which is the
    // exact failure this mechanism exists to prevent.
    [InlineData("shared-token")]
    public void Half_written_credentials_stop_the_process(string shape)
    {
        var options = new McpOptions();
        switch (shape)
        {
            case "key-but-no-methods":
                options.Credentials["geist"] = new McpCredential { ApiKey = GeistKey };
                break;
            case "methods-but-no-key":
                options.Credentials["geist"] = new McpCredential { Methods = [.. McpMethods.ReadOnly] };
                break;
            case "shared-token":
                options.Credentials["barnaby"] = new McpCredential { ApiKey = "same", Methods = [.. McpMethods.All] };
                options.Credentials["geist"] = new McpCredential { ApiKey = "same", Methods = [.. McpMethods.ReadOnly] };
                break;
        }

        var result = new McpOptionsValidator().Validate(null, options);

        Assert.True(result.Failed, $"'{shape}' should not have been accepted");
    }

    [Fact]
    public void A_correctly_scoped_pair_validates()
    {
        var options = new McpOptions
        {
            Credentials = new()
            {
                ["barnaby"] = new McpCredential { ApiKey = BarnabyKey, Methods = [.. McpMethods.All] },
                ["geist"] = new McpCredential { ApiKey = GeistKey, Methods = [.. McpMethods.ReadOnly] },
            },
        };

        Assert.True(new McpOptionsValidator().Validate(null, options).Succeeded);
    }

    /// <summary>Read zone 1's set point back through the ordinary API, not through MCP.</summary>
    private static async Task<double> SetPointOfZoneOne(HubAppFactory app)
    {
        var res = await app.CreateSeededClient().GetFromJsonAsync<JsonElement>("/api/climate/units");
        return res.EnumerateArray().First(u => u.GetProperty("id").GetInt32() == 1)
            .GetProperty("setPointF").GetDouble();
    }
}
