namespace HomeHub.Api.Assist;

/// <summary>
/// A pending promise to remove one Hermes session, outliving the conversation it belonged to.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why a durable row and not a loop.</b> Deleting a conversation has to remove every Hermes
/// session in its compression lineage, and those calls can fail — the agent restarts, the host is
/// busy. Delete the ledger row first and the session ids are gone with it: the transcripts are
/// orphaned on the agent forever, and nothing is left that knows they existed. Write the promise
/// down *before* making any remote call, and an outage becomes a retry instead of a leak.
/// </para>
/// <para>
/// <b>The tombstone owns its own copy of the ids.</b> It deliberately does not read through
/// <see cref="HermesSessionReference"/>, which cascades away with the conversation — that would be
/// the same failure one level down.
/// </para>
/// <para>
/// <b>The profile travels with the id.</b> Barnaby and Geist are separate gateways with separate
/// databases; a session id means nothing to the wrong one. The recorded <see cref="AgentKey"/> is the
/// only valid endpoint, and deletion is never attempted against both "just in case".
/// </para>
/// </remarks>
public class HermesSessionDeletion
{
    public int Id { get; set; }

    /// <summary>The conversation this belonged to. Kept for the audit trail; the row is already gone.</summary>
    public int ConversationId { get; set; }

    /// <summary>Which agent's gateway holds this session. The only endpoint it may be sent to.</summary>
    public required string AgentKey { get; set; }

    public required string SessionId { get; set; }

    public DateTime RequestedAtUtc { get; set; }

    /// <summary>Set when the session is confirmed absent — deleted, or already gone.</summary>
    public DateTime? CompletedAtUtc { get; set; }

    /// <summary>How many times deletion has been attempted, for backoff and for giving up loudly.</summary>
    public int Attempts { get; set; }

    /// <summary>When to try again. Null means "as soon as the worker next runs".</summary>
    public DateTime? NextAttemptUtc { get; set; }

    /// <summary>The last failure, for an operator. Never contains a credential.</summary>
    public string? LastError { get; set; }
}
