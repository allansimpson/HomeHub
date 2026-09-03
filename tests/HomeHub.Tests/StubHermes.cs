namespace HomeHub.Tests;

using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;

/// <summary>
/// A minimal stand-in for one Hermes API-server gateway, on a real loopback port.
/// </summary>
/// <remarks>
/// <para>
/// A real socket rather than a mocked <c>HttpMessageHandler</c>, because several of the things worth
/// asserting are properties of the *wire*: which port a turn went to, whether a header was present,
/// and what JSON HomeHub actually serialised. A handler substituted into the client would let a
/// misconfigured base address pass unnoticed — and "the right agent's gateway" is precisely what
/// these tests exist to prove.
/// </para>
/// <para>
/// It answers the shapes HomeHub reads and nothing more: the API-server health discriminator, session
/// create, chat completions, and delete.
/// </para>
/// </remarks>
public sealed class StubHermes : IDisposable
{
    private readonly HttpListener _listener = new();
    private readonly CancellationTokenSource _cts = new();

    public StubHermes()
    {
        // Port 0 asks the OS for a free one; two stubs in one test then cannot collide.
        var port = FreePort();
        BaseUrl = $"http://127.0.0.1:{port}";
        _listener.Prefixes.Add($"{BaseUrl}/");
        _listener.Start();
        _ = Task.Run(() => ServeAsync(_cts.Token));
    }

    public string BaseUrl { get; }

    /// <summary>The session id handed out on create, and echoed on every chat.</summary>
    public string SessionId { get; init; } = "stub-session";

    /// <summary>Override the chat response status — 401, 429 and so on.</summary>
    public HttpStatusCode ChatStatus { get; init; } = HttpStatusCode.OK;

    /// <summary>
    /// What a non-streaming completion answers with.
    /// </summary>
    /// <remarks>
    /// Settable because one caller reads the *content* rather than just checking a turn happened: the
    /// conversation titler asks for a few words and then decides whether what came back is usable at
    /// all. Its rejection paths are only reachable if the stub can be made to answer badly.
    /// </remarks>
    public string ChatReply { get; init; } = "Stub reply.";

    /// <summary>Override the delete response status.</summary>
    public HttpStatusCode DeleteStatus { get; init; } = HttpStatusCode.OK;

    /// <summary>
    /// Frames to emit when a request asks for <c>stream: true</c>, verbatim.
    /// </summary>
    /// <remarks>
    /// Raw SSE text rather than a structured description, so a test can reproduce exactly what the
    /// gateway sends — including the shapes that broke the first parser: a role-only opening chunk,
    /// a named tool-progress event carrying no <c>choices</c>, and Hermes's own <c>tool_describe</c>.
    /// </remarks>
    public string? StreamScript { get; init; }

    /// <summary>
    /// Pause before each streamed frame, so a test can act while a reply is still arriving.
    /// </summary>
    /// <remarks>
    /// Zero — the default — writes the whole script in one go, which is what a test that only cares
    /// about the finished shape wants. A test about what happens <i>during</i> a turn cannot use that:
    /// the turn would be over before there was anything to interrupt.
    /// </remarks>
    public TimeSpan StreamPacing { get; init; } = TimeSpan.Zero;

    /// <summary>
    /// The session index this gateway reports, for the §3.1 lineage report.
    /// </summary>
    /// <remarks>
    /// Rows as the real projection gives them, so a test can build the shapes the report exists to
    /// find: an orphan whose parent is gone, a parent with two children, a chain that loops, a
    /// session somebody made at the CLI.
    /// </remarks>
    /// <remarks>
    /// Settable rather than <c>init</c> so a test can rewrite the index mid-scenario — a session
    /// rotating under a challenge that was already issued against the earlier shape, which is the
    /// only way to prove that a change nobody read invalidates an authorisation granted before it.
    /// </remarks>
    public IReadOnlyList<StubSession> Sessions { get; set; } = [];

    /// <summary>How many index pages were requested. Proves paging happened rather than one big read.</summary>
    public int SessionPageReads => _sessionPageReads;
    private int _sessionPageReads;

    public int ChatCount => _chatCount;
    private int _chatCount;

    /// <summary>The exact JSON body of the most recent chat request.</summary>
    public string? LastChatBody { get; private set; }

    /// <summary>Every <c>X-Hermes-Session-Id</c> this gateway was sent.</summary>
    public ConcurrentBag<string> SeenSessionIds { get; } = [];

    /// <summary>Every session id this gateway was asked to delete.</summary>
    public ConcurrentBag<string> DeletedSessionIds { get; } = [];

    /// <summary>
    /// Every title this gateway accepted — a set, because it will not accept a name twice.
    /// </summary>
    /// <remarks>
    /// The uniqueness is the point of holding them: a test that two chats opened is not the same
    /// statement as a test that they opened under names the gateway would take.
    /// </remarks>
    public HashSet<string> CreatedTitles { get; } = [];

    private async Task ServeAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            HttpListenerContext ctx;
            try { ctx = await _listener.GetContextAsync(); }
            catch { return; } // listener stopped

            try { await HandleAsync(ctx); }
            catch { /* a stub that throws would fail the test for the wrong reason */ }
            finally { try { ctx.Response.Close(); } catch { } }
        }
    }

    private async Task HandleAsync(HttpListenerContext ctx)
    {
        var path = ctx.Request.Url?.AbsolutePath ?? "";
        var method = ctx.Request.HttpMethod;

        // The API-server discriminator. HomeHub identifies the surface by this shape, so a stub that
        // answered the *dashboard* shape would correctly be refused — which is itself worth having.
        if (path == "/health")
        {
            await WriteJson(ctx, HttpStatusCode.OK,
                """{"status":"ok","platform":"hermes-agent","version":"0.20.0"}""");
            return;
        }

        if (path == "/api/sessions" && method == "GET")
        {
            Interlocked.Increment(ref _sessionPageReads);
            var q = System.Web.HttpUtility.ParseQueryString(ctx.Request.Url?.Query ?? "");
            var limit = int.TryParse(q["limit"], out var l) ? l : 200;
            var offset = int.TryParse(q["offset"], out var o) ? o : 0;

            var page = Sessions.Skip(offset).Take(limit).Select(s => s.ToJson());
            await WriteJson(ctx, HttpStatusCode.OK,
                $$"""{"object":"list","data":[{{string.Join(",", page)}}]}""");
            return;
        }

        if (path == "/api/sessions" && method == "POST")
        {
            using var body = new StreamReader(ctx.Request.InputStream, Encoding.UTF8);
            var asked = JsonDocument.Parse(await body.ReadToEndAsync()).RootElement;
            var title = asked.TryGetProperty("title", out var t) ? t.GetString() ?? "" : "";

            // Hermes will not hold two sessions of one name, and says so with a 400 rather than the
            // 409 it uses for a duplicate id. Modelled here because it not being modelled is what let
            // the real thing through: a household that asks "tell me a joke" twice got no session the
            // second time, and with no session there is no chat — while every conversation that
            // already existed carried on answering, so the panel looked broken only for new ones.
            if (!CreatedTitles.Add(title))
            {
                await WriteJson(ctx, HttpStatusCode.BadRequest,
                    $$$"""{"error":{"message":"Title already in use by session {{{SessionId}}}","type":"invalid_request_error","code":"invalid_title"}}""");
                return;
            }

            await WriteJson(ctx, HttpStatusCode.Created,
                $$$"""{"object":"hermes.session","session":{"id":"{{{SessionId}}}","source":"homehub"}}""");
            return;
        }

        if (path == "/v1/chat/completions" && method == "POST")
        {
            Interlocked.Increment(ref _chatCount);
            using var reader = new StreamReader(ctx.Request.InputStream, Encoding.UTF8);
            LastChatBody = await reader.ReadToEndAsync();

            if (ctx.Request.Headers["X-Hermes-Session-Id"] is { Length: > 0 } sid) SeenSessionIds.Add(sid);

            if (ChatStatus != HttpStatusCode.OK)
            {
                await WriteJson(ctx, ChatStatus, """{"detail":"stub"}""");
                return;
            }

            if (LastChatBody?.Contains("\"stream\":true", StringComparison.Ordinal) == true)
            {
                ctx.Response.StatusCode = 200;
                ctx.Response.ContentType = "text/event-stream";
                ctx.Response.Headers.Add("X-Hermes-Session-Id", SessionId);
                var script = StreamScript ?? DefaultStream;
                if (StreamPacing <= TimeSpan.Zero)
                {
                    var buf = Encoding.UTF8.GetBytes(script);
                    await ctx.Response.OutputStream.WriteAsync(buf);
                    await ctx.Response.OutputStream.FlushAsync();
                    return;
                }

                // Frame by frame. Line endings are normalised first because the scripts are raw string
                // literals and pick up whatever the file was saved with.
                foreach (var frame in script.ReplaceLineEndings("\n").Split("\n\n", StringSplitOptions.RemoveEmptyEntries))
                {
                    await Task.Delay(StreamPacing);
                    var buf = Encoding.UTF8.GetBytes(frame + "\n\n");
                    await ctx.Response.OutputStream.WriteAsync(buf);
                    await ctx.Response.OutputStream.FlushAsync();
                }
                return;
            }

            ctx.Response.Headers.Add("X-Hermes-Session-Id", SessionId);
            var content = JsonSerializer.Serialize(ChatReply);
            await WriteJson(ctx, HttpStatusCode.OK,
                $"{{\"choices\":[{{\"message\":{{\"role\":\"assistant\",\"content\":{content}}}}}]}}");
            return;
        }

        if (path.StartsWith("/api/sessions/", StringComparison.Ordinal) && method == "DELETE")
        {
            DeletedSessionIds.Add(Uri.UnescapeDataString(path["/api/sessions/".Length..]));
            await WriteJson(ctx, DeleteStatus, """{"object":"hermes.session.deleted","deleted":true}""");
            return;
        }

        if (path.EndsWith("/messages", StringComparison.Ordinal))
        {
            await WriteJson(ctx, HttpStatusCode.OK,
                $$"""{"object":"list","session_id":"{{SessionId}}","data":[]}""");
            return;
        }

        await WriteJson(ctx, HttpStatusCode.NotFound, """{"detail":"not found"}""");
    }

    /// <summary>An ordinary turn: role chunk, two content chunks, terminal chunk, [DONE].</summary>
    private const string DefaultStream = """
        data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

        data: {"choices":[{"index":0,"delta":{"content":"Stub "},"finish_reason":null}]}

        data: {"choices":[{"index":0,"delta":{"content":"reply."},"finish_reason":null}]}

        data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":7}}

        data: [DONE]

        """;

    private static async Task WriteJson(HttpListenerContext ctx, HttpStatusCode status, string json)
    {
        ctx.Response.StatusCode = (int)status;
        ctx.Response.ContentType = "application/json";
        var bytes = Encoding.UTF8.GetBytes(json);
        await ctx.Response.OutputStream.WriteAsync(bytes);
    }

    /// <summary>One row of the session index.</summary>
    /// <param name="Id">The session id.</param>
    /// <param name="Parent">`parent_session_id`, or null for a root.</param>
    /// <param name="EndReason">`compression` is what marks a legacy rotation.</param>
    /// <param name="Source">
    /// What the gateway reports. Defaults to <c>api_server</c> — <b>not</b> <c>homehub</c> — because
    /// that is what the deployed gateways actually return for sessions HomeHub created; the `source`
    /// HomeHub sends on create is not preserved. Set <c>cli</c> for a session made at the terminal.
    /// </param>
    public sealed record StubSession(
        string Id, string? Parent = null, string? EndReason = null, string Source = "api_server")
    {
        internal string ToJson()
        {
            var parent = Parent is null ? "null" : $"\"{Parent}\"";
            var reason = EndReason is null ? "null" : $"\"{EndReason}\"";
            // `title` and `preview` are present on the real projection and deliberately included
            // here — the client must not read them, and a stub that omitted them could not catch it.
            return $$"""
                {"id":"{{Id}}","source":"{{Source}}","parent_session_id":{{parent}},"end_reason":{{reason}},
                 "title":"a title the report must not copy","preview":"a preview the report must not copy",
                 "message_count":7}
                """;
        }
    }

    private static int FreePort()
    {
        var l = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        l.Start();
        var port = ((System.Net.IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }

    public void Dispose()
    {
        _cts.Cancel();
        try { _listener.Stop(); } catch { }
        _listener.Close();
        _cts.Dispose();
    }
}
