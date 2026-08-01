namespace HomeHub.Api.Cats;

/// <summary>
/// Live per-robot episode state for the recovery loop, shared between the loop (which writes) and the
/// controller (which reads for the panel's auto-recovery line).
/// </summary>
/// <remarks>
/// In-memory on purpose: this is "what is happening right now", and losing it on restart is correct —
/// a restarted app should re-observe the robot rather than trust a stale episode. The one thing that
/// must survive a restart is the rolling 24h attempt cap, which is why that count is queried from
/// <see cref="LitterRobotRecovery"/> rows instead of being held here.
/// </remarks>
public sealed class RecoveryTracker
{
    /// <summary>The one wording for a panel pause, so the set and the clear cannot drift apart.</summary>
    private const string PausedHold = "Paused from the panel";

    private readonly Lock _gate = new();
    private readonly Dictionary<string, Episode> _episodes = new(StringComparer.Ordinal);

    private sealed class Episode
    {
        public string? FaultCode;
        public DateTimeOffset? FaultSinceUtc;
        public int Attempts;
        public DateTimeOffset? LastAttemptUtc;
        public DateTimeOffset? NextAttemptDueUtc;
        public DateTimeOffset? LastCatSeenUtc;
        public DateTimeOffset? StableSinceUtc;
        public string? HoldReason;
        public bool Paused;
    }

    private Episode For(string slug)
    {
        if (!_episodes.TryGetValue(slug, out var episode))
            _episodes[slug] = episode = new Episode();
        return episode;
    }

    /// <summary>
    /// Record that a recoverable fault is present. Starts an episode on the first sighting; a different
    /// fault code mid-episode updates the code but keeps the counters, because a robot rotating through
    /// faults is one problem, not a fresh one with a fresh attempt budget.
    /// </summary>
    public void NoteFault(string slug, string code, DateTimeOffset now)
    {
        lock (_gate)
        {
            var episode = For(slug);
            episode.FaultSinceUtc ??= now;
            episode.FaultCode = code;
            episode.StableSinceUtc = null;
        }
    }

    /// <summary>
    /// Record a usable status. Returns true when the robot has been stable long enough to close the
    /// episode, which also resets the attempt counters.
    /// </summary>
    public bool NoteStable(string slug, DateTimeOffset now, TimeSpan confirmFor)
    {
        lock (_gate)
        {
            var episode = For(slug);
            // A pause is a standing decision, not an episode detail: clearing it here left the panel
            // reporting auto-recovery off with no reason given, because `Paused` stayed true while
            // the sentence explaining it disappeared on the first usable reading.
            episode.HoldReason = episode.Paused ? PausedHold : null;
            episode.StableSinceUtc ??= now;

            var hadEpisode = episode.FaultSinceUtc is not null || episode.Attempts > 0;
            if (now - episode.StableSinceUtc.Value < confirmFor) return false;

            episode.FaultCode = null;
            episode.FaultSinceUtc = null;
            episode.Attempts = 0;
            episode.NextAttemptDueUtc = null;
            return hadEpisode;
        }
    }

    /// <summary>Record that a cat is present; gates every command for the configured settle window.</summary>
    public void NoteCat(string slug, DateTimeOffset now)
    {
        lock (_gate)
        {
            var episode = For(slug);
            episode.LastCatSeenUtc = now;
            episode.HoldReason = "Cat detected";
        }
    }

    /// <summary>Record an attempt and schedule the next one per the backoff schedule.</summary>
    public void NoteAttempt(string slug, DateTimeOffset now, RecoveryOptions options)
    {
        lock (_gate)
        {
            var episode = For(slug);
            episode.Attempts++;
            episode.LastAttemptUtc = now;
            episode.NextAttemptDueUtc = now + options.BackoffFor(episode.Attempts + 1);
            episode.HoldReason = null;
        }
    }

    public void SetHold(string slug, string? reason)
    {
        lock (_gate) For(slug).HoldReason = reason;
    }

    /// <summary>
    /// Stop or resume automatic intervention for one robot, from the panel — the "leave it alone" a
    /// household needs when it can see the box trying to fix itself and knows better.
    /// </summary>
    /// <remarks>
    /// Survives the episode closing, so pausing means paused until someone resumes it, not until the
    /// next stable reading. It does not survive a restart, which matches the rest of this class: a
    /// restarted app re-observes rather than inheriting a decision nobody remembers making. Pausing
    /// never silences the alerts — the observe-only branch still reports a box that needs hands.
    /// </remarks>
    public void SetPaused(string slug, bool paused)
    {
        lock (_gate)
        {
            var episode = For(slug);
            episode.Paused = paused;
            if (paused) episode.HoldReason = PausedHold;
            else if (episode.HoldReason == PausedHold) episode.HoldReason = null;
        }
    }

    /// <summary>Whether automatic intervention is paused for this robot.</summary>
    public bool IsPaused(string slug)
    {
        lock (_gate) return For(slug).Paused;
    }

    /// <summary>A read-only view of the gate inputs, taken atomically.</summary>
    public (int Attempts, DateTimeOffset? FaultSince, DateTimeOffset? NextDue, DateTimeOffset? LastCat) Read(string slug)
    {
        lock (_gate)
        {
            var episode = For(slug);
            return (episode.Attempts, episode.FaultSinceUtc, episode.NextAttemptDueUtc, episode.LastCatSeenUtc);
        }
    }

    /// <summary>
    /// The panel's view. <paramref name="enabled"/> is the configured master switch; a robot paused from
    /// the panel reports disabled too, so the UI has one flag to read rather than two to reconcile.
    /// </summary>
    public RecoveryState Snapshot(string slug, bool enabled, int attemptsToday)
    {
        lock (_gate)
        {
            var episode = For(slug);
            return new RecoveryState(
                slug,
                enabled && !episode.Paused,
                episode.FaultCode,
                episode.FaultSinceUtc,
                episode.Attempts,
                attemptsToday,
                episode.LastAttemptUtc,
                episode.NextAttemptDueUtc,
                episode.HoldReason);
        }
    }
}
