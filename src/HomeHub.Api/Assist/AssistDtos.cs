namespace HomeHub.Api.Assist;

/// <summary>One agent on the roster, as the header and the dropdown need it (ASSIST.md · `1d`).</summary>
/// <param name="Unread">
/// Unread chats this member has with *this* agent. The dropdown badge exists so nothing hides behind
/// the switch — an unread count that only appeared once you had already switched would defeat it.
/// </param>
/// <param name="Configured">
/// Whether this agent has an address and a credential — <b>not</b> whether it is reachable. Knowing
/// that would need a network call per list read, and the list is polled. A configured-but-down agent
/// still shows: its conversations are readable either way, and the turn is what discovers the outage.
/// </param>
/// <param name="IsDefault">
/// The one Assist opens on <b>for this member</b> — their own choice where they made one, and the
/// household agent otherwise. Deliberately the member's answer rather than the roster's: this list is
/// scoped to one person, and a flag on it that meant "the household's default" would be a fact about
/// the deployment sitting in the middle of a per-member payload, useful to nobody reading it.
/// </param>
public record AgentDto(string Key, string Name, string? Tagline, bool IsDefault, bool Configured, int Unread);

/// <summary>One agent as the Config assignment editor sees it — every configured agent, granted or not.</summary>
/// <param name="Configured">
/// Whether the agent has an address and a credential. An unconfigured entry is still assignable —
/// the household may be setting it up in the other order — but Config says so rather than letting a
/// member be given something that cannot answer.
/// </param>
/// <param name="IsHouseholdAgent">
/// The household agent. Always assigned and not removable: a member with no agent would have an
/// Assist tab that cannot do anything, which is not a state worth being able to reach.
/// </param>
/// <param name="IsMemberDefault">
/// The one Assist opens on for this member. Exactly one row carries it, and with no choice made it is
/// the household agent's — so the editor can draw the state without a second, emptier answer for
/// "nobody has decided".
/// </param>
public record AssignableAgentDto(
    string Key,
    string Name,
    string? Tagline,
    bool Configured,
    bool IsHouseholdAgent,
    bool Assigned,
    bool IsMemberDefault);

/// <summary>What one member may be given, what they currently have, and which one opens.</summary>
public record AgentAssignmentsDto(IReadOnlyList<AssignableAgentDto> Agents);

/// <summary>
/// A member's full agent list. Whole-list rather than grant/revoke so two editors cannot interleave
/// into a set neither chose.
/// </summary>
public record SetAgentAssignmentsRequest(IReadOnlyList<string>? AgentKeys);

/// <summary>
/// Which of a member's agents Assist opens on. Null or the household agent means "no preference".
/// </summary>
/// <remarks>
/// Its own request rather than a field on <see cref="SetAgentAssignmentsRequest"/>, because that one
/// is a whole-list replace: a default carried on it would be cleared by every assignment edit that
/// did not think to restate it.
/// </remarks>
public record SetDefaultAgentRequest(string? AgentKey);

/// <summary>A row in the conversation list.</summary>
/// <param name="Speaker">
/// Who spoke last — the member's name or the agent's — for the row's `Speaker — preview` prefix.
/// </param>
/// <param name="Preview">The last message, one line. Empty for a chat with no turns yet.</param>
/// <param name="Unread">
/// Derived from <c>LastAtUtc &gt; ReadAtUtc</c> rather than stored, so a reply arriving from the
/// phone makes the panel's row bold without a second write to keep in step.
/// </param>
/// <param name="UnreadCount">Messages since the member last opened it — the brass count badge.</param>
public record ConversationDto(
    int Id,
    string AgentKey,
    string Title,
    string Speaker,
    string Preview,
    DateTime StartedAtUtc,
    DateTime LastAtUtc,
    bool Pinned,
    DateTime? ArchivedAtUtc,
    bool Unread,
    int UnreadCount,
    int MessageCount);

/// <summary>The Assist list payload — everything the main screen renders in one call.</summary>
/// <param name="ArchivedCount">
/// Drives the `ARCHIVED CHATS (n)` footer row, which is the only entry point to the archive.
/// </param>
/// <param name="StoreConversations">
/// False means the household has turned storing off. The list is then empty by policy rather than by
/// coincidence, and the screen says so instead of showing the ordinary "No conversations yet".
/// </param>
public record ConversationListDto(
    IReadOnlyList<ConversationDto> Conversations,
    int ArchivedCount,
    bool StoreConversations,
    int RetentionDays,
    IReadOnlyList<AgentDto> Agents);

/// <summary>One turn, as the transcript renders it.</summary>
/// <param name="AttachmentName">
/// What was handed over with this turn, if anything — the file's name, kept so the transcript can
/// still say so after the fact. The contents are not stored; see <see cref="AttachmentKinds"/>.
/// </param>
public record MessageDto(
    int Id, string Role, string Text, DateTime AtUtc, string? Origin, bool Escalated, string? Action,
    string? AttachmentName = null, string? AttachmentKind = null, long? AttachmentBytes = null);

/// <summary>A conversation with its turns. Fetching this marks it read.</summary>
public record ConversationDetailDto(ConversationDto Conversation, IReadOnlyList<MessageDto> Messages);

/// <summary>
/// A chat turn. **No history array** — that is the change from <c>AssistantChatRequest</c>.
/// </summary>
/// <remarks>
/// The old endpoint took the transcript from the client every turn, which was the only option while
/// the transcript lived in the panel's <c>localStorage</c>. Now the server holds it, so sending it
/// back would let a client rewrite its own history — and with Hermes sessions there is no history to
/// send at all, because the session is the context.
/// <para>
/// Omitting <see cref="ConversationId"/> starts a new chat. That is what "typing in the composer
/// starts a new chat" means: there is no NEW CHAT button to press, so the absence of an id is the
/// signal.
/// </para>
/// </remarks>
public record AssistChatRequest(
    int? ConversationId,
    string? AgentKey,
    string? Prompt,
    string? ImageBase64,
    string? ImageMediaType,
    string? Force,
    // No ProfileId. It was a field on this record and the server wrote conversations against
    // whatever the caller put in it (AUDIT A1.2) — so a chat could be filed into somebody else's
    // history by asking. The member now comes from the session, and there is nothing here to send.
    bool Spoken = false,
    /// <summary>What the attached file was called on the member's own device. Shown in the transcript.</summary>
    /// <remarks>
    /// Trailing, and after <see cref="Spoken"/> rather than beside the image fields it belongs with.
    /// This record is constructed positionally in a dozen tests and by the voice bridge, so inserting
    /// a parameter in the middle silently re-binds every one of those arguments to the wrong field.
    /// Grouping reads better; not breaking every existing caller matters more.
    /// </remarks>
    string? AttachmentName = null,
    /// <summary>`image` or `text` — see <see cref="AttachmentKinds"/>. Anything else is ignored.</summary>
    string? AttachmentKind = null,
    /// <summary>The original file's size in bytes, for the transcript. Never trusted for anything else.</summary>
    long? AttachmentBytes = null,
    /// <summary>
    /// A text-like file's contents, read on the panel.
    /// </summary>
    /// <remarks>
    /// Separate from <see cref="Prompt"/> rather than pasted into it, and that separation is the whole
    /// point: the prompt is what the member said and is what the ledger stores, while this is what
    /// they handed over. Folding a file into the prompt would put ten thousand characters of CSV into
    /// the household's transcript under somebody's name.
    /// </remarks>
    string? AttachmentText = null);

/// <summary>The reply, plus the conversation it landed in (new or existing).</summary>
public record AssistChatResponse(
    int ConversationId, string Title, MessageDto Message, string Origin, bool Escalated, string? Model);

/// <summary>Pin, archive, mark-read or rename a single chat — the swipe gestures, opening a row, and
/// the header's rename.</summary>
/// <remarks>
/// Every field is nullable and absent means <i>leave it alone</i>, the same rule the rest of the app
/// follows: not stating a thing must never overwrite a thing somebody stated. A swipe-to-pin must not
/// silently unarchive, and it must certainly not rename anything.
/// </remarks>
/// <param name="Title">
/// A name the household typed. Distinct from every other title the system writes, because this one is
/// a person's: <see cref="ConversationTitler"/> will never overwrite it.
/// </param>
public record UpdateConversationRequest(bool? Pinned, bool? Archived, bool? Read, string? Title = null);

/// <summary>The multi-select delete (ASSIST.md · `1g`).</summary>
public record DeleteConversationsRequest(IReadOnlyList<int> Ids);

/// <summary>
/// What the delete actually managed to do.
/// </summary>
/// <param name="AgentTranscriptsRemoved">
/// How many Hermes <b>sessions</b> were dropped alongside the household's copy — which is not the
/// same number as <c>Deleted</c>, and is not meant to be: one conversation can span several Hermes
/// sessions once it has compressed, and each is a separate delete.
/// <para>
/// Short of the lineage total means some transcripts survive on the agent — the agent was
/// unreachable, or a session had already gone. Reported rather than assumed away, because the gap
/// between what the modal said and what happened is the thing nobody would otherwise discover.
/// </para>
/// <para>
/// Note what this count does <b>not</b> cover: Hermes's long-term memory. Deleting a session removes
/// the transcript, not <c>MEMORY.md</c>, <c>USER.md</c>, Honcho observations, or anything the agent
/// copied into a skill. The household is told exactly that.
/// </para>
/// </param>
public record DeleteConversationsResponse(int Deleted, int AgentTranscriptsRemoved);

/// <summary>One hit — search is per **match**, not per chat (ASSIST.md · `1i`).</summary>
/// <param name="Snippet">The matching line, windowed around the term with ellipses.</param>
/// <param name="MatchStart">Offset of the term within <see cref="Snippet"/>, for the brass highlight.</param>
public record SearchHitDto(
    int ConversationId,
    string Title,
    DateTime AtUtc,
    bool Archived,
    string Snippet,
    int MatchStart,
    int MatchLength);

/// <summary>Search results plus the header line: `n MATCHES · n CONVERSATIONS · INCLUDES ARCHIVE`.</summary>
public record SearchResultsDto(IReadOnlyList<SearchHitDto> Hits, int Matches, int Conversations);

/// <summary>
/// What became of a turn whose stream the panel lost — see <c>AssistController.TurnState</c>.
/// </summary>
/// <param name="Status">
/// <c>running</c> — still being written, ask again shortly. <c>done</c> — finished, and the rest of
/// this record says how. There is no <c>failed</c>: a turn that could not run at all never got far
/// enough to be worth remembering, and a 404 already means "read the transcript instead", which is
/// the same recovery.
/// </param>
/// <param name="ConversationId">The chat it landed in, or 0 when the household stores none.</param>
/// <param name="MessageId">The stored reply, or 0 when nothing was stored.</param>
/// <param name="FinishReason">Why the reply stops where it does. Null while it is still running.</param>
/// <param name="Text">
/// The reply itself, kept because for a household with conversation storage switched off the stream
/// was the only copy — so a panel that lost it has nowhere else to read the answer from.
/// </param>
/// <param name="Action">The kind of write the turn made, for the IT TOUCHED receipt.</param>
public record TurnStatusDto(
    string Status,
    int ConversationId,
    int MessageId,
    string? FinishReason,
    string? Text,
    string? Action);
