namespace HomeHub.Api.Cats;

/// <summary>
/// Last-known snapshots, so a burst of panel requests isn't a burst of HA calls and a failed refresh
/// can still serve something honest (flagged stale) instead of an empty section. Mirrors
/// <see cref="Baby.HuckleberrySnapshotCache"/>.
/// </summary>
/// <remarks>
/// Read by request-scoped providers and written by the singleton recovery loop, so every mutation is
/// under the lock and reads hand back immutable snapshots.
/// </remarks>
public sealed class CatSnapshotCache
{
    private readonly Lock _gate = new();
    private IReadOnlyList<LitterRobotDescriptor> _robots = [];
    private Dictionary<string, LitterRobotSnapshot> _snapshots = new(StringComparer.Ordinal);
    private DateTimeOffset? _lastGoodUtc;

    public IReadOnlyList<LitterRobotDescriptor> Robots
    {
        get { lock (_gate) return _robots; }
    }

    public DateTimeOffset? LastGoodUtc
    {
        get { lock (_gate) return _lastGoodUtc; }
    }

    public bool HasValue
    {
        get { lock (_gate) return _lastGoodUtc is not null; }
    }

    public bool IsExpired(TimeSpan ttl, DateTimeOffset now)
    {
        lock (_gate) return _lastGoodUtc is null || now - _lastGoodUtc.Value >= ttl;
    }

    public void Store(
        IReadOnlyList<LitterRobotDescriptor> robots,
        IReadOnlyList<LitterRobotSnapshot> snapshots,
        DateTimeOffset now)
    {
        lock (_gate)
        {
            _robots = robots;
            _snapshots = snapshots.ToDictionary(s => s.Slug, StringComparer.Ordinal);
            _lastGoodUtc = now;
        }
    }

    /// <summary>The cached snapshot for one robot, re-flagged with the caller's staleness verdict.</summary>
    public LitterRobotSnapshot? Get(string slug, bool stale)
    {
        lock (_gate)
        {
            return _snapshots.TryGetValue(slug, out var snapshot)
                ? snapshot with { Stale = stale }
                : null;
        }
    }

    public IReadOnlyList<LitterRobotSnapshot> GetAll(bool stale)
    {
        lock (_gate) return _snapshots.Values.Select(s => s with { Stale = stale }).ToList();
    }
}
