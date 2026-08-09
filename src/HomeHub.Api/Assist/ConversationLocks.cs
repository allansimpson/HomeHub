namespace HomeHub.Api.Assist;

using System.Collections.Concurrent;

/// <summary>
/// Serialises turns within one conversation, while letting different conversations run concurrently.
/// </summary>
/// <remarks>
/// <para>
/// A shared panel makes concurrent turns ordinary rather than exotic: somebody types a question while
/// a spoken reply is still being produced, or a phone and the panel are both open on the same chat.
/// Two turns mutating one transcript at once is a race in Hermes as well as here, and Hermes's own
/// concurrency cap (10 active runs by default) is a global limit, not a per-conversation one.
/// </para>
/// <para>
/// <b>Keyed on <c>Conversation.Id</c>, never on the Hermes session ID.</b> This is the whole point.
/// The session ID <i>changes</i> when Hermes compresses — which is exactly the operation the lock
/// exists to protect — so keying on it would hand two turns different semaphores for the same chat:
/// </para>
/// <code>
/// turn A takes the lock under session-A
/// compression produces session-B
/// turn B observes session-B
/// turn B takes a *different* semaphore while A still holds session-A's
/// </code>
/// <para>
/// <c>Conversation.Id</c> is stable across session creation, compression, restore, endpoint changes,
/// and the conversation having no Hermes session at all.
/// </para>
/// <para>
/// In-memory, and therefore correct only for a single API process — which is what HomeHub is. A
/// second instance would need a database-backed lease; the seam for that is this class and nothing
/// else.
/// </para>
/// </remarks>
public sealed class ConversationLocks
{
    private readonly ConcurrentDictionary<int, SemaphoreSlim> _locks = new();

    /// <summary>
    /// Wait for exclusive use of a conversation. Dispose the result to release.
    /// </summary>
    /// <remarks>
    /// The semaphore is kept after release rather than removed. Removing it would need a second lock
    /// to close the window where one caller disposes while another is still waiting on the instance
    /// it already took — and the leak is bounded by the number of conversations the household has
    /// actually talked in since the process started, which is a handful of objects.
    /// </remarks>
    public async Task<IDisposable> AcquireAsync(int conversationId, CancellationToken ct)
    {
        var gate = _locks.GetOrAdd(conversationId, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct);
        return new Release(gate);
    }

    private sealed class Release : IDisposable
    {
        private SemaphoreSlim? _gate;

        public Release(SemaphoreSlim gate) => _gate = gate;

        public void Dispose()
        {
            // Null out first: a double dispose would otherwise raise the count above one and let two
            // turns in at once — a lock bug that only shows up under the concurrency it was added for.
            var gate = Interlocked.Exchange(ref _gate, null);
            gate?.Release();
        }
    }
}
