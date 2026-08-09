namespace HomeHub.Api.Assist;

using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;

/// <summary>
/// Writes a server-sent-event stream to the browser, flushing every frame.
/// </summary>
/// <remarks>
/// <para>
/// <b>Every write is flushed.</b> The whole point of streaming is that a fragment reaches the panel
/// before the answer is finished; a buffered frame is a fragment nobody sees, and the feature
/// silently degrades to the non-streaming behaviour it replaced. There is no batching here — the
/// browser batches for painting, which is where batching belongs.
/// </para>
/// <para>
/// <b>Headers go out before the first delta.</b> `Start` flushes an empty body so the response is
/// committed and the connection is open while Hermes is still thinking. Without it the browser waits
/// on headers that ASP.NET Core would hold until the first write, and the time-to-first-paint
/// measurement would be indistinguishable from not streaming at all.
/// </para>
/// </remarks>
public sealed class SseWriter : IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly HttpResponse _response;
    /// <summary>
    /// One writer at a time.
    /// </summary>
    /// <remarks>
    /// The heartbeat writes from its own task while the turn writes from the request's, and two
    /// interleaved writes on one stream do not produce two frames — they produce one corrupt one,
    /// intermittently, under exactly the long quiet turns the heartbeat exists for.
    /// </remarks>
    private readonly SemaphoreSlim _writing = new(1, 1);

    public SseWriter(HttpResponse response) => _response = response;

    /// <summary>
    /// Whether there is still anybody on the other end.
    /// </summary>
    /// <remarks>
    /// False after the first failed write. It stays false: past that the socket is gone, and every
    /// further send would pay a write and a flush to rediscover the same thing.
    /// </remarks>
    public bool Connected { get; private set; } = true;

    /// <summary>Commit the response and open the stream, before any content exists.</summary>
    public async Task StartAsync(CancellationToken ct)
    {
        _response.StatusCode = StatusCodes.Status200OK;
        _response.ContentType = "text/event-stream";
        _response.Headers.CacheControl = "no-cache, no-transform";
        // Proxies buffer by default and would hold the whole stream until it completed. nginx honours
        // this header; the panel is usually served directly, but the deployed path may not be.
        _response.Headers["X-Accel-Buffering"] = "no";
        // Nothing here is a resource a browser should reuse.
        _response.Headers.Pragma = "no-cache";

        await _response.Body.FlushAsync(ct);
    }

    /// <summary>Send one named event carrying a JSON payload.</summary>
    public async Task SendAsync<T>(string eventName, T payload, CancellationToken ct)
    {
        var json = JsonSerializer.Serialize(payload, Json);

        var frame = new StringBuilder()
            .Append("event: ").Append(eventName).Append('\n')
            // A payload containing a newline would otherwise end the frame early. JSON serialisation
            // escapes them, but splitting is correct regardless and costs nothing.
            .Append("data: ").Append(json.ReplaceLineEndings("\ndata: ")).Append("\n\n")
            .ToString();

        await WriteAsync(frame, ct);
    }

    /// <summary>
    /// Send, and let a reader who has gone simply be gone.
    /// </summary>
    /// <remarks>
    /// A turn outlives the connection that asked for it — see <c>TurnCancellation</c> — so a failed
    /// write is news about the reader, not about the turn, and must never be the exception that ends
    /// it.
    /// </remarks>
    public async Task TrySendAsync<T>(string eventName, T payload, CancellationToken ct)
    {
        if (!Connected) return;
        try { await SendAsync(eventName, payload, ct); }
        catch (Exception) { Connected = false; }
    }

    /// <summary>
    /// A comment frame, to keep an idle connection alive.
    /// </summary>
    /// <remarks>
    /// Sent while waiting on a long tool run, so an intermediary does not decide a quiet connection is
    /// a dead one. Browsers ignore comment frames entirely.
    /// </remarks>
    public async Task KeepAliveAsync(CancellationToken ct)
    {
        await WriteAsync(": keepalive\n\n", ct);
    }

    /// <summary>
    /// Keep the connection alive for as long as the returned handle is held.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>A quiet turn is not a dead one.</b> An agent that thinks for four minutes, or runs a tool
    /// that does, writes nothing to this stream the whole time — and an idle connection is precisely
    /// what a reverse proxy, a dev-server proxy hop or a mobile network reaps. The turn then dies for
    /// the one reason it should not: it was taking the time the question needed.
    /// </para>
    /// <para>
    /// Comment frames, so the browser's parser ignores them and no screen ever shows a heartbeat.
    /// </para>
    /// </remarks>
    public Heartbeat KeepAlive(TimeSpan every, CancellationToken ct) => new(this, every, ct);

    /// <summary>The running heartbeat. Dispose to stop it, and await it stopping.</summary>
    public sealed class Heartbeat : IAsyncDisposable
    {
        private readonly CancellationTokenSource _stop;
        private readonly Task _loop;

        internal Heartbeat(SseWriter sse, TimeSpan every, CancellationToken ct)
        {
            _stop = CancellationTokenSource.CreateLinkedTokenSource(ct);
            var token = _stop.Token;

            _loop = Task.Run(async () =>
            {
                try
                {
                    while (!token.IsCancellationRequested)
                    {
                        await Task.Delay(every, token);
                        if (!sse.Connected) return;
                        try { await sse.KeepAliveAsync(token); }
                        catch (Exception) { sse.Connected = false; return; }
                    }
                }
                catch (OperationCanceledException) { /* the turn ended, which is how this stops */ }
            }, CancellationToken.None);
        }

        public async ValueTask DisposeAsync()
        {
            await _stop.CancelAsync();
            // Awaited rather than abandoned: a heartbeat still in a write when the `done` frame goes
            // out would interleave with it, and the household would see the turn end in a broken
            // frame roughly one time in however many turns nobody would ever reproduce.
            try { await _loop; } catch (Exception) { }
            _stop.Dispose();
        }
    }

    /// <summary>Every byte that reaches the browser goes through here, one writer at a time.</summary>
    private async Task WriteAsync(string frame, CancellationToken ct)
    {
        await _writing.WaitAsync(ct);
        try
        {
            await _response.WriteAsync(frame, Encoding.UTF8, ct);
            await _response.Body.FlushAsync(ct);
        }
        finally { _writing.Release(); }
    }

    /// <summary>Releases the write lock's wait handle.</summary>
    /// <remarks>
    /// One writer per request, so this is a small leak rather than a dangerous one — but a
    /// <see cref="SemaphoreSlim"/> that has ever been waited on asynchronously holds an unmanaged
    /// wait handle, and the streaming endpoint is the one a panel hits all day. The writer owns the
    /// semaphore, so the writer disposes it; the heartbeat has its own <c>DisposeAsync</c> above and
    /// is a separate lifetime.
    /// </remarks>
    public void Dispose() => _writing.Dispose();
}
