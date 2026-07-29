namespace HomeHub.Api.Baby;

/// <summary>
/// Last-known-good Huckleberry snapshot, held in memory.
/// </summary>
/// <remarks>
/// In memory, not EF, on purpose: Huckleberry is the system of record for baby data and HomeHub
/// must never become a second one. This exists only so an HA blip doesn't blank the panel — it is
/// a display cache with an honest stale flag, and losing it on restart is fine.
/// </remarks>
public sealed class HuckleberrySnapshotCache
{
    private readonly Lock _gate = new();
    private IReadOnlyList<BabyChild> _children = [];
    private Dictionary<string, BabyState> _states = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _deviceIds = new(StringComparer.Ordinal);

    public DateTimeOffset? LastGoodUtc { get; private set; }

    public bool HasValue => LastGoodUtc is not null;

    /// <summary>True when the last good fetch is older than <paramref name="freshFor"/>.</summary>
    public bool IsExpired(TimeSpan freshFor, DateTimeOffset now) =>
        LastGoodUtc is null || now - LastGoodUtc.Value > freshFor;

    /// <summary>
    /// Drops the freshness stamp so the next read refetches, without discarding the cached values —
    /// used after a write, whose effect lands upstream asynchronously. Device ids are kept: they are
    /// registry ids, unaffected by data changes.
    /// </summary>
    public void Invalidate()
    {
        lock (_gate) LastGoodUtc = null;
    }

    public void Store(IReadOnlyList<BabyChild> children, Dictionary<string, BabyState> states, DateTimeOffset now)
    {
        lock (_gate)
        {
            _children = children;
            _states = states;
            LastGoodUtc = now;
        }
    }

    public IReadOnlyList<BabyChild> Children
    {
        get { lock (_gate) return _children; }
    }

    /// <summary>
    /// Home Assistant device id for a child, cached because every write service targets it and
    /// resolving it costs a template render.
    /// </summary>
    /// <remarks>
    /// Held in memory rather than config on purpose: it is HA's own registry id, stable for the life
    /// of the config entry but **regenerated if the integration is removed and re-added**. Caching it
    /// durably would leave a stale id that fails every write after a reinstall.
    /// </remarks>
    public string? GetDeviceId(string childKey)
    {
        lock (_gate) return _deviceIds.GetValueOrDefault(childKey);
    }

    public void StoreDeviceId(string childKey, string deviceId)
    {
        lock (_gate) _deviceIds[childKey] = deviceId;
    }

    /// <summary>The cached state for a child, re-flagged <c>Stale</c> when served after a failed refresh.</summary>
    public BabyState? GetState(string childKey, bool stale)
    {
        lock (_gate)
        {
            if (!_states.TryGetValue(childKey, out var state)) return null;
            return stale ? state with { Stale = true } : state;
        }
    }
}
