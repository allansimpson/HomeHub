namespace HomeHub.Api.Ai;

using Microsoft.Extensions.Options;

/// <summary>One agent on the roster, resolved from configuration. Carries no secret.</summary>
/// <remarks>
/// Deliberately not the options object. Everything above the seam — DTOs, the router, the controller
/// — passes <see cref="Agent"/> around, and it has no <c>ApiKey</c> property to leak into a log line,
/// an exception message or a serialised response. The key stays inside
/// <see cref="HermesClientFactory"/>, which is the only thing that needs it.
/// </remarks>
public sealed record Agent(
    string Key,
    string Name,
    string? Tagline,
    bool IsDefault,
    bool SupportsHouseControl,
    bool IsConfigured);

/// <summary>
/// The configured agents, by key — the closed roster.
/// </summary>
/// <remarks>
/// <b>Closed on purpose.</b> A browser may submit an agent key; it may never submit an address. Every
/// key is validated against this roster and resolved to a server-side client, so no request can point
/// HomeHub at an arbitrary URL with a credential attached.
/// </remarks>
public sealed class AgentRoster
{
    private readonly List<Agent> _agents;

    public AgentRoster(IOptions<HermesOptions> options)
    {
        _agents = [.. options.Value.Agents
            .Where(kv => !string.IsNullOrWhiteSpace(kv.Key))
            .Select(kv => new Agent(
                kv.Key,
                string.IsNullOrWhiteSpace(kv.Value.Name) ? kv.Key : kv.Value.Name,
                kv.Value.Tagline,
                kv.Value.Default,
                kv.Value.SupportsHouseControl,
                !string.IsNullOrWhiteSpace(kv.Value.BaseUrl) && !string.IsNullOrWhiteSpace(kv.Value.ApiKey)))
            .OrderByDescending(a => a.IsDefault)
            .ThenBy(a => a.Name, StringComparer.OrdinalIgnoreCase)];
    }

    /// <summary>Every agent on the roster, default first.</summary>
    public IReadOnlyList<Agent> All => _agents;

    /// <summary>Whether any agent is reachable at all.</summary>
    public bool Any => _agents.Any(a => a.IsConfigured);

    /// <summary>
    /// The household agent — the one every member has.
    /// </summary>
    /// <remarks>
    /// Falls back through "marked default" → "first configured" → "first at all" → a placeholder, so
    /// the Assist header always has a name to render. A panel with no Hermes configured shows
    /// <c>Assist</c> and answers with the canned fallback rather than rendering an empty header.
    /// </remarks>
    public Agent Default =>
        _agents.FirstOrDefault(a => a.IsDefault)
        ?? _agents.FirstOrDefault(a => a.IsConfigured)
        ?? _agents.FirstOrDefault()
        ?? Placeholder;

    /// <summary>What Assist shows when no agent is configured. Never reachable, never written to a row.</summary>
    public static readonly Agent Placeholder =
        new("assist", "Assist", null, IsDefault: true, SupportsHouseControl: false, IsConfigured: false);

    /// <summary>Whether this key names a real agent. The guard on anything a browser supplied.</summary>
    public bool Knows(string? key) =>
        key is not null && _agents.Any(a => string.Equals(a.Key, key, StringComparison.OrdinalIgnoreCase));

    /// <summary>Look up an agent by key, or null when the roster does not contain it.</summary>
    public Agent? Find(string? key) =>
        key is null ? null : _agents.FirstOrDefault(a => string.Equals(a.Key, key, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Resolve a stored key, falling back to the household agent.
    /// </summary>
    /// <remarks>
    /// An unknown key resolves rather than throwing: a conversation whose agent was removed from
    /// configuration must still open and still read, and a 500 on the list endpoint because somebody
    /// renamed a config key would take the whole tab down. Write paths use <see cref="Find"/> and
    /// refuse instead — reading tolerates drift, acting does not.
    /// </remarks>
    public Agent Resolve(string? key) => Find(key) ?? Default;
}
