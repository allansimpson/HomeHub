namespace HomeHub.Api.Auth;

using System.Collections.Concurrent;

/// <summary>
/// Rate-limits PIN attempts per profile: five tries, then a thirty-second cooldown.
/// </summary>
/// <remarks>
/// <para>
/// Lifted out of <c>ProfilesController</c>'s private static dictionary because the sign-in endpoint
/// now needs the same counter. Two independent counters would mean five attempts <i>each</i>, and
/// the one an attacker would use is whichever was overlooked — a lockout that can be sidestepped by
/// choosing a different URL is not a lockout. It is also one fewer of the process-wide statics
/// AUDIT B6 counts.
/// </para>
/// <para>
/// Still in memory, deliberately. A lockout only has to survive the seconds of an attack, not a
/// restart, and a restart is not something an unauthenticated caller can cause. Persisting it would
/// buy nothing and would put a write on the failure path of the sign-in screen.
/// </para>
/// </remarks>
public sealed class PinLockout
{
    /// <summary>Attempts before the cooldown starts.</summary>
    public const int MaxAttempts = 5;

    /// <summary>How long a locked-out profile has to wait.</summary>
    public static readonly TimeSpan Window = TimeSpan.FromSeconds(30);

    private readonly ConcurrentDictionary<int, (int Failures, DateTimeOffset? LockedUntil)> _attempts = new();
    private readonly TimeProvider _time;

    public PinLockout(TimeProvider time) => _time = time;

    /// <summary>Seconds still to wait, or null when this profile may try now.</summary>
    public int? RetryAfterSeconds(int profileId)
    {
        if (!_attempts.TryGetValue(profileId, out var state)) return null;
        if (state.LockedUntil is not { } until) return null;

        var remaining = until - _time.GetUtcNow();
        return remaining > TimeSpan.Zero ? (int)Math.Ceiling(remaining.TotalSeconds) : null;
    }

    /// <summary>Record a wrong PIN. Returns the cooldown in seconds if this attempt started one.</summary>
    public int? RecordFailure(int profileId)
    {
        var failures = _attempts.TryGetValue(profileId, out var state) ? state.Failures + 1 : 1;

        if (failures >= MaxAttempts)
        {
            // Counter reset alongside the lock, so the cooldown expiring gives a fresh five rather
            // than one attempt followed by an immediate re-lock.
            _attempts[profileId] = (0, _time.GetUtcNow() + Window);
            return (int)Window.TotalSeconds;
        }

        _attempts[profileId] = (failures, null);
        return null;
    }

    /// <summary>
    /// Forget this profile's failures — on success, and on any change to the PIN itself.
    /// </summary>
    /// <remarks>
    /// Clearing on set/clear/delete matters: a member locked out of a PIN they had forgotten would
    /// otherwise still be locked out after an admin gave them a new one, which reads as the new PIN
    /// not working.
    /// </remarks>
    public void Forget(int profileId) => _attempts.TryRemove(profileId, out _);
}
