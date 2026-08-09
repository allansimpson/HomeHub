namespace HomeHub.Api.Assist;

using System.Collections.Concurrent;

/// <summary>
/// Every turn this process is writing, and — for a few minutes — every turn it just finished.
/// </summary>
/// <remarks>
/// <para>
/// <b>A dropped connection is not a decision.</b> These used to be the same event: the streaming
/// endpoint ran Hermes on <c>RequestAborted</c>, so pressing Stop and walking to another screen both
/// arrived as one cancelled token and the turn was abandoned either way. On a shared wall panel the
/// second is the ordinary case — the screen a reply is being written on is not necessarily the screen
/// anyone is standing in front of a moment later — and the household's message went with it.
/// </para>
/// <para>
/// So a turn gets its own token and its own id, the id goes to the browser on the stream's first
/// frame, and stopping is a request the member makes by name. A reader that goes away is then just a
/// reader that went away: the turn finishes, the ledger takes it, and the panel finds it there.
/// </para>
/// <para>
/// <b>Why finished turns are remembered.</b> Surviving the disconnection was only half of it. The
/// browser that lost the stream had no way to find out that the turn it started had succeeded, so it
/// reported the only thing it knew — that the connection had failed — and handed the member their
/// own message back to send again. On a phone this is not an edge case but the normal one: the
/// operating system freezes a backgrounded tab's network within seconds, and every reply asked for
/// just before the screen went off came back as "the assistant is unreachable" over a turn that had
/// in fact been answered and stored. Re-sending it then asked the agent to do the same thing twice.
/// </para>
/// <para>
/// <see cref="Complete"/> is what closes that gap. A turn's outcome outlives its stream for
/// <see cref="Memory"/>, so a panel coming back from the background can ask what became of the turn
/// it lost and be told, rather than guessing from the failure of the transport. Long enough for a
/// screen to wake up and reconnect; short enough that this is not a second, quieter transcript store
/// sitting beside the one the household actually configured.
/// </para>
/// <para>
/// <b>No backstop timer on a live turn, on purpose.</b> <c>HermesClientFactory</c> already bounds a
/// streaming call by <c>StreamTimeoutSeconds</c>. A second deadline in a second place is how two
/// deadlines drift apart, and the one that fires first is the one nobody remembers setting.
/// </para>
/// <para>
/// In-memory, like <see cref="ConversationLocks"/>, and therefore correct for the single API process
/// HomeHub is. A second instance would need the cancel — and now the lookup — to reach the process
/// holding the turn; the seam for that is this class and nothing else.
/// </para>
/// </remarks>
public sealed class TurnRegistry
{
    /// <summary>
    /// How long a finished turn can still be asked about.
    /// </summary>
    /// <remarks>
    /// Sized for the case it exists for: a phone whose screen went off mid-reply, woken and reopened
    /// by somebody wondering what the answer was. Minutes, not hours — past that the reply is in the
    /// transcript where it belongs, and anything still held here is a copy of household conversation
    /// kept somewhere nobody agreed to.
    /// </remarks>
    public static readonly TimeSpan Memory = TimeSpan.FromMinutes(5);

    /// <summary>
    /// A ceiling on remembered turns, so a burst cannot grow this without bound.
    /// </summary>
    /// <remarks>
    /// Far above what one household produces in five minutes. It is a backstop against a loop
    /// somewhere else, not a working limit — if it is ever reached, the oldest go first, which is
    /// also the order in which they stop being worth keeping.
    /// </remarks>
    private const int MaxRemembered = 200;

    private readonly ConcurrentDictionary<string, CancellationTokenSource> _live = new();
    private readonly ConcurrentDictionary<string, Finished> _finished = new();
    private readonly TimeProvider _clock;

    public TurnRegistry(TimeProvider clock) => _clock = clock;

    /// <summary>Start tracking a turn. Dispose the result when it ends, however it ends.</summary>
    /// <param name="profileId">
    /// Who asked for it. Kept so a later lookup can be refused to anyone else — a turn id is
    /// unguessable, but "unguessable" is not the same claim as "checked", and this one carries a
    /// reply.
    /// </param>
    public Registration Begin(int? profileId)
    {
        var id = Guid.NewGuid().ToString("N");
        var cts = new CancellationTokenSource();
        _live[id] = cts;
        return new Registration(this, id, profileId, cts);
    }

    /// <summary>
    /// Ask a turn to stop.
    /// </summary>
    /// <returns>
    /// False when there is no such turn running — which usually means it finished a moment ago, and
    /// is not an error worth reporting as one.
    /// </returns>
    public bool Cancel(string turnId)
    {
        if (string.IsNullOrEmpty(turnId) || !_live.TryGetValue(turnId, out var cts)) return false;

        // The turn can complete between the lookup and here, and completing disposes its source. The
        // member wanted it stopped and it is stopped; there is nothing to report.
        try { cts.Cancel(); }
        catch (ObjectDisposedException) { return false; }
        return true;
    }

    /// <summary>
    /// Record how a turn ended, so a browser that lost the stream can still find out.
    /// </summary>
    /// <remarks>
    /// Called once the turn is persisted, with the same figures the <c>done</c> frame carries. The
    /// reply text is kept as well as the ids, because there is one case where the ids are not enough:
    /// a household with conversation storage switched off stores nothing, so the stream *was* the
    /// only copy and a reconnecting panel has nowhere else to read it from.
    /// </remarks>
    public void Complete(string turnId, TurnOutcome outcome)
    {
        if (string.IsNullOrEmpty(turnId)) return;
        Sweep();
        _finished[turnId] = new Finished(outcome, _clock.GetUtcNow());
    }

    /// <summary>
    /// What became of a turn — or null, when this process has never heard of it or has forgotten.
    /// </summary>
    /// <remarks>
    /// A caller who does not own the turn is told the same thing as a caller asking about a turn that
    /// does not exist. Distinguishing the two would answer "does this id belong to somebody else",
    /// which is not a question this endpoint owes anyone an answer to.
    /// </remarks>
    public TurnStatus? Look(string turnId, int? profileId)
    {
        if (string.IsNullOrEmpty(turnId)) return null;
        Sweep();

        if (_finished.TryGetValue(turnId, out var finished))
        {
            return finished.Outcome.ProfileId == profileId ? new TurnStatus(false, finished.Outcome) : null;
        }

        // Still being written. There is nothing to report about it yet beyond the fact that it is
        // alive — which is the whole answer the caller needs, because it means keep waiting.
        return _live.ContainsKey(turnId) ? new TurnStatus(true, null) : null;
    }

    /// <summary>Forget what has aged out, and trim if something has gone wrong upstream.</summary>
    private void Sweep()
    {
        var cutoff = _clock.GetUtcNow() - Memory;
        foreach (var (id, entry) in _finished)
            if (entry.At < cutoff) _finished.TryRemove(id, out _);

        if (_finished.Count <= MaxRemembered) return;
        foreach (var (id, _) in _finished.OrderBy(e => e.Value.At).Take(_finished.Count - MaxRemembered))
            _finished.TryRemove(id, out _);
    }

    private readonly record struct Finished(TurnOutcome Outcome, DateTimeOffset At);

    /// <summary>One live turn: the name a Stop can call it by, and the token it actually runs on.</summary>
    public sealed class Registration : IDisposable
    {
        private readonly TurnRegistry _owner;
        private readonly CancellationTokenSource _cts;

        internal Registration(TurnRegistry owner, string id, int? profileId, CancellationTokenSource cts)
        {
            _owner = owner;
            Id = id;
            ProfileId = profileId;
            _cts = cts;
        }

        /// <summary>What the browser is told the turn is called.</summary>
        public string Id { get; }

        /// <summary>Who asked for it — see <see cref="TurnRegistry.Begin"/>.</summary>
        public int? ProfileId { get; }

        public CancellationToken Token => _cts.Token;

        public void Dispose()
        {
            // Removed before disposal, so a Cancel arriving now finds nothing rather than finding a
            // source it is about to be forbidden to touch.
            _owner._live.TryRemove(Id, out _);
            _cts.Dispose();
        }
    }
}

/// <summary>How a finished turn ended — the <c>done</c> frame, kept where a reconnecting panel can reach it.</summary>
/// <param name="ProfileId">Who asked for it. Checked before any of the rest is handed back.</param>
/// <param name="ConversationId">The chat it landed in, or 0 when the household stores none.</param>
/// <param name="MessageId">The stored reply, or 0 when nothing was stored.</param>
/// <param name="FinishReason">Why the reply stops where it does — <c>stop</c>, <c>incomplete</c>, <c>length</c>, <c>interrupted</c>.</param>
/// <param name="Text">The reply itself. The only copy, for a household with storage off.</param>
/// <param name="Action">The kind of write the turn made, for the IT TOUCHED receipt. Null when it wrote nothing.</param>
public record TurnOutcome(
    int? ProfileId,
    int ConversationId,
    int MessageId,
    string FinishReason,
    string Text,
    string? Action);

/// <summary>A turn's state as reported to the panel: still running, or finished with an outcome.</summary>
public record TurnStatus(bool Running, TurnOutcome? Outcome);
