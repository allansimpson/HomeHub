namespace HomeHub.Api.Ai;

using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;

/// <summary>One thing that happened during a streamed turn.</summary>
public abstract record HermesStreamItem;

/// <summary>A fragment of the assistant's reply. Concatenated, these are the answer.</summary>
public sealed record HermesTextDelta(string Text) : HermesStreamItem;

/// <summary>
/// A fragment of the model's reasoning — what it is working through on the way to the answer.
/// </summary>
/// <remarks>
/// <b>Not the reply, and never concatenated into it.</b> Reasoning is the model talking to itself: it
/// contradicts itself, abandons lines of thought and reaches conclusions it then discards. Folding it
/// into <see cref="HermesTextDelta"/> would put sentences the agent decided *not* to say into a
/// transcript the household reads as what it did say — and into the ledger, permanently.
/// <para>
/// So it is carried separately, forwarded to the panel as its own event, shown only to a member who
/// asked to see it, and stored nowhere. A household that turns it on is asking to watch the working;
/// nobody is asking for the working to become the record.
/// </para>
/// <para>
/// Two field names because two conventions exist and Hermes fronts whichever provider it is routed
/// to: <c>reasoning_content</c> and <c>reasoning</c>. Neither is guaranteed to appear at all — a model
/// with no exposed reasoning simply never sends one, which is not a failure and needs no fallback.
/// </para>
/// </remarks>
public sealed record HermesReasoningDelta(string Text) : HermesStreamItem;

/// <summary>
/// A tool the agent is running — for the live "Barnaby is updating the bedroom climate…" line.
/// </summary>
/// <remarks>
/// <b>Never a receipt.</b> A tool that started is not a write that committed, and the human-readable
/// <see cref="Label"/> must never be parsed to reconstruct arguments. IT TOUCHED is driven by
/// HomeHub's own MCP audit, which is the only thing that knows whether the write landed.
/// </remarks>
public sealed record HermesToolProgress(string Tool, string? ToolCallId, string Status, string? Label)
    : HermesStreamItem
{
    public bool IsRunning => string.Equals(Status, "running", StringComparison.OrdinalIgnoreCase);
    public bool IsFinished => !IsRunning;

    /// <summary>The bare MCP method, with Hermes's runtime prefix stripped.</summary>
    /// <remarks>
    /// Hermes exposes our tools as <c>mcp__homehub__get_climate_zones</c>. It also emits progress for
    /// its own internal <c>tool_describe</c>, which is not ours and must not reach the household.
    /// </remarks>
    public string? HouseMethod =>
        Tool.StartsWith(HousePrefix, StringComparison.Ordinal) ? Tool[HousePrefix.Length..] : null;

    private const string HousePrefix = "mcp__homehub__";
}

/// <summary>
/// The stream ended, and whether it ended properly. **Always the last item.**
/// </summary>
/// <remarks>
/// <para>
/// Separate from <see cref="HermesTurnComplete"/> because they answer different questions.
/// <c>HermesTurnComplete</c> is the terminal chunk saying why the model stopped; this says whether
/// the transport actually delivered a finished turn. A connection dropped after two sentences
/// produces neither a terminal chunk nor <c>[DONE]</c> — but it does produce two sentences, and text
/// on screen is exactly what makes a truncated turn look like a complete one.
/// </para>
/// <para>
/// So completeness is asserted, never inferred: both the terminal chunk and <c>[DONE]</c> must have
/// arrived, in that order. Anything less is incomplete however much text was displayed.
/// </para>
/// </remarks>
/// <param name="Complete">A terminal chunk arrived, and <c>[DONE]</c> arrived after it.</param>
/// <param name="MalformedFrames">Frames skipped as unparseable. Zero on a healthy stream.</param>
public sealed record HermesStreamEnd(bool Complete, int MalformedFrames) : HermesStreamItem;

/// <summary>The turn finished. Carries what the terminal chunk actually reports.</summary>
/// <remarks>
/// Deliberately not a session id: the streaming response's <c>X-Hermes-Session-Id</c> header is
/// written before the run starts, and the terminal chunk carries no id either. Discovering a rotation
/// needs the post-stream reconciliation read.
/// </remarks>
public sealed record HermesTurnComplete(
    string? FinishReason, int? PromptTokens, int? CompletionTokens, int? TotalTokens) : HermesStreamItem;

/// <summary>
/// Reads a Hermes SSE stream into typed items.
/// </summary>
/// <remarks>
/// <para>
/// <b>Named events matter.</b> An earlier reader looked only at <c>data:</c> lines and pulled text
/// from <c>choices[0].delta.content</c>. That silently dropped every
/// <c>event: hermes.tool.progress</c> frame — which is where tool activity lives — because those
/// frames carry no <c>choices</c> at all. A frame with no event name is a Chat Completions chunk; a
/// named frame is a Hermes extension.
/// </para>
/// <para>
/// Structure of the wire, per the v0.20.0 gateway: an opening chunk carrying only
/// <c>delta.role</c>, then content chunks, then a terminal chunk with an empty delta plus
/// <c>finish_reason</c> and <c>usage</c>, then <c>data: [DONE]</c>. SSE comment lines (<c>: keepalive</c>)
/// appear during quiet periods and are not frames.
/// </para>
/// </remarks>
public static class HermesStream
{
    /// <summary>Parse an SSE byte stream into typed items.</summary>
    public static async IAsyncEnumerable<HermesStreamItem> ReadAsync(
        Stream stream, ILogger logger, [EnumeratorCancellation] CancellationToken ct)
    {
        using var reader = new StreamReader(stream, Encoding.UTF8);

        string? eventName = null;
        var data = new StringBuilder();
        var tally = new Tally();

        while (true)
        {
            var line = await reader.ReadLineAsync(ct);
            if (line is null) break; // stream closed

            // A blank line terminates a frame. Everything accumulated since the last one is it.
            if (line.Length == 0)
            {
                if (data.Length > 0)
                {
                    var payload = data.ToString();
                    data.Clear();
                    var name = eventName;
                    eventName = null;

                    if (payload == "[DONE]")
                    {
                        tally.SawDone = true;
                        break;
                    }

                    if (Parse(name, payload, logger, tally) is { } item)
                    {
                        if (item is HermesTurnComplete) tally.SawTerminal = true;
                        yield return item;
                    }
                }
                else
                {
                    eventName = null;
                }
                continue;
            }

            // SSE comments — keepalives — are not frames.
            if (line[0] == ':') continue;

            if (line.StartsWith("event:", StringComparison.Ordinal))
            {
                eventName = line[6..].Trim();
                continue;
            }

            if (line.StartsWith("data:", StringComparison.Ordinal))
            {
                // Multiple data: lines in one frame concatenate with newlines, per the SSE spec.
                if (data.Length > 0) data.Append('\n');
                data.Append(line[5..].TrimStart());
            }

            // Any other field (id:, retry:) is not used here.
        }

        // EOF with a frame still buffered. A frame is terminated by a blank line *or* by the end of
        // the stream, so this is a real frame, not a fragment — including a closing [DONE] from a
        // gateway that hangs up immediately after writing it, which is the common case and must
        // still count as a proper ending.
        if (data.Length > 0)
        {
            var trailingPayload = data.ToString();
            if (trailingPayload == "[DONE]")
            {
                tally.SawDone = true;
            }
            else if (Parse(eventName, trailingPayload, logger, tally) is { } trailing)
            {
                // Delivered rather than discarded: a final delta is worth keeping even when the
                // connection closed abruptly. It still does not make the turn complete.
                if (trailing is HermesTurnComplete) tally.SawTerminal = true;
                yield return trailing;
            }
        }

        if (tally.MalformedFrames > 0)
            // Worth a warning rather than the debug line the skip itself gets: one bad frame is a
            // curiosity, a stream full of them is a wire-format change, and the difference is only
            // visible in the total.
            logger.LogWarning(
                "Skipped {Count} unparseable SSE frame(s) from Hermes in one turn; the reply is missing "
              + "those fragments.", tally.MalformedFrames);

        yield return new HermesStreamEnd(tally.SawTerminal && tally.SawDone, tally.MalformedFrames);
    }

    /// <summary>Mutable running state; an iterator cannot hand these back through a return value.</summary>
    private sealed class Tally
    {
        public bool SawTerminal;
        public bool SawDone;
        public int MalformedFrames;
    }

    private static HermesStreamItem? Parse(string? eventName, string payload, ILogger logger, Tally tally)
    {
        JsonElement root;
        try
        {
            using var doc = JsonDocument.Parse(payload);
            root = doc.RootElement.Clone();
        }
        catch (JsonException)
        {
            // One malformed frame is not worth ending an otherwise healthy stream over. The reply is
            // missing that fragment, which the ledger will show.
            tally.MalformedFrames++;
            logger.LogDebug("Skipped an unparseable SSE frame from Hermes.");
            return null;
        }

        if (string.Equals(eventName, "hermes.tool.progress", StringComparison.Ordinal))
        {
            var tool = Str(root, "tool");
            if (tool is null) return null;
            return new HermesToolProgress(
                tool, Str(root, "toolCallId"), Str(root, "status") ?? "running", Str(root, "label"));
        }

        // Named events we do not model yet are ignored rather than guessed at.
        if (eventName is not null) return null;

        if (!root.TryGetProperty("choices", out var choices)
            || choices.ValueKind is not JsonValueKind.Array || choices.GetArrayLength() == 0)
            return null;

        var first = choices[0];

        if (first.TryGetProperty("delta", out var delta))
        {
            if (delta.TryGetProperty("content", out var content)
                && content.ValueKind is JsonValueKind.String
                && content.GetString() is { Length: > 0 } text)
                return new HermesTextDelta(text);

            // Checked after content, never instead of it: a chunk carrying both is carrying the reply
            // plus a note about it, and the reply is the part that must not be dropped.
            if ((Str(delta, "reasoning_content") ?? Str(delta, "reasoning")) is { Length: > 0 } thought)
                return new HermesReasoningDelta(thought);
        }

        // Terminal chunk: empty delta, a finish reason, and usage. The opening role-only chunk also
        // lands here with a null finish reason, and is correctly ignored.
        if (first.TryGetProperty("finish_reason", out var finish) && finish.ValueKind is JsonValueKind.String)
        {
            root.TryGetProperty("usage", out var usage);
            return new HermesTurnComplete(
                finish.GetString(),
                Int(usage, "prompt_tokens"), Int(usage, "completion_tokens"), Int(usage, "total_tokens"));
        }

        return null;
    }

    private static string? Str(JsonElement e, string name) =>
        e.ValueKind is JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind is JsonValueKind.String
            ? v.GetString() : null;

    private static int? Int(JsonElement e, string name) =>
        e.ValueKind is JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind is JsonValueKind.Number
            ? v.GetInt32() : null;
}
