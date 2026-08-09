namespace HomeHub.Api.Mcp;

using Microsoft.Extensions.Options;

/// <summary>
/// The MCP seam's config, bound from the <c>Mcp</c> section (ai-assistant.md, stage A4).
///
/// This is the surface an agent — Hermes today, anything speaking MCP tomorrow — uses to read and
/// act on the house. It is **off unless at least one credential is set**, following the same
/// config-gated shape as every other integration here: no key, no endpoint, no thinking about it.
///
/// A credential is required rather than optional on purpose. The tools below write — setting a
/// thermostat, adding to a list — and the panel sits on a household LAN where "reachable" and
/// "authorised" are not the same thing. An unauthenticated write endpoint on the box that runs the
/// house is not a seam, it is a hole.
/// </summary>
public sealed class McpOptions
{
    public const string Section = "Mcp";

    /// <summary>
    /// One credential per agent, keyed by name — <c>barnaby</c>, <c>geist</c>.
    ///
    /// <para>
    /// <b>Each credential carries its own method list, and that list is the authority.</b> The
    /// alternative — one shared key plus "authenticated means every method" — makes the read-only
    /// agent indistinguishable from the one allowed to change the heating, and the only thing
    /// standing between them becomes a config file on a different machine.
    /// </para>
    /// </summary>
    public Dictionary<string, McpCredential> Credentials { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// The single shared key this seam originally shipped with. **Deprecated.**
    ///
    /// <para>
    /// Still honoured, because a panel already running the house should not lose its agent's tools
    /// the moment it takes an update — but it is granted its methods *explicitly*, like any other
    /// credential, and it warns at startup. There is no code path here where holding a valid token
    /// implies access to everything.
    /// </para>
    /// </summary>
    public string? ApiKey { get; set; }

    /// <summary>Where the MCP endpoint is mounted. The agent's config points at this path.</summary>
    public string Route { get; set; } = "/mcp";

    /// <summary>
    /// How many days ahead <c>get_calendar</c> looks by default. Small on purpose: a wall panel is
    /// asked what is happening today and tomorrow, and a wide window buries that in noise.
    /// </summary>
    public int CalendarDefaultDays { get; set; } = 7;

    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(ApiKey) ||
        Credentials.Values.Any(c => !string.IsNullOrWhiteSpace(c.ApiKey));
}

/// <summary>One agent's key, and exactly what it may call.</summary>
public sealed class McpCredential
{
    /// <summary>Bearer token this agent presents. Blank leaves the credential inert.</summary>
    public string? ApiKey { get; set; }

    /// <summary>
    /// The tool names this credential may discover and call, e.g. <c>get_calendar</c>.
    ///
    /// <para>
    /// An allowlist, never a denylist. A tool added to <see cref="HouseTools"/> next year reaches
    /// nobody until somebody writes its name here — so the failure mode of forgetting is an agent
    /// that cannot do something, rather than an agent that quietly can.
    /// </para>
    /// </summary>
    public List<string> Methods { get; set; } = [];
}

/// <summary>
/// Startup validation. A credential that is half-written is the dangerous kind: it either exposes
/// more than intended or silently does nothing, and both are worth refusing to start over.
/// </summary>
public sealed class McpOptionsValidator : IValidateOptions<McpOptions>
{
    public ValidateOptionsResult Validate(string? name, McpOptions options)
    {
        var errors = new List<string>();

        foreach (var (key, cred) in options.Credentials)
        {
            var hasKey = !string.IsNullOrWhiteSpace(cred.ApiKey);
            var hasMethods = cred.Methods.Count > 0;

            // A key with no methods authorises nothing, which is almost certainly not what was
            // meant — and it fails as a puzzling 403 at 6am rather than as a config error.
            if (hasKey && !hasMethods)
                errors.Add($"Mcp:Credentials:{key} has an ApiKey but no Methods, so it can call nothing.");

            // Methods with no key is the mirror image: an intention written down and never enabled.
            if (!hasKey && hasMethods)
                errors.Add($"Mcp:Credentials:{key} lists Methods but has no ApiKey, so it is unreachable.");

            foreach (var dup in cred.Methods.GroupBy(m => m, StringComparer.OrdinalIgnoreCase)
                         .Where(g => g.Count() > 1).Select(g => g.Key))
                errors.Add($"Mcp:Credentials:{key} lists '{dup}' more than once.");
        }

        // Two agents sharing one token cannot be told apart, so neither can be scoped. That is the
        // exact failure this whole mechanism exists to prevent, so it stops the process.
        var live = options.Credentials
            .Where(c => !string.IsNullOrWhiteSpace(c.Value.ApiKey))
            .ToList();
        foreach (var clash in live.GroupBy(c => c.Value.ApiKey, StringComparer.Ordinal).Where(g => g.Count() > 1))
            errors.Add($"Mcp credentials {string.Join(", ", clash.Select(c => c.Key))} share one ApiKey; "
                     + "they cannot be scoped apart. Issue a distinct key per agent.");

        if (!string.IsNullOrWhiteSpace(options.ApiKey) &&
            live.Any(c => string.Equals(c.Value.ApiKey, options.ApiKey, StringComparison.Ordinal)))
            errors.Add("The deprecated Mcp:ApiKey is the same token as a named credential. "
                     + "Remove Mcp:ApiKey, or give the named credential its own key.");

        return errors.Count == 0 ? ValidateOptionsResult.Success : ValidateOptionsResult.Fail(errors);
    }
}
