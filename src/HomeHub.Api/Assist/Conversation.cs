namespace HomeHub.Api.Assist;

/// <summary>
/// One chat between a household member and an agent (ASSIST.md · Agents).
///
/// <b>Why HomeHub owns this table.</b> `ai-assistant.md` argued that no HomeHub table should hold
/// conversation — the store was Hermes's, in Hermes's process. That held while Assist was a
/// panel-local overlay. It does not survive the revamped design, which needs unread state, pinning,
/// archiving, titles and per-member scoping visible from both the panel and a phone, plus
/// full-transcript search matched on the home server. None of that is memory; it is *inbox
/// metadata*, and Hermes has no reason to hold it.
///
/// So the split is: **HomeHub owns the ledger, Hermes owns the memory.** <see cref="HermesSessionId"/>
/// and <see cref="SessionReferences"/> are the join between them: the delete path drops our rows *and*
/// every Hermes session in the conversation's lineage.
///
/// <para>
/// <b>What deletion does not do.</b> An earlier version of this comment said the delete removes the
/// conversation "from the agent's memory". That was false, and the UI copy that repeated it has been
/// corrected. <c>DELETE /api/sessions/{id}</c> removes *transcripts*; it leaves Hermes's long-term
/// memory — <c>MEMORY.md</c>, <c>USER.md</c>, Honcho observations, anything the agent copied into a
/// skill — untouched. The household is told exactly that:
/// <i>"This removes it from HomeHub and deletes its Hermes transcripts. Facts the assistant
/// previously saved to long-term memory may remain."</i>
/// </para>
///
/// Scoped to <c>(ProfileId, AgentKey)</c>: switching agents switches the entire conversation list,
/// and a conversation never changes agent once it has a message (HERMES_INTEGRATION.md · I1).
/// </summary>
public class Conversation
{
    public int Id { get; set; }

    /// <summary>The member whose list this chat appears in. Null is the guest/unsigned-in panel.</summary>
    public int? ProfileId { get; set; }

    /// <summary>
    /// Which agent holds this conversation — the key from the <c>Ai:Agents</c> roster.
    ///
    /// Not a foreign key, deliberately: the roster is configuration (an endpoint and a credential),
    /// not household data, and a config edit must not be able to cascade-delete a family's chat
    /// history. An unknown key renders as an unavailable agent instead of vanishing.
    /// </summary>
    public required string AgentKey { get; set; }

    /// <summary>
    /// The Hermes session a new turn should enter at, or null when the agent path was never reached
    /// (the canned fallback answered, or Hermes has no Sessions API behind its proxy).
    /// </summary>
    /// <remarks>
    /// <b>The current descendant, not the only one.</b> Hermes rotates a session into a child when it
    /// compresses, and the ancestors survive with their messages. Every ID this conversation has ever
    /// occupied is kept in <see cref="SessionReferences"/> — see
    /// <see cref="HermesSessionReference"/> for why deletion depends on it.
    /// </remarks>
    public string? HermesSessionId { get; set; }

    /// <summary>Display title — the first user turn, as the overlay already did.</summary>
    public required string Title { get; set; }

    public DateTime StartedAtUtc { get; set; }

    /// <summary>Time of the newest message. The list sorts on this, under the pinned ones.</summary>
    public DateTime LastAtUtc { get; set; }

    /// <summary>Swipe right. Pinned chats sort into their own section above CONVERSATIONS.</summary>
    public bool Pinned { get; set; }

    /// <summary>
    /// Swipe left. Null is active; set is archived, and the date is shown verbatim by the archive row
    /// (`ARCHIVED JUL 30 · 41 MESSAGES`). Archived chats stay searchable and keep feeding the agent's
    /// memory — this flag moves them out of the list, it does not tell Hermes anything.
    /// </summary>
    public DateTime? ArchivedAtUtc { get; set; }

    /// <summary>
    /// When the member last opened this chat. Unread is <c>LastAtUtc &gt; ReadAtUtc</c> — derived
    /// rather than stored, so a reply arriving from the phone makes the panel's row bold with no
    /// second write to keep in step.
    /// </summary>
    public DateTime? ReadAtUtc { get; set; }

    public List<ConversationMessage> Messages { get; set; } = [];

    /// <summary>Every Hermes session this conversation has occupied, current one included.</summary>
    public List<HermesSessionReference> SessionReferences { get; set; } = [];
}

/// <summary>
/// One turn. Mirrors the client's <c>HistoryTurn</c> field for field, so the transcript renders the
/// same origin tag and IT TOUCHED receipt it does today.
/// </summary>
public class ConversationMessage
{
    public int Id { get; set; }

    public int ConversationId { get; set; }

    public Conversation? Conversation { get; set; }

    /// <summary>"user" or "assistant".</summary>
    public required string Role { get; set; }

    public required string Text { get; set; }

    public DateTime AtUtc { get; set; }

    /// <summary>Which backend answered — <c>Local</c> / <c>Cloud</c> / <c>Agent</c>. Null on user turns.</summary>
    public string? Origin { get; set; }

    /// <summary>Whether a low-confidence local answer was escalated. Renders as the `↑` on the tag.</summary>
    public bool Escalated { get; set; }

    /// <summary>
    /// The kind of in-app write this turn performed, verbatim from <c>AssistantChatResponse.Action</c>.
    ///
    /// Stored per turn rather than derived, for the reason the client already gives: IT TOUCHED is a
    /// receipt, and re-deducing after the fact what a reply probably changed is exactly the guess a
    /// receipt must not make.
    /// </summary>
    public string? Action { get; set; }

    /// <summary>
    /// What was handed over with this turn — the file's name, or null when nothing was.
    /// </summary>
    /// <remarks>
    /// <b>The name, not the thing.</b> Neither an image's bytes nor a text file's contents are stored
    /// here; see <see cref="AttachmentKinds"/> for why. What this exists for is narrower and still
    /// worth having: without it, a member attaches a photo, sends it, and the moment the stored
    /// transcript reloads their message reads as though they had asked about nothing at all. On a
    /// shared panel the person reading that turn is often not the person who sent it, and a question
    /// about a picture nobody can see is not a question.
    /// </remarks>
    public string? AttachmentName { get; set; }

    /// <summary>`image` or `text` — see <see cref="AttachmentKinds"/>.</summary>
    public string? AttachmentKind { get; set; }

    /// <summary>The original file's size in bytes, for the transcript's meta line.</summary>
    public long? AttachmentBytes { get; set; }
}
