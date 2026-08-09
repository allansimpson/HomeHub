namespace HomeHub.Api.Assist;

/// <summary>
/// Column lengths for the Assist tables, in one place so the controller can reject overlong input
/// against the same numbers the schema enforces — a literal in each would be a latent 500 the first
/// time somebody pastes a long recipe at the agent.
/// </summary>
public static class AssistFieldLimits
{
    /// <summary>Roster key, e.g. <c>barnaby</c>. Short by nature; it comes from config.</summary>
    public const int AgentKey = 60;

    /// <summary>Hermes session identifier. Generous — it is an opaque token from another system.</summary>
    public const int SessionId = 200;

    /// <summary>
    /// Chat title. The first user turn, trimmed to fit — the design's rows are single-line with an
    /// ellipsis, so anything past this was never going to be read anyway.
    /// </summary>
    public const int Title = 200;

    /// <summary>"user" or "assistant".</summary>
    public const int Role = 16;

    /// <summary>Local / Cloud / Agent.</summary>
    public const int Origin = 16;

    /// <summary>The IT TOUCHED action key ("task", "climate", …).</summary>
    public const int Action = 40;

    /// <summary>
    /// Largest prompt accepted in one turn. Not a schema limit — <c>Text</c> is nvarchar(max) — but a
    /// request cap, so a runaway client cannot write a megabyte per turn into a table the retention
    /// sweep only visits on read.
    /// </summary>
    public const int MaxPromptChars = 16_000;

    /// <summary>Shortest search that is worth running. One character matches everything.</summary>
    public const int MinSearchChars = 2;

    /// <summary>An attachment's file name, as the household's own device reported it.</summary>
    public const int AttachmentName = 260;

    /// <summary>`image` or `text` — what kind of thing was attached. See <c>AttachmentKinds</c>.</summary>
    public const int AttachmentKind = 16;

    /// <summary>
    /// Largest image accepted on one turn, in bytes of the original file.
    /// </summary>
    /// <remarks>
    /// Ten megabytes is roughly one modern phone photo at full resolution, which is the thing people
    /// actually attach. The panel downscales before sending wherever the browser can decode the format,
    /// so this is the ceiling for what it cannot — HEIC outside Safari, mostly — rather than a figure
    /// anybody should routinely hit. Base64 inflates by a third on the wire, so the request body stays
    /// inside Kestrel's default cap with room to spare.
    /// </remarks>
    public const int MaxImageBytes = 10 * 1024 * 1024;

    /// <summary>
    /// Largest text attachment, in characters.
    /// </summary>
    /// <remarks>
    /// Deliberately well under <see cref="MaxPromptChars"/>, because the two share a turn: the file's
    /// contents go to the agent as their own part alongside whatever the member typed, and a file that
    /// could fill the whole budget on its own would leave a household unable to ask a question about
    /// the thing they just attached.
    /// </remarks>
    public const int MaxAttachmentChars = 10_000;
}
