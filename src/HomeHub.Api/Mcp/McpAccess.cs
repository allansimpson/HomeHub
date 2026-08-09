namespace HomeHub.Api.Mcp;

using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Options;

/// <summary>Who is calling the house, and what they are allowed to ask for.</summary>
/// <param name="Name">The credential's config key — <c>barnaby</c>, <c>geist</c>. For logs only.</param>
/// <param name="Methods">Exactly the tool names this caller may discover and call.</param>
public sealed record McpCaller(string Name, IReadOnlySet<string> Methods)
{
    public bool May(string method) => Methods.Contains(method);
}

/// <summary>
/// Resolves a bearer token to the caller holding it.
///
/// <para>
/// Tokens are compared as SHA-256 digests rather than as raw bytes. Not for storage secrecy — they
/// are in memory either way — but because a fixed-time comparison of variable-length strings still
/// leaks the length, and digests make every comparison the same shape. Every candidate is checked
/// on every call, so how long a request takes says nothing about which agent got in or how nearly
/// a wrong token matched.
/// </para>
/// </summary>
public sealed class McpCallerRegistry
{
    private readonly List<(byte[] Digest, McpCaller Caller)> _callers = [];

    public McpCallerRegistry(IOptions<McpOptions> options, ILogger<McpCallerRegistry> logger)
    {
        var opts = options.Value;

        foreach (var (name, cred) in opts.Credentials)
        {
            if (string.IsNullOrWhiteSpace(cred.ApiKey) || cred.Methods.Count == 0) continue;
            _callers.Add((Digest(cred.ApiKey), new McpCaller(
                name, cred.Methods.ToHashSet(StringComparer.OrdinalIgnoreCase))));
        }

        if (!string.IsNullOrWhiteSpace(opts.ApiKey))
        {
            // Granted every tool — but *enumerated*, not implied. The distinction matters: a tool
            // added later is not covered by this list either, so the deprecated key does not quietly
            // become a skeleton key for the next thing the house learns to do.
            var all = McpMethods.All.ToHashSet(StringComparer.OrdinalIgnoreCase);
            _callers.Add((Digest(opts.ApiKey), new McpCaller("legacy-shared-key", all)));

            logger.LogWarning(
                "Mcp:ApiKey is a single shared key granting all {Count} house methods. Replace it with "
              + "per-agent credentials (Mcp:Credentials:barnaby / :geist), each listing only the methods "
              + "that agent needs — a read-only agent must not hold a write-capable token.", all.Count);
        }

        var reachable = _callers.SelectMany(c => c.Caller.Methods).ToHashSet(StringComparer.OrdinalIgnoreCase);
        // A tool nobody can reach is a silent dead end — it answers tools/list for no one and fails
        // every call, and the reason lives in a config file rather than in the code being read.
        foreach (var orphan in McpMethods.All.Where(m => !reachable.Contains(m)))
            logger.LogWarning("House method '{Method}' is in no credential's list, so no agent can call it.", orphan);

        foreach (var (name, cred) in opts.Credentials)
            foreach (var ghost in cred.Methods.Where(m => !McpMethods.All.Contains(m, StringComparer.OrdinalIgnoreCase)))
                logger.LogWarning(
                    "Mcp:Credentials:{Name} allows '{Method}', which is not a house method — check the spelling. "
                  + "It grants nothing.", name, ghost);
    }

    /// <summary>The caller holding this token, or null. Blank tokens never match.</summary>
    public McpCaller? Resolve(string token)
    {
        if (token.Length == 0 || _callers.Count == 0) return null;

        var supplied = Digest(token);
        McpCaller? found = null;

        // No early exit. Returning on the first hit would make a matching first credential
        // measurably faster than a matching last one.
        foreach (var (digest, caller) in _callers)
            if (CryptographicOperations.FixedTimeEquals(digest, supplied))
                found = caller;

        return found;
    }

    private static byte[] Digest(string value) => SHA256.HashData(Encoding.UTF8.GetBytes(value));
}

/// <summary>
/// The house methods that exist, named once.
///
/// <para>
/// Kept beside the credentials rather than reflected out of <see cref="HouseTools"/> so that adding
/// a tool is a two-step act: write the tool, then say who may call it. Reflection would make the
/// first step alone enough, which is how a new write ends up reachable by an agent nobody meant to
/// give it to.
/// </para>
/// </summary>
public static class McpMethods
{
    public const string GetCalendar = "get_calendar";
    public const string GetSensorReadings = "get_sensor_readings";
    public const string GetClimateZones = "get_climate_zones";
    public const string SetClimateMode = "set_climate_mode";
    public const string SetClimateSetPoint = "set_climate_setpoint";
    public const string AddTodo = "add_todo";

    /// <summary>Every method, in the order a person would read them: reads, then writes.</summary>
    public static readonly IReadOnlyList<string> All =
    [
        GetCalendar, GetSensorReadings, GetClimateZones,
        SetClimateMode, SetClimateSetPoint, AddTodo,
    ];

    /// <summary>The methods that only look. The natural allowance for an agent that advises.</summary>
    public static readonly IReadOnlyList<string> ReadOnly =
    [
        GetCalendar, GetSensorReadings, GetClimateZones,
    ];
}
