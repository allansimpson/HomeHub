namespace HomeHub.Api.Assist;

/// <summary>
/// One Hermes session this conversation has ever occupied.
/// </summary>
/// <remarks>
/// <para>
/// <b>Corrected 2026-08-06.</b> An earlier version of this comment said compression always ends a
/// session and starts a child, so a conversation that had compressed twice was three Hermes rows.
/// That is the *legacy* mode. Both deployed profiles run <b>in-place compaction</b>
/// (<c>compression.in_place: true</c>, the default): the active message set is rewritten under the
/// **same id**, pre-compaction rows are soft-archived, no child is created, and **nothing rotates**.
/// On this deployment a conversation is normally one Hermes session for its whole life.
/// </para>
/// <para>
/// <b>So why keep the table.</b> Three reasons, none of them the ordinary path:
/// <list type="bullet">
/// <item>A profile configured with <c>in_place: false</c> does rotate, and the code has to be right
/// the first time rather than after someone notices transcripts surviving deletion.</item>
/// <item>Forks and delegate children are real rows with real transcripts.</item>
/// <item>An interrupted turn or a failed deletion can leave an id nothing else has a record of.</item>
/// </list>
/// </para>
/// <para>
/// The reason any of it matters is <c>DELETE /api/sessions/{id}</c>: it deletes exactly one row, does
/// not walk a chain, and orphans surviving compression children rather than cascading. Where a
/// lineage *does* exist, deleting only the current id would report success and leave most of a
/// conversation behind.
/// </para>
/// </remarks>
public class HermesSessionReference
{
    public int Id { get; set; }

    public int ConversationId { get; set; }

    public Conversation? Conversation { get; set; }

    /// <summary>
    /// The profile this session lives under.
    /// </summary>
    /// <remarks>
    /// Denormalised from the conversation on purpose. A session ID is meaningless without knowing
    /// which profile's <c>state.db</c> holds it — Barnaby's cannot see Geist's — so the deletion path
    /// must never have to infer the profile from a row that may since have been re-assigned.
    /// </remarks>
    public required string AgentKey { get; set; }

    public required string SessionId { get; set; }

    /// <summary>When HomeHub first saw this ID — by observing a rotation, or by backfill.</summary>
    public DateTime DiscoveredAtUtc { get; set; }

    /// <summary>
    /// Whether this is the session a new turn should enter at. Exactly one per conversation.
    /// </summary>
    /// <remarks>
    /// Duplicated with <see cref="Conversation.HermesSessionId"/> deliberately: the conversation's
    /// field is the hot read on every turn, and this flag keeps the lineage table independently
    /// interpretable — which is what a repair tool needs when the two disagree.
    /// </remarks>
    public bool IsCurrent { get; set; }
}
