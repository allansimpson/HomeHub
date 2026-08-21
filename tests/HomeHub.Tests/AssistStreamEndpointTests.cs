namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using HomeHub.Api.Assist;
using Microsoft.Extensions.DependencyInjection;

/// <summary>
/// The browser-facing stream: <c>POST /api/assist/chat/stream</c>.
/// </summary>
/// <remarks>
/// What these protect is a feeling rather than a value — that the panel starts answering before the
/// answer exists. So they assert the *shape and order* of what reaches the browser, not just that the
/// right text eventually arrives: an endpoint that buffered the whole reply and sent it as one delta
/// would satisfy a naive "the reply is correct" test and be exactly the regression worth catching.
/// </remarks>
public class AssistStreamEndpointTests
{
    private sealed record Frame(string Event, JsonElement Data);

    [Fact]
    public async Task A_member_cannot_stream_into_another_members_conversation()
    {
        using var app = new HubAppFactory();
        var owner = app.CreateSeededClient(profileId: 1);
        var attacker = app.CreateSeededClient(profileId: 2);
        var startedResponse = await owner.PostAsJsonAsync(
            "/api/assist/chat", new AssistChatRequest(null, null, "Private household question", null, null, null));
        startedResponse.EnsureSuccessStatusCode();
        var started = (await startedResponse.Content.ReadFromJsonAsync<AssistChatResponse>())!;

        using var response = await attacker.PostAsJsonAsync(
            "/api/assist/chat/stream",
            new AssistChatRequest(started.ConversationId, null, "Injected follow-up", null, null, null));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        var detail = await owner.GetFromJsonAsync<ConversationDetailDto>(
            $"/api/assist/conversations/{started.ConversationId}");
        Assert.Equal(2, detail!.Messages.Count);
    }

    /// <summary>Open the stream and check the headers that make it one.</summary>
    private static async Task<HttpResponseMessage> OpenAsync(
        HttpClient client, AssistChatRequest req, CancellationToken ct = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/assist/chat/stream")
        {
            Content = JsonContent.Create(req),
        };
        var res = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        res.EnsureSuccessStatusCode();

        Assert.Equal("text/event-stream", res.Content.Headers.ContentType?.MediaType);
        // Proxies buffer by default; without this the stream arrives as one lump at the end.
        Assert.Equal("no", res.Headers.TryGetValues("X-Accel-Buffering", out var v) ? v.FirstOrDefault() : null);

        return res;
    }

    /// <summary>
    /// Frames as they arrive, rather than as a finished list.
    /// </summary>
    /// <remarks>
    /// The tests about what happens <i>during</i> a turn need this: leaving mid-reply and stopping
    /// mid-reply are both things done at a particular frame, and a helper that returns only when the
    /// stream is over cannot express either.
    /// </remarks>
    private static async IAsyncEnumerable<Frame> FramesAsync(
        StreamReader reader, [EnumeratorCancellation] CancellationToken ct = default)
    {
        string? name = null;
        var data = new StringBuilder();
        while (await reader.ReadLineAsync(ct) is { } line)
        {
            if (line.Length == 0)
            {
                if (data.Length > 0 && name is not null)
                    yield return new Frame(name, JsonDocument.Parse(data.ToString()).RootElement.Clone());
                name = null;
                data.Clear();
                continue;
            }
            // Comment frames — the keepalive that stops an intermediary reaping a turn that is
            // thinking. The browser's parser ignores them and so does this one.
            if (line.StartsWith(':')) continue;
            if (line.StartsWith("event:", StringComparison.Ordinal)) name = line[6..].Trim();
            else if (line.StartsWith("data:", StringComparison.Ordinal)) data.Append(line[5..].TrimStart());
        }
    }

    /// <summary>Read the SSE response into frames, in the order they were written.</summary>
    private static async Task<List<Frame>> StreamAsync(HttpClient client, AssistChatRequest req)
    {
        using var res = await OpenAsync(client, req);
        using var reader = new StreamReader(await res.Content.ReadAsStreamAsync(), Encoding.UTF8);

        var frames = new List<Frame>();
        await foreach (var frame in FramesAsync(reader)) frames.Add(frame);
        return frames;
    }

    /// <summary>The chat this member has, once one exists. Null if it never does.</summary>
    private static async Task<ConversationDetailDto?> AwaitStoredChatAsync(HttpClient client, int expectedMessages)
    {
        // Generous, because what is being waited for is a turn finishing on its own after the reader
        // has gone — and the failure being guarded against is that it never does.
        var deadline = DateTime.UtcNow.AddSeconds(15);
        while (DateTime.UtcNow < deadline)
        {
            var list = await client.GetFromJsonAsync<ConversationListDto>("/api/assist/conversations?profileId=1");
            if (list!.Conversations.Count > 0)
            {
                var detail = await client.GetFromJsonAsync<ConversationDetailDto>(
                    $"/api/assist/conversations/{list.Conversations[0].Id}");
                if (detail!.Messages.Count >= expectedMessages) return detail;
            }
            await Task.Delay(100);
        }
        return null;
    }

    [Fact]
    public async Task Deltas_arrive_separately_and_in_order()
    {
        using var gateway = new StubHermes();
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        var client = app.CreateSeededClient();

        var frames = await StreamAsync(client, new AssistChatRequest(null, "barnaby", "Bins tonight?", null, null, null));

        var deltas = frames.Where(f => f.Event == "delta").Select(f => f.Data.GetProperty("text").GetString()).ToList();

        // Two fragments, forwarded as two frames. One combined frame would mean the endpoint
        // accumulated the reply before sending — the thing streaming exists not to do.
        Assert.Equal(["Stub ", "reply."], deltas);
    }

    /// <summary>
    /// The same question, asked twice, opens two chats.
    /// </summary>
    /// <remarks>
    /// <para>
    /// HomeHub names a Hermes session after the words that opened it, and Hermes will not hold two
    /// sessions of one name. So the second "tell me a joke" was refused a session, and a turn with no
    /// session is not attempted: the panel said the assistant was unreachable while that same agent
    /// answered every conversation that already existed — those carry a session id and never ask for
    /// another. It read as a broken app, a broken phone, and a broken agent in turn, and it was none
    /// of them. Households repeat themselves; that is what a household assistant is for.
    /// </para>
    /// <para>
    /// Asserted through the stream rather than at the client, because "unreachable" is what the
    /// member saw and this is the seam that says it.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_question_asked_before_still_opens_a_chat()
    {
        using var gateway = new StubHermes();
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        var client = app.CreateSeededClient();

        var first = await StreamAsync(client, new AssistChatRequest(null, "barnaby", "tell me a joke", null, null, null));
        var again = await StreamAsync(client, new AssistChatRequest(null, "barnaby", "tell me a joke", null, null, null));

        foreach (var frames in (List<Frame>[])[first, again])
        {
            Assert.DoesNotContain(frames, f => f.Event == "error");
            Assert.Contains(frames, f => f.Event == "delta");
            Assert.Equal("done", frames[^1].Event);
        }

        // Two names, both taken by the gateway. Retrying under the *same* name would have been a
        // second refusal, and sending no name at all would give up the only thing that makes a
        // session legible to somebody reading Hermes directly.
        Assert.Equal(2, gateway.CreatedTitles.Count);
        Assert.Contains("tell me a joke", gateway.CreatedTitles);
    }

    [Fact]
    public async Task The_done_frame_carries_what_the_screen_needs_and_arrives_last()
    {
        using var gateway = new StubHermes();
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        var client = app.CreateSeededClient();

        var frames = await StreamAsync(client, new AssistChatRequest(null, "barnaby", "Bins tonight?", null, null, null));

        Assert.Equal("done", frames[^1].Event);
        var done = frames[^1].Data;
        Assert.True(done.GetProperty("conversationId").GetInt32() > 0);
        Assert.Equal("Agent", done.GetProperty("origin").GetString());
        Assert.Equal("stop", done.GetProperty("finishReason").GetString());
    }

    [Fact]
    public async Task The_streamed_turn_is_persisted_exactly_once()
    {
        using var gateway = new StubHermes();
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        var client = app.CreateSeededClient();

        var frames = await StreamAsync(client, new AssistChatRequest(null, "barnaby", "Bins tonight?", null, null, null));
        var id = frames[^1].Data.GetProperty("conversationId").GetInt32();

        var detail = await client.GetFromJsonAsync<ConversationDetailDto>($"/api/assist/conversations/{id}");

        Assert.Equal(2, detail!.Messages.Count);
        Assert.Equal("Bins tonight?", detail.Messages[0].Text);
        // The reply is the concatenation of the deltas, not one of them.
        Assert.Equal("Stub reply.", detail.Messages[1].Text);
        Assert.Equal("Agent", detail.Messages[1].Origin);
    }

    [Fact]
    public async Task House_tool_progress_is_forwarded_and_Hermes_own_tooling_is_not()
    {
        using var gateway = new StubHermes
        {
            StreamScript =
                """
                event: hermes.tool.progress
                data: {"tool":"tool_describe","toolCallId":"c0","status":"running"}

                event: hermes.tool.progress
                data: {"tool":"mcp__homehub__set_climate_setpoint","toolCallId":"c1","status":"running"}

                data: {"choices":[{"index":0,"delta":{"content":"Done."},"finish_reason":null}]}

                data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

                data: [DONE]

                """,
        };
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        var client = app.CreateSeededClient();

        var frames = await StreamAsync(client, new AssistChatRequest(null, "barnaby", "Set the bedroom to 70", null, null, null));

        var tools = frames.Where(f => f.Event == "tool").Select(f => f.Data.GetProperty("tool").GetString()).ToList();

        // Hermes emits progress for its own `tool_describe` first. Surfacing that would tell the
        // household the agent is "doing something" about a detail they cannot act on.
        Assert.Equal(["set_climate_setpoint"], tools);
    }

    [Fact]
    public async Task A_deterministic_action_streams_its_own_reply_without_reaching_the_agent()
    {
        using var gateway = new StubHermes();
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        var client = app.CreateSeededClient();

        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HomeHub.Api.Data.HomeHubDbContext>();
            db.Tasks.Add(new HomeHub.Api.Tasks.TaskItem
            { ProfileId = 1, Title = "Milk", Source = "local", ListName = "Grocery List" });
            db.SaveChanges();
        }

        var frames = await StreamAsync(client,
            new AssistChatRequest(null, "barnaby", "Add basil to the grocery list", null, null, null));

        Assert.Equal(0, gateway.ChatCount); // the house did it; the agent was never asked
        Assert.Equal("Local", frames[^1].Data.GetProperty("origin").GetString());
        Assert.Equal("task", frames[^1].Data.GetProperty("action").GetString());
        Assert.Contains("Basil", string.Concat(
            frames.Where(f => f.Event == "delta").Select(f => f.Data.GetProperty("text").GetString())),
            StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task A_stream_that_dies_mid_reply_is_reported_incomplete_not_stopped()
    {
        // Two fragments and then the gateway vanishes: no terminal chunk, no [DONE].
        using var gateway = new StubHermes
        {
            StreamScript =
                """
                data: {"choices":[{"index":0,"delta":{"content":"The bins go out on "},"finish_reason":null}]}

                data: {"choices":[{"index":0,"delta":{"content":"Tues"},"finish_reason":null}]}

                """,
        };
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        var client = app.CreateSeededClient();

        var frames = await StreamAsync(client, new AssistChatRequest(null, "barnaby", "Bins?", null, null, null));
        var done = frames[^1].Data;

        // The severed answer is kept — it is worth more than a blank — but it must not be dressed as
        // a finished one. "The bins go out on Tues" reads like a complete answer, and nobody re-asks
        // a question that looks answered.
        Assert.Equal("The bins go out on Tues", string.Concat(
            frames.Where(f => f.Event == "delta").Select(f => f.Data.GetProperty("text").GetString())));
        Assert.Equal("incomplete", done.GetProperty("finishReason").GetString());
    }

    [Fact]
    public async Task Hitting_the_token_ceiling_is_reported_as_length_rather_than_stop()
    {
        using var gateway = new StubHermes
        {
            StreamScript =
                """
                data: {"choices":[{"index":0,"delta":{"content":"A very long answer that runs"},"finish_reason":null}]}

                data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}

                data: [DONE]

                """,
        };
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        var client = app.CreateSeededClient();

        var frames = await StreamAsync(client, new AssistChatRequest(null, "barnaby", "Explain everything", null, null, null));

        // Well-framed transport, truncated answer. The stream behaved; the reply is still cut off,
        // and only the second half is the household's problem.
        Assert.Equal("length", frames[^1].Data.GetProperty("finishReason").GetString());
    }

    [Fact]
    public async Task An_unreachable_agent_sends_an_error_frame_and_stores_nothing()
    {
        using var app = new HubAppFactory { HermesBaseUrl = "http://127.0.0.1:1" };
        var client = app.CreateSeededClient();

        var frames = await StreamAsync(client, new AssistChatRequest(null, "barnaby", "Bins tonight?", null, null, null));

        // The response was committed the moment streaming began, so an outage cannot be a status code
        // — it arrives as an `error` frame the panel renders as a banner.
        var error = Assert.Single(frames, f => f.Event == "error");
        Assert.Contains("unreachable", error.Data.GetProperty("message").GetString()!, StringComparison.OrdinalIgnoreCase);
        Assert.True(error.Data.GetProperty("retryable").GetBoolean());

        // And nothing is written. A failed turn is not a turn: storing the canned line would put words
        // in the agent's mouth, and leave the member's unanswered message above it permanently.
        var list = await client.GetFromJsonAsync<ConversationListDto>("/api/assist/conversations?profileId=1");
        Assert.Empty(list!.Conversations);
    }

    [Fact]
    public async Task The_turn_is_named_before_it_says_anything_else()
    {
        using var gateway = new StubHermes();
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        var client = app.CreateSeededClient();

        var frames = await StreamAsync(client, new AssistChatRequest(null, "barnaby", "Bins tonight?", null, null, null));

        // First, and before the first token: a Stop pressed while the panel is still showing an empty
        // reply has to have something to name, and that is the whole reason this frame exists.
        Assert.Equal("open", frames[0].Event);
        Assert.False(string.IsNullOrWhiteSpace(frames[0].Data.GetProperty("turnId").GetString()));
    }

    /*
     * The one this whole path is about.
     *
     * A wall panel is not a laptop: the screen a reply is being written on is routinely not the screen
     * anyone is standing in front of a moment later. That used to abort the request, the abort was the
     * only thing the server heard, and because nothing is stored until a turn ends, the turn went —
     * taking the member's own message with it. There was nothing to come back to.
     */
    [Fact]
    public async Task A_reader_who_walks_away_mid_reply_does_not_take_the_turn_with_them()
    {
        using var gateway = new StubHermes { StreamPacing = TimeSpan.FromMilliseconds(150) };
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        var client = app.CreateSeededClient();

        using (var leaving = new CancellationTokenSource())
        {
            using var res = await OpenAsync(client,
                new AssistChatRequest(null, "barnaby", "Bins tonight?", null, null, null), leaving.Token);
            using var reader = new StreamReader(await res.Content.ReadAsStreamAsync(leaving.Token), Encoding.UTF8);

            // Read as far as the first fragment of the reply and then go — which is all that navigating
            // to another screen looks like from here.
            await foreach (var frame in FramesAsync(reader, leaving.Token))
            {
                if (frame.Event == "delta") break;
            }

            await leaving.CancelAsync();
        }

        var stored = await AwaitStoredChatAsync(client, expectedMessages: 2);

        // It finished without us, and it finished *whole*: the question and the entire reply, not the
        // fragment that had arrived by the time the panel stopped listening.
        Assert.NotNull(stored);
        Assert.Equal("Bins tonight?", stored.Messages[0].Text);
        Assert.Equal("Stub reply.", stored.Messages[1].Text);
    }

    [Fact]
    public async Task Stopping_is_a_request_of_its_own_and_is_reported_as_the_member_s_choice()
    {
        // Slow enough that the Stop lands while the reply is still being written, which is the only
        // moment the control exists for.
        using var gateway = new StubHermes { StreamPacing = TimeSpan.FromMilliseconds(400) };
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        var client = app.CreateSeededClient();

        using var res = await OpenAsync(client, new AssistChatRequest(null, "barnaby", "Explain everything", null, null, null));
        using var reader = new StreamReader(await res.Content.ReadAsStreamAsync(), Encoding.UTF8);

        var frames = new List<Frame>();
        string? turnId = null;
        await foreach (var frame in FramesAsync(reader))
        {
            frames.Add(frame);
            if (frame.Event == "open") turnId = frame.Data.GetProperty("turnId").GetString();

            if (frame.Event == "delta" && turnId is not null)
            {
                using var stop = await client.PostAsync($"/api/assist/chat/turns/{turnId}/cancel", null);
                // 202: HomeHub asks Hermes to stop and Hermes notices on its next write. Claiming the
                // turn had stopped would be claiming something this endpoint cannot know.
                Assert.Equal(HttpStatusCode.Accepted, stop.StatusCode);
                turnId = null; // once
            }
        }

        // Named for what it was. `interrupted` is the member's own decision, which is why the panel
        // says nothing about it — unlike `incomplete`, which is a severed reply nobody chose.
        var done = frames.Single(f => f.Event == "done").Data;
        Assert.Equal("interrupted", done.GetProperty("finishReason").GetString());

        // And what had been said is still written down. A stopped reply is a short one, not a
        // discarded one — least of all the question that prompted it.
        var stored = await AwaitStoredChatAsync(client, expectedMessages: 2);
        Assert.NotNull(stored);
        Assert.Equal("Explain everything", stored.Messages[0].Text);
    }

    [Fact]
    public async Task Stopping_a_turn_that_has_already_finished_is_not_an_error_worth_reporting()
    {
        using var gateway = new StubHermes();
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        var client = app.CreateSeededClient();

        var frames = await StreamAsync(client, new AssistChatRequest(null, "barnaby", "Bins tonight?", null, null, null));
        var turnId = frames[0].Data.GetProperty("turnId").GetString();

        using var stop = await client.PostAsync($"/api/assist/chat/turns/{turnId}/cancel", null);

        // A tap that lands a moment after the last token. Honest about finding nothing, and nothing
        // the panel shows anybody.
        Assert.Equal(HttpStatusCode.NotFound, stop.StatusCode);
    }

    /*
     * Asking what became of a turn — the repair for a panel whose stream died.
     *
     * The failure these exist for is not a crash but a lie: the browser saw its read fail, reported
     * "the assistant is unreachable", and handed the member their message back to send again — over a
     * turn that had in fact been answered and stored. On a phone that was the ordinary path, because
     * backgrounding the app freezes its network within seconds. What makes the repair possible is
     * that the outcome outlives the connection, and that is what is asserted here.
     */

    [Fact]
    public async Task A_finished_turn_can_still_be_asked_about_after_its_stream_is_gone()
    {
        using var gateway = new StubHermes();
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        var client = app.CreateSeededClient();

        var frames = await StreamAsync(client, new AssistChatRequest(null, "barnaby", "Bins tonight?", null, null, null));
        var turnId = frames[0].Data.GetProperty("turnId").GetString();
        var done = frames[^1].Data;

        var state = await client.GetFromJsonAsync<TurnStatusDto>($"/api/assist/chat/turns/{turnId}");

        Assert.NotNull(state);
        Assert.Equal("done", state.Status);
        // The same figures the `done` frame carried — this is what a panel that never received that
        // frame reconstructs the end of the turn from.
        Assert.Equal(done.GetProperty("conversationId").GetInt32(), state.ConversationId);
        Assert.Equal(done.GetProperty("messageId").GetInt32(), state.MessageId);
        Assert.Equal("stop", state.FinishReason);
        // The whole reply, not the prefix that arrived before the drop. A household with conversation
        // storage switched off has nowhere else to read it from.
        Assert.Equal("Stub reply.", state.Text);
    }

    [Fact]
    public async Task A_turn_nobody_here_has_heard_of_is_a_404()
    {
        using var gateway = new StubHermes();
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        var client = app.CreateSeededClient();

        using var res = await client.GetAsync("/api/assist/chat/turns/nosuchturn");

        // Which the panel reads as "stop asking, and read the stored transcript" — the right recovery
        // for a forgotten turn, a restarted server and somebody else's turn alike.
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task A_turn_still_being_written_reports_itself_as_running()
    {
        // Paced so the lookup lands mid-reply, which is the state a reconnecting panel finds when it
        // comes back before the agent has finished.
        using var gateway = new StubHermes { StreamPacing = TimeSpan.FromMilliseconds(400) };
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        var client = app.CreateSeededClient();

        using var res = await OpenAsync(client, new AssistChatRequest(null, "barnaby", "Explain everything", null, null, null));
        using var reader = new StreamReader(await res.Content.ReadAsStreamAsync(), Encoding.UTF8);

        string? turnId = null;
        TurnStatusDto? midTurn = null;
        await foreach (var frame in FramesAsync(reader))
        {
            if (frame.Event == "open") turnId = frame.Data.GetProperty("turnId").GetString();
            // On the first delta: the reply has started and is certainly not finished.
            if (frame.Event == "delta" && turnId is not null && midTurn is null)
                midTurn = await client.GetFromJsonAsync<TurnStatusDto>($"/api/assist/chat/turns/{turnId}");
        }

        Assert.NotNull(midTurn);
        Assert.Equal("running", midTurn.Status);
        // Nothing to report yet, and nothing invented. A conversation id guessed here would send the
        // panel to a chat that does not exist.
        Assert.Equal(0, midTurn.ConversationId);
        Assert.Null(midTurn.FinishReason);

        // And once it is over, the same id answers with the outcome.
        var settled = await client.GetFromJsonAsync<TurnStatusDto>($"/api/assist/chat/turns/{turnId}");
        Assert.Equal("done", settled!.Status);
    }

    /*
     * Attachments — a picture or a text file handed over with a turn.
     *
     * Two rules are load-bearing and neither is visible from the screen. The first is that an
     * attachment reaches the agent *as its own content part* rather than pasted into the question:
     * a CSV run together with the words around it reads as part of the question. The second is that
     * an attachment is sent and not kept — the ledger holds the name so the transcript can say what
     * was attached, and holds neither the bytes nor the file's text.
     */

    [Fact]
    public async Task A_text_file_reaches_the_agent_as_its_own_named_part()
    {
        using var gateway = new StubHermes();
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        var client = app.CreateSeededClient();

        await StreamAsync(client, new AssistChatRequest(
            null, "barnaby", "What is on this list?", null, null, null,
            AttachmentName: "shopping.csv", AttachmentKind: "text", AttachmentBytes: 42,
            AttachmentText: "milk,2\nbread,1"));

        var sent = gateway.LastChatBody!;
        // The question and the file are separate parts, and the file says what it is.
        Assert.Contains("What is on this list?", sent, StringComparison.Ordinal);
        Assert.Contains("Attached file", sent, StringComparison.Ordinal);
        Assert.Contains("shopping.csv", sent, StringComparison.Ordinal);
        Assert.Contains("milk,2", sent, StringComparison.Ordinal);
    }

    [Fact]
    public async Task An_attachment_is_named_in_the_ledger_but_its_contents_are_not_stored()
    {
        using var gateway = new StubHermes();
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        var client = app.CreateSeededClient();

        var frames = await StreamAsync(client, new AssistChatRequest(
            null, "barnaby", "What is on this list?", null, null, null,
            AttachmentName: "shopping.csv", AttachmentKind: "text", AttachmentBytes: 42,
            AttachmentText: "milk,2\nbread,1"));
        var id = frames[^1].Data.GetProperty("conversationId").GetInt32();

        var detail = await client.GetFromJsonAsync<ConversationDetailDto>($"/api/assist/conversations/{id}");
        var asked = detail!.Messages[0];

        // The name survives, so a transcript reloaded later still says a file was handed over — on a
        // shared panel the reader of a turn is often not the one who sent it.
        Assert.Equal("shopping.csv", asked.AttachmentName);
        Assert.Equal("text", asked.AttachmentKind);
        Assert.Equal(42, asked.AttachmentBytes);

        // The contents do not. An attachment is sent, not kept — the household's chat history is not
        // quietly also a file store.
        Assert.Equal("What is on this list?", asked.Text);
        Assert.DoesNotContain("milk,2", asked.Text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_turn_can_be_an_attachment_and_nothing_else()
    {
        using var gateway = new StubHermes();
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        var client = app.CreateSeededClient();

        // Handing over a photo with no question is an ordinary thing to do. This used to 400: the
        // guard asked for "a prompt or an image", so a file with no words attached was rejected.
        var frames = await StreamAsync(client, new AssistChatRequest(
            null, "barnaby", "", null, null, null,
            AttachmentName: "notes.md", AttachmentKind: "text", AttachmentBytes: 12,
            AttachmentText: "the bins go out on Tuesday"));

        Assert.Equal("done", frames[^1].Event);
        Assert.True(frames[^1].Data.GetProperty("conversationId").GetInt32() > 0);
    }

    [Fact]
    public async Task An_attachment_claiming_a_kind_it_has_no_payload_for_is_treated_as_none()
    {
        using var gateway = new StubHermes();
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        var client = app.CreateSeededClient();

        var frames = await StreamAsync(client, new AssistChatRequest(
            null, "barnaby", "Still a question", null, null, null,
            AttachmentName: "ghost.csv", AttachmentKind: "text", AttachmentBytes: 9, AttachmentText: null));
        var id = frames[^1].Data.GetProperty("conversationId").GetInt32();

        var detail = await client.GetFromJsonAsync<ConversationDetailDto>($"/api/assist/conversations/{id}");

        // A name with nothing behind it is not an attachment. Recording it would put a file in the
        // transcript that was never handed over.
        Assert.Null(detail!.Messages[0].AttachmentName);
    }

    [Fact]
    public async Task An_empty_turn_with_no_attachment_is_still_refused()
    {
        using var gateway = new StubHermes();
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        var client = app.CreateSeededClient();

        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/assist/chat/stream")
        {
            Content = JsonContent.Create(new AssistChatRequest(null, "barnaby", "   ", null, null, null)),
        };
        using var res = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }
}
