namespace HomeHub.Api.Mcp;

using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

/// <summary>
/// Per-method authorisation for the MCP seam.
///
/// <para>
/// <b>The credential is authorised at every method, not once at the door.</b> Bearer-checking the
/// endpoint and then treating "authenticated" as "may do anything" collapses the read-only agent
/// and the one allowed to change the heating into a single privilege level — and leaves the only
/// real boundary in a config file on another machine, maintained by hand.
/// </para>
///
/// <para>
/// Two filters, because there are two ways to reach a tool. <c>tools/call</c> is the one that acts.
/// <c>tools/list</c> is the one that tells an agent what is available — and an agent that cannot
/// set a thermostat should not be shown a thermostat it can set, both because it will try and
/// because the list is a description of the house given to something that talks to people.
/// </para>
/// </summary>
public static class McpMethodScoping
{
    /// <summary>Where the authenticated caller is parked for the duration of the request.</summary>
    public const string CallerItemKey = "mcp.caller";

    /// <summary>Wire both filters into the server's request pipeline.</summary>
    public static void AddHouseMethodScoping(this McpServerOptions options)
    {
        options.Filters.Request.CallToolFilters.Add(next => async (ctx, ct) =>
        {
            var caller = Caller(ctx);
            var method = ctx.Params?.Name ?? "";

            if (caller is null || !caller.May(method))
            {
                Log(ctx)?.LogWarning(
                    "MCP credential '{Caller}' was refused '{Method}': it is not in that credential's method list.",
                    caller?.Name ?? "(unauthenticated)", method);

                // Returned rather than thrown. A thrown McpException is wrapped by the SDK as
                // "An error occurred invoking 'set_climate_setpoint': …", which reads as the
                // thermostat having failed — the one reading that would invite a retry. Phrased as a
                // refusal it reaches the model intact, so the agent can say *why* it cannot help
                // rather than reporting a fault in the house.
                return new CallToolResult
                {
                    IsError = true,
                    Content = [new TextContentBlock
                    {
                        Text = $"Not authorised: this credential may not call '{method}'. "
                             + "This is a permission boundary, not a failure — do not retry it.",
                    }],
                };
            }

            return await next(ctx, ct);
        });

        options.Filters.Request.ListToolsFilters.Add(next => async (ctx, ct) =>
        {
            var result = await next(ctx, ct);
            var caller = Caller(ctx);

            // No caller resolved means something changed upstream and this filter can no longer see
            // who is asking. Advertise nothing rather than everything.
            if (caller is null) return new ListToolsResult { Tools = [] };

            return new ListToolsResult
            {
                Tools = [.. result.Tools.Where(t => caller.May(t.Name))],
                NextCursor = result.NextCursor,
            };
        });
    }

    private static McpCaller? Caller<T>(RequestContext<T> ctx)
    {
        var http = ctx.Services?.GetService<IHttpContextAccessor>()?.HttpContext;
        return http?.Items.TryGetValue(CallerItemKey, out var v) == true ? v as McpCaller : null;
    }

    private static ILogger? Log<T>(RequestContext<T> ctx) =>
        ctx.Services?.GetService<ILoggerFactory>()?.CreateLogger(typeof(McpMethodScoping).FullName!);
}
