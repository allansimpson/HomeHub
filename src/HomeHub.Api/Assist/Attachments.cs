namespace HomeHub.Api.Assist;

/// <summary>
/// What a household can hand to an agent alongside a message.
/// </summary>
/// <remarks>
/// <para>
/// <b>Two kinds, because the far end takes two kinds.</b> A Hermes turn is a list of content parts,
/// and a part is either text or an image — uploaded-file identifiers are explicitly not accepted. So
/// "attach a file" can only ever mean one of two things here: a picture the model can look at, or
/// text it can read. A PDF is neither until something turns it into one of them, and pretending
/// otherwise would produce an attachment that uploads, appears to send, and silently is not there.
/// </para>
/// <para>
/// <b>Attachments are sent, not kept.</b> Neither the image bytes nor the file's text is written to
/// the ledger — only the name, the kind and the size, so the transcript can still say what was
/// attached. That rule is worth stating plainly because the alternative is easy to drift into: a
/// household's chat history is small and mostly text, and quietly turning it into a photo store is
/// the kind of decision nobody makes on purpose but everybody discovers later. What a member typed
/// is the record; what they handed over is a fact about the turn.
/// </para>
/// </remarks>
public static class AttachmentKinds
{
    /// <summary>A picture, submitted to the agent as a data URL.</summary>
    public const string Image = "image";

    /// <summary>
    /// A text-like file, submitted as its own text part.
    /// </summary>
    /// <remarks>
    /// Read and classified on the panel, which is the only place that has the file. The server never
    /// sees the original bytes for this kind — it receives the decoded characters, already capped.
    /// </remarks>
    public const string Text = "text";

    /// <summary>Whether this is a kind the server will act on. Anything else is treated as no attachment.</summary>
    public static bool IsKnown(string? kind) =>
        kind is Image or Text;
}

/// <summary>
/// One attachment on a turn, after the server has decided what it will believe about it.
/// </summary>
/// <param name="Name">The file's name, trimmed to fit the column.</param>
/// <param name="Kind">{@link AttachmentKinds.Image} or {@link AttachmentKinds.Text}.</param>
/// <param name="Bytes">The original file's size, for the transcript's meta line. Null when not stated.</param>
/// <param name="Text">A text file's contents, capped. Null for an image.</param>
public sealed record Attachment(string Name, string Kind, long? Bytes, string? Text)
{
    /// <summary>
    /// What the request is actually claiming to attach — or null, meaning nothing.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>One reading of the request, shared by both turn endpoints.</b> The streaming and awaited
    /// paths each build content, each persist, and each therefore each have to decide what an
    /// attachment is; two copies of that judgement is how a photo ends up reaching the agent down one
    /// path and not the other.
    /// </para>
    /// <para>
    /// Everything here is defensive against a caller that is not the panel. The kind must be one we
    /// know; the name is trimmed rather than rejected, because a long filename is not an attack and a
    /// 400 over one would be a turn lost to punctuation; the text is truncated at the cap rather than
    /// refused, for the same reason. What is <i>not</i> tolerated is a kind that claims to be text
    /// while carrying none, or an image with no data — those are not overlong input but incoherent
    /// input, and treating them as "no attachment" is the honest reading.
    /// </para>
    /// </remarks>
    public static Attachment? Read(AssistChatRequest req)
    {
        if (!AttachmentKinds.IsKnown(req.AttachmentKind)) return null;

        var kind = req.AttachmentKind!;

        // The payload has to actually be there. A text attachment with no text and an image
        // attachment with no bytes are both a name with nothing behind it.
        if (kind == AttachmentKinds.Text && string.IsNullOrEmpty(req.AttachmentText)) return null;
        if (kind == AttachmentKinds.Image && string.IsNullOrEmpty(req.ImageBase64)) return null;

        var name = (req.AttachmentName ?? "").Trim();
        if (name.Length == 0) name = kind == AttachmentKinds.Image ? "Photo" : "File";
        if (name.Length > AssistFieldLimits.AttachmentName) name = name[..AssistFieldLimits.AttachmentName];

        var text = req.AttachmentText;
        if (text is { Length: > AssistFieldLimits.MaxAttachmentChars })
            text = text[..AssistFieldLimits.MaxAttachmentChars];

        // Negative or absurd sizes are dropped rather than argued with. The figure is only ever drawn
        // on a meta line, so a missing one costs a few characters of context and nothing else.
        var bytes = req.AttachmentBytes is > 0 ? req.AttachmentBytes : null;

        return new Attachment(name, kind, bytes, kind == AttachmentKinds.Text ? text : null);
    }
}
