namespace HomeHub.Api.Ai;

using System.ComponentModel.DataAnnotations;
using Microsoft.Extensions.Options;

/// <summary>
/// The Hermes agents HomeHub can talk to, bound from the <c>Hermes</c> section.
/// </summary>
/// <remarks>
/// <para>
/// <b>This is connection configuration, not AI configuration.</b> There is no model here, no
/// provider, no tier, no route, no escalation policy and no fallback chain — deliberately, and the
/// absence is the design. HomeHub chooses *which agent*; Hermes owns every decision about how that
/// agent answers. A more capable model, local or hosted, is a change inside Hermes with no HomeHub
/// config change and no redeploy.
/// </para>
/// <para>
/// <b>One listener per agent.</b> The deployed topology is two independent Hermes gateways on
/// loopback — Barnaby on <c>127.0.0.1:8642</c>, Geist on <c>127.0.0.1:8643</c> — each with its own
/// profile, session database, memory, skills and API key. There is no multiplexing and no
/// <c>/p/{profile}</c> prefix: <b>the endpoint is the agent selector.</b>
/// </para>
/// <para>
/// Keyed by the stable agent key so a secret can be addressed by name —
/// <c>Hermes:Agents:barnaby:ApiKey</c> — rather than by a list index that shifts when the roster is
/// reordered.
/// </para>
/// </remarks>
public sealed class HermesOptions
{
    public const string Section = "Hermes";

    /// <summary>Agents by key. The key is stored on every conversation and never shown.</summary>
    public Dictionary<string, HermesAgentOptions> Agents { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Seconds to wait on a non-streaming call. Generous: an agent loop is several round-trips.</summary>
    [Range(5, 600)]
    public int TimeoutSeconds { get; set; } = 120;

    /// <summary>
    /// Seconds a streamed turn may run.
    /// </summary>
    /// <remarks>
    /// Separate from <see cref="TimeoutSeconds"/> and much longer, because a stream that is still
    /// delivering tokens is healthy. A short global timeout would kill exactly the long tool-using
    /// runs the agent path exists for.
    /// </remarks>
    [Range(30, 3600)]
    public int StreamTimeoutSeconds { get; set; } = 600;

    /// <summary>
    /// Whether HomeHub asks an agent to name each new conversation (<c>Assist.ConversationTitler</c>).
    /// </summary>
    /// <remarks>
    /// <para>
    /// Connection configuration, like everything else here, and that is what it is really about: one
    /// extra one-shot completion per chat opened. Nobody waits for it, and it names nothing that was
    /// not going to the agent anyway — but it is a call, and a household paying per token or running a
    /// model that takes its time is entitled to decline it. Off leaves every chat named after its
    /// opening turn, which is what the panel did before.
    /// </para>
    /// <para>
    /// On by default: a list of subjects is worth more than a list of openings, and the cost is a few
    /// dozen tokens against a household's own hardware in the usual deployment.
    /// </para>
    /// </remarks>
    public bool NameConversations { get; set; } = true;
}

/// <summary>One Hermes gateway: where it is, how to authenticate, and what to call it.</summary>
public sealed class HermesAgentOptions
{
    /// <summary>What the household calls this agent — the Assist header. e.g. <c>Barnaby</c>.</summary>
    [Required(AllowEmptyStrings = false)]
    public string Name { get; set; } = "";

    /// <summary>The dropdown's second line, e.g. <c>Household · default agent</c>.</summary>
    public string? Tagline { get; set; }

    /// <summary>
    /// Base URL of this agent's own Hermes gateway, e.g. <c>http://127.0.0.1:8642</c>.
    /// </summary>
    /// <remarks>
    /// Loopback is intentional: the API key has no route-level scoping, so the gateway is not exposed
    /// to the LAN. That means <b>HomeHub must share the host network namespace with Hermes</b>. If it
    /// is containerised or running on another machine, this address is wrong and the answer is a
    /// tunnel or an explicitly designed reverse proxy — never quietly rebinding Hermes to the LAN.
    /// </remarks>
    [Required(AllowEmptyStrings = false)]
    [Url]
    public string BaseUrl { get; set; } = "";

    /// <summary>
    /// This profile's own <c>API_SERVER_KEY</c>. Server-side only.
    /// </summary>
    /// <remarks>
    /// Never serialised to any DTO, never logged, never given to the SPA, the wall panel, a phone or
    /// the Pi bridge. Set it through user-secrets or the deployment secret store —
    /// <c>Hermes:Agents:barnaby:ApiKey</c> — and never in a tracked <c>appsettings*.json</c>.
    /// <para>
    /// Per profile, not shared: each gateway accepts only its own key, and a single key across both
    /// would erase the isolation that makes Barnaby and Geist separate agents.
    /// </para>
    /// </remarks>
    [Required(AllowEmptyStrings = false)]
    public string ApiKey { get; set; } = "";

    /// <summary>The agent a member gets before anyone assigns them one. Exactly one may be default.</summary>
    public bool Default { get; set; }

    /// <summary>
    /// Whether this agent may perform household writes.
    /// </summary>
    /// <remarks>
    /// <b>Descriptive, not a security boundary.</b> It drives HomeHub's UI and routing. Enforcement is
    /// the MCP credential this agent holds and the allowlist on its own toolset — a misconfigured
    /// agent must be unable to call a write endpoint regardless of this flag.
    /// </remarks>
    public bool SupportsHouseControl { get; set; }
}

/// <summary>
/// Fails startup on a roster that would misbehave at the first turn instead of at boot.
/// </summary>
/// <remarks>
/// Deliberately strict about *declared* agents and permissive about an empty roster: a developer with
/// no Hermes running should still get a working panel that answers with the canned fallback, but a
/// half-configured agent — a name with no key, a key with no address — is a deployment mistake that
/// should never reach the household as "the assistant is being quiet today".
/// </remarks>
public sealed class HermesOptionsValidator : IValidateOptions<HermesOptions>
{
    public ValidateOptionsResult Validate(string? name, HermesOptions options)
    {
        var errors = new List<string>();

        foreach (var (key, agent) in options.Agents)
        {
            var where = $"Hermes:Agents:{key}";
            if (string.IsNullOrWhiteSpace(key))
                errors.Add("An agent key may not be blank — it is stored on every conversation.");
            if (string.IsNullOrWhiteSpace(agent.Name))
                errors.Add($"{where}:Name is required.");
            if (string.IsNullOrWhiteSpace(agent.BaseUrl))
                errors.Add($"{where}:BaseUrl is required, e.g. http://127.0.0.1:8642");
            else if (!Uri.TryCreate(agent.BaseUrl, UriKind.Absolute, out _))
                errors.Add($"{where}:BaseUrl is not an absolute URL.");
            // **A missing ApiKey is deliberately not an error here.** It used to be, and once this
            // validation began running at startup that turned "Geist has no key yet" into "the panel
            // does not boot" — taking the climate, the calendar and the litter box down over an agent
            // nobody had finished setting up. An unconfigured agent is already a state the system
            // models properly: `Agent.IsConfigured` is false, the roster still lists it, and a turn
            // falls back to the canned reply. Startup logs which agents are in that state instead;
            // see the warning raised after Build() in Program.cs.
        }

        var defaults = options.Agents.Count(a => a.Value.Default);
        if (options.Agents.Count > 0 && defaults == 0)
            errors.Add("Exactly one Hermes agent must set Default: true — it is the household agent every member has.");
        if (defaults > 1)
            errors.Add($"{defaults} Hermes agents set Default: true; exactly one may.");

        return errors.Count > 0 ? ValidateOptionsResult.Fail(errors) : ValidateOptionsResult.Success;
    }
}
