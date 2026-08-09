namespace HomeHub.Api.Ai;

/// <summary>Which path produced a turn. Surfaced as the tag beside a reply.</summary>
/// <remarks>
/// Two values, where there were three. <c>Cloud</c> is gone with HomeHub's direct OpenAI provider,
/// and the old <c>Local</c> no longer means "the small on-server model" — there is no HomeHub-owned
/// model any more. What survives is the distinction that still means something to a household:
/// **did an agent answer, or did the house?**
/// </remarks>
public enum AssistantOrigin
{
    /// <summary>
    /// HomeHub itself. The deterministic actions path, or the canned reply when no agent is
    /// reachable. Never leaves the house, because no model was involved at all.
    /// </summary>
    Local = 0,

    /// <summary>A Hermes agent. Which model answered, and where it ran, is Hermes's to know.</summary>
    Agent = 2,
}

/// <summary>The outcome of one turn.</summary>
/// <param name="Origin">Who answered — see <see cref="AssistantOrigin"/>.</param>
/// <param name="Action">The kind of in-app write performed, for the IT TOUCHED receipt.</param>
/// <param name="SessionId">The Hermes session the turn ran in, when one did.</param>
/// <param name="Failure">Set when the agent could not answer; drives the message shown.</param>
public sealed record AssistTurnResult(
    string Text,
    AssistantOrigin Origin,
    string? Action = null,
    string? SessionId = null,
    AssistFailure? Failure = null);

/// <summary>
/// Why a turn did not reach an agent.
/// </summary>
/// <remarks>
/// Distinguished because the household-facing response differs, and because two of these are
/// operator faults that should never be presented as "the assistant is thinking today".
/// </remarks>
public enum AssistFailure
{
    /// <summary>No agent configured, or the address is not an API-server gateway.</summary>
    NotConfigured,

    /// <summary>Connection refused, DNS, connect timeout. The agent is down.</summary>
    Unreachable,

    /// <summary>Hermes rejected the credential. A deployment fault; logged, never shown verbatim.</summary>
    Unauthorized,

    /// <summary>At the concurrency cap. Retryable, and the turn must not be duplicated.</summary>
    Busy,

    /// <summary>Reached it, and it failed.</summary>
    Faulted,
}

/// <summary>
/// One turn, start to finish: deterministic actions first, then the selected agent, then a canned
/// reply if the agent could not answer.
/// </summary>
/// <remarks>
/// <para>
/// Replaces <c>AssistantRouter</c>, which chose between a local model, a cloud model and an agent
/// using tunable hints. There is nothing left to route: HomeHub has one assistant backend, and which
/// model serves it is decided inside Hermes.
/// </para>
/// <para>
/// <b>What is deliberately absent.</b> No provider fallback. No silent substitution of one agent for
/// another — Barnaby being down never redirects to Geist, because they are different agents with
/// different memories and the household chose one of them. No health probe before each turn either:
/// that is a time-of-check/time-of-use race that also costs latency on the path where latency is most
/// visible. Attempt the turn, and classify what comes back.
/// </para>
/// </remarks>
public sealed class AssistTurnService
{
    private readonly HermesClient _hermes;
    private readonly AssistantActions _actions;
    private readonly ILogger<AssistTurnService> _logger;

    public AssistTurnService(HermesClient hermes, AssistantActions actions, ILogger<AssistTurnService> logger)
    {
        _hermes = hermes;
        _actions = actions;
        _logger = logger;
    }

    /// <summary>
    /// Try the deterministic path. Non-null means the house did it and no agent was involved.
    /// </summary>
    /// <remarks>
    /// Runs first, always, and its result is never forwarded to Hermes — that is what stops the same
    /// imperative being executed twice. Available with every agent offline, which is the entire point:
    /// "add milk to the list" must not depend on a model being up.
    /// </remarks>
    public async Task<AssistTurnResult?> TryActionAsync(string prompt, int? profileId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(prompt)) return null;
        if (await _actions.TryHandleCommandAsync(prompt, profileId, ct) is not { } outcome) return null;
        return new AssistTurnResult(outcome.Message, AssistantOrigin.Local, outcome.Action);
    }

    /// <summary>Send a turn to one agent, classifying any failure rather than throwing at the caller.</summary>
    /// <remarks>
    /// <b>No health probe first.</b> That would be a time-of-check/time-of-use race and would add a
    /// round-trip to the path where latency shows most. It also conflates two states that need
    /// different words: an agent nobody has configured, and one that is configured and simply down.
    /// Attempt the turn; classify what comes back.
    /// </remarks>
    public async Task<AssistTurnResult> AskAsync(
        string agentKey, string? sessionId, IReadOnlyList<HermesContent> content, CancellationToken ct)
    {
        // The one thing worth checking up front, because it is a fact about configuration rather than
        // about the network and cannot change between the check and the call.
        if (!_hermes.IsConfigured(agentKey))
            return Canned(AssistFailure.NotConfigured);

        try
        {
            var reply = await _hermes.ChatAsync(agentKey, sessionId, content, ct);
            return new AssistTurnResult(reply.Text, AssistantOrigin.Agent, SessionId: reply.EffectiveSessionId);
        }
        catch (HermesAuthException ex)
        {
            // Logged with the agent key and status, never the credential or the response body.
            _logger.LogError("Hermes rejected HomeHub's credential for agent '{Agent}' ({Status}).",
                ex.AgentKey, (int)ex.Status);
            return Canned(AssistFailure.Unauthorized);
        }
        catch (HermesBusyException)
        {
            return Canned(AssistFailure.Busy);
        }
        catch (HttpRequestException ex)
        {
            _logger.LogWarning(ex, "Agent '{Agent}' failed.", agentKey);
            return Canned(ex.HttpRequestError is HttpRequestError.ConnectionError
                ? AssistFailure.Unreachable
                : AssistFailure.Faulted);
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            _logger.LogWarning("Agent '{Agent}' timed out before answering.", agentKey);
            return Canned(AssistFailure.Unreachable);
        }
    }

    /// <summary>
    /// What the household sees when an agent could not answer.
    /// </summary>
    /// <remarks>
    /// Honest and non-committal in the same breath: it says the assistant is unavailable without
    /// guessing why to somebody who cannot act on the answer, and it never implies a different agent
    /// was tried. An authentication fault reads the same as an outage on purpose — the operator
    /// detail is in the log, where the person who can fix it will look.
    /// </remarks>
    private static AssistTurnResult Canned(AssistFailure failure) => new(
        failure switch
        {
            AssistFailure.Busy => "The assistant is handling something else right now. Try again in a moment.",
            AssistFailure.NotConfigured => "No assistant is set up on this panel yet.",
            _ => "The assistant is unreachable right now. Please try again.",
        },
        AssistantOrigin.Local,
        Failure: failure);
}
