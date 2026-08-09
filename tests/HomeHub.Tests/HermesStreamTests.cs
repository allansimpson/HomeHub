namespace HomeHub.Tests;

using System.Text;
using HomeHub.Api.Ai;
using Microsoft.Extensions.Logging.Abstractions;

/// <summary>
/// The SSE reader, against the exact frame shapes Hermes v0.20.0 emits.
/// </summary>
/// <remarks>
/// These exist because the first reader looked only at <c>data:</c> lines and pulled text from
/// <c>choices[0].delta.content</c>. That is correct for the reply and **silently discarded every
/// tool-progress frame**, which arrives as a named event carrying no <c>choices</c> at all. Nothing
/// failed; the information simply never arrived.
/// </remarks>
public class HermesStreamTests
{
    private static async Task<List<HermesStreamItem>> ReadAsync(string sse)
    {
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes(sse));
        var items = new List<HermesStreamItem>();
        await foreach (var i in HermesStream.ReadAsync(stream, NullLogger.Instance, CancellationToken.None))
            items.Add(i);
        return items;
    }

    /// <summary>A whole ordinary turn: role chunk, content, terminal chunk, [DONE].</summary>
    private const string OrdinaryTurn = """
        data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

        data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

        data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" there"},"finish_reason":null}]}

        data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":64995,"completion_tokens":5,"total_tokens":65000}}

        data: [DONE]

        """;

    [Fact]
    public async Task Text_deltas_are_read_and_the_role_chunk_is_not_mistaken_for_one()
    {
        var items = await ReadAsync(OrdinaryTurn);

        var text = string.Concat(items.OfType<HermesTextDelta>().Select(d => d.Text));
        Assert.Equal("Hello there", text);
        // The opening chunk carries only `delta.role` — it is not an empty message.
        Assert.Equal(2, items.OfType<HermesTextDelta>().Count());
    }

    [Fact]
    public async Task The_terminal_chunk_yields_finish_reason_and_usage()
    {
        var items = await ReadAsync(OrdinaryTurn);

        var done = Assert.Single(items.OfType<HermesTurnComplete>());
        Assert.Equal("stop", done.FinishReason);
        Assert.Equal(64995, done.PromptTokens);
        Assert.Equal(5, done.CompletionTokens);
        Assert.Equal(65000, done.TotalTokens);
    }

    [Fact]
    public async Task Nothing_is_yielded_after_DONE()
    {
        var items = await ReadAsync(OrdinaryTurn + """
            data: {"choices":[{"index":0,"delta":{"content":"should never arrive"},"finish_reason":null}]}

            """);

        Assert.DoesNotContain(items.OfType<HermesTextDelta>(), d => d.Text.Contains("never"));
    }

    [Fact]
    public async Task Named_tool_progress_events_are_read()
    {
        var items = await ReadAsync("""
            event: hermes.tool.progress
            data: {"tool":"mcp__homehub__set_climate_setpoint","emoji":"⚡","label":"mcp__homehub__set_climate_setpoint","toolCallId":"call_1","status":"running"}

            data: {"choices":[{"index":0,"delta":{"content":"Done."},"finish_reason":null}]}

            event: hermes.tool.progress
            data: {"tool":"mcp__homehub__set_climate_setpoint","toolCallId":"call_1","status":"completed"}

            data: [DONE]

            """);

        var progress = items.OfType<HermesToolProgress>().ToList();
        Assert.Equal(2, progress.Count);
        Assert.True(progress[0].IsRunning);
        Assert.True(progress[1].IsFinished);
        Assert.Equal("call_1", progress[0].ToolCallId);
        // Interleaved with, not instead of, the reply.
        Assert.Equal("Done.", string.Concat(items.OfType<HermesTextDelta>().Select(d => d.Text)));
    }

    [Fact]
    public async Task Hermes_internal_tools_are_distinguishable_from_ours()
    {
        var items = await ReadAsync("""
            event: hermes.tool.progress
            data: {"tool":"tool_describe","toolCallId":"c0","status":"running"}

            event: hermes.tool.progress
            data: {"tool":"mcp__homehub__get_climate_zones","toolCallId":"c1","status":"running"}

            data: [DONE]

            """);

        var progress = items.OfType<HermesToolProgress>().ToList();

        // Hermes emits progress for its own `tool_describe` before ours. Showing "Barnaby is doing
        // something" for that would be noise the household cannot act on.
        Assert.Null(progress[0].HouseMethod);
        Assert.Equal("get_climate_zones", progress[1].HouseMethod);
    }

    [Fact]
    public async Task Keepalive_comments_and_blank_frames_are_ignored()
    {
        var items = await ReadAsync("""
            : keepalive

            data: {"choices":[{"index":0,"delta":{"content":"a"},"finish_reason":null}]}

            : keepalive

            data: [DONE]

            """);

        Assert.Equal("a", string.Concat(items.OfType<HermesTextDelta>().Select(d => d.Text)));
    }

    [Fact]
    public async Task An_unparseable_frame_does_not_end_the_stream()
    {
        var items = await ReadAsync("""
            data: {"choices":[{"index":0,"delta":{"content":"before"},"finish_reason":null}]}

            data: {not json at all

            data: {"choices":[{"index":0,"delta":{"content":"after"},"finish_reason":null}]}

            data: [DONE]

            """);

        // One bad frame costs that fragment, not the rest of the reply.
        Assert.Equal("beforeafter", string.Concat(items.OfType<HermesTextDelta>().Select(d => d.Text)));
    }

    [Fact]
    public async Task A_stream_cut_short_still_delivers_what_arrived()
    {
        // No terminal chunk, no [DONE] — the connection simply ended.
        var items = await ReadAsync("""
            data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}

            """);

        Assert.Equal("partial", string.Concat(items.OfType<HermesTextDelta>().Select(d => d.Text)));
        // And no completion was invented for a turn that never finished.
        Assert.Empty(items.OfType<HermesTurnComplete>());
    }

    [Fact]
    public async Task A_length_or_error_finish_is_reported_rather_than_treated_as_success()
    {
        var items = await ReadAsync("""
            data: {"choices":[{"index":0,"delta":{"content":"cut"},"finish_reason":null}]}

            data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}

            data: [DONE]

            """);

        var done = Assert.Single(items.OfType<HermesTurnComplete>());
        Assert.Equal("length", done.FinishReason);
        Assert.Null(done.TotalTokens); // usage is absent here, and absence is not zero
    }

    [Fact]
    public async Task An_unknown_named_event_is_ignored_rather_than_guessed_at()
    {
        var items = await ReadAsync("""
            event: hermes.something.new
            data: {"whatever":true}

            data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}

            data: [DONE]

            """);

        Assert.Equal("ok", string.Concat(items.OfType<HermesTextDelta>().Select(d => d.Text)));

        // The unknown event contributed nothing — one delta, plus the end marker every stream ends
        // with. Guessing at an unmodelled frame is how a tool call becomes a sentence.
        Assert.Equal(2, items.Count);
        Assert.IsType<HermesStreamEnd>(items[^1]);
    }

    // ---- "some text arrived" is not "the turn finished" ----

    [Fact]
    public async Task A_whole_turn_ends_complete()
    {
        var end = (HermesStreamEnd)(await ReadAsync(OrdinaryTurn))[^1];

        Assert.True(end.Complete);
        Assert.Equal(0, end.MalformedFrames);
    }

    [Fact]
    public async Task A_gateway_that_hangs_up_right_after_DONE_still_ends_complete()
    {
        // No blank line after the final frame — the stream just closes. A frame is terminated by a
        // blank line *or* by the end of the stream, and closing straight after [DONE] is what a real
        // gateway does; reading that as an unterminated fragment would mark every healthy turn
        // incomplete, which is how a correctness guard becomes noise everyone learns to ignore.
        var end = (HermesStreamEnd)(await ReadAsync(OrdinaryTurn.TrimEnd()))[^1];

        Assert.True(end.Complete);
    }

    [Theory]
    // Text, then nothing. The connection died mid-reply.
    [InlineData(CutOffMidReply)]
    // A terminal chunk, but the stream died before [DONE].
    [InlineData(NoDone)]
    // [DONE] with no terminal chunk before it — framed, but the model never said it finished.
    [InlineData(NoTerminalChunk)]
    public async Task A_turn_that_did_not_finish_is_never_reported_complete(string sse)
    {
        var items = await ReadAsync(sse);
        var end = (HermesStreamEnd)items[^1];

        // The text still arrives — a partial answer beats a blank one.
        Assert.Equal("partial", string.Concat(items.OfType<HermesTextDelta>().Select(d => d.Text)));

        // But it is exactly the text on screen that makes a severed turn look finished, so
        // completeness must never be inferred from it.
        Assert.False(end.Complete);
    }

    private const string CutOffMidReply = """
        data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}

        """;

    private const string NoDone = """
        data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}

        data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

        """;

    private const string NoTerminalChunk = """
        data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}

        data: [DONE]

        """;

    [Fact]
    public async Task Skipped_frames_are_counted_rather_than_only_shrugged_at()
    {
        var items = await ReadAsync("""
            data: {"choices":[{"index":0,"delta":{"content":"a"},"finish_reason":null}]}

            data: {not json

            data: also not json

            data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

            data: [DONE]

            """);

        // One bad frame is a curiosity; a stream full of them is a wire-format change, and only the
        // count tells them apart.
        Assert.Equal(2, ((HermesStreamEnd)items[^1]).MalformedFrames);
        Assert.True(((HermesStreamEnd)items[^1]).Complete);
    }

    /*
     * Reasoning — the working, kept apart from the answer.
     *
     * The thing worth protecting is the separation, not the parsing. A reasoning fragment that
     * arrived as a `HermesTextDelta` would be concatenated into the reply and written to the ledger,
     * which would put sentences the agent decided *not* to say into the record of what it said.
     */

    [Fact]
    public async Task Reasoning_deltas_are_read_under_either_field_name()
    {
        var items = await ReadAsync("""
            data: {"choices":[{"index":0,"delta":{"reasoning_content":"Bins are "},"finish_reason":null}]}

            data: {"choices":[{"index":0,"delta":{"reasoning":"on Tuesdays."},"finish_reason":null}]}

            data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

            data: [DONE]

            """);

        // Both conventions exist upstream, and Hermes fronts whichever provider it is routed to.
        Assert.Equal(
            ["Bins are ", "on Tuesdays."],
            items.OfType<HermesReasoningDelta>().Select(r => r.Text));
    }

    [Fact]
    public async Task Reasoning_is_never_read_as_reply_text()
    {
        var items = await ReadAsync("""
            data: {"choices":[{"index":0,"delta":{"reasoning_content":"Let me check the calendar."},"finish_reason":null}]}

            data: {"choices":[{"index":0,"delta":{"content":"Tuesday."},"finish_reason":null}]}

            data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

            data: [DONE]

            """);

        // The reply is one word. Everything else the model produced is a separate kind of item.
        Assert.Equal(["Tuesday."], items.OfType<HermesTextDelta>().Select(t => t.Text));
        Assert.Single(items.OfType<HermesReasoningDelta>());
    }

    [Fact]
    public async Task A_chunk_carrying_both_yields_the_reply()
    {
        var items = await ReadAsync("""
            data: {"choices":[{"index":0,"delta":{"content":"Tuesday.","reasoning_content":"…"},"finish_reason":null}]}

            data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

            data: [DONE]

            """);

        // One item per frame, and when there is a choice to make the answer is the half that must not
        // be dropped — a lost note about the reply costs nothing, a lost sentence of the reply is a
        // hole in the transcript.
        Assert.Equal(["Tuesday."], items.OfType<HermesTextDelta>().Select(t => t.Text));
        Assert.Empty(items.OfType<HermesReasoningDelta>());
    }
}
