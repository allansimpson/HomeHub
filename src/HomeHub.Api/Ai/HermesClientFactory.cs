namespace HomeHub.Api.Ai;

using System.Net.Http.Headers;
using HomeHub.Api.Net;
using Microsoft.Extensions.Options;

/// <summary>
/// Hands out an <see cref="HttpClient"/> already pointed at one agent's gateway and already carrying
/// that agent's credential.
/// </summary>
/// <remarks>
/// <para>
/// <b>The only place an API key is touched.</b> Callers ask for an agent by key and receive a client;
/// they never see, pass or store the secret, so there is no route by which it reaches a DTO, a log
/// line or an exception message. <see cref="Agent"/> — the type every layer above this passes around
/// — has no key property at all.
/// </para>
/// <para>
/// <b>Resolved per call, from live options.</b> An earlier version registered one named client per
/// agent at startup, from a configuration snapshot. That worked but bound the address and credential
/// to the instant the process booted: options reload could not reach them, and a test could not point
/// an agent at a stub gateway. `IHttpClientFactory` hands back a fresh <c>HttpClient</c> over a pooled
/// handler on every call, so setting the address and header here costs nothing and is safe.
/// </para>
/// <para>
/// <b>One client per agent, because one gateway per agent.</b> Barnaby and Geist are separate
/// listeners with separate keys; a shared, pre-addressed client would be a single mistake away from
/// sending Barnaby's credential to Geist's port.
/// </para>
/// </remarks>
public sealed class HermesClientFactory
{
    /// <summary>The pooled handler every agent's client shares. Connection reuse, not identity.</summary>
    public const string ClientName = "hermes";

    private readonly IHttpClientFactory _factory;
    private readonly IOptionsMonitor<HermesOptions> _options;
    private readonly ILogger<HermesClientFactory> _logger;

    public HermesClientFactory(
        IHttpClientFactory factory,
        IOptionsMonitor<HermesOptions> options,
        ILogger<HermesClientFactory> logger)
    {
        _factory = factory;
        _options = options;
        _logger = logger;
    }

    /// <summary>Whether this agent has both an address and a key.</summary>
    public bool IsConfigured(string agentKey) => Find(agentKey) is not null;

    /// <summary>
    /// A client for this agent, or null when it is not configured.
    /// </summary>
    /// <remarks>
    /// Null rather than an exception: an unconfigured agent is an ordinary state on a panel being set
    /// up, and the caller's response to it — answer with the canned reply — is the same one it has for
    /// an agent that is merely down.
    /// </remarks>
    public HttpClient? Create(string agentKey)
    {
        if (Find(agentKey) is not { } agent) return null;

        /*
         * Rechecked at construction, not only at startup.
         *
         * `Hermes` is bound through `IOptionsMonitor` so a configuration reload is picked up without a
         * restart — which is the point, and also means the address that passed validation at boot is
         * not necessarily the one being handed a credential now. Null is already this method's answer
         * for an agent that cannot be reached, and the caller's response to it — the canned reply — is
         * the right one here too: better a household agent that says nothing than one whose key has
         * gone somewhere nobody approved.
         */
        if (EgressGuard.Refuse(agent.BaseUrl, HermesOptionsValidator.GatewayRule(agentKey)) is { } refusal)
        {
            _logger.LogError("Hermes agent {Agent} was not opened: {Refusal}", agentKey, refusal);
            return null;
        }

        var http = _factory.CreateClient(ClientName);
        http.BaseAddress = new Uri(agent.BaseUrl.TrimEnd('/') + "/");
        http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", agent.ApiKey);
        http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        // The ceiling for a streamed turn, not for an ordinary request. A stream still delivering
        // tokens is healthy, and a short global timeout would kill exactly the long tool-using runs
        // the agent path exists for. Per-call cancellation is what bounds a normal turn.
        http.Timeout = TimeSpan.FromSeconds(Math.Max(30, _options.CurrentValue.StreamTimeoutSeconds));
        return http;
    }

    private HermesAgentOptions? Find(string agentKey)
    {
        if (!_options.CurrentValue.Agents.TryGetValue(agentKey, out var agent)) return null;
        return string.IsNullOrWhiteSpace(agent.BaseUrl) || string.IsNullOrWhiteSpace(agent.ApiKey)
            ? null
            : agent;
    }
}
