namespace HomeHub.Api.Cats;

using System.Globalization;
using HomeHub.Api.HomeAssistant;
using Microsoft.Extensions.Options;

/// <summary>
/// Reads Litter-Robot state through Home Assistant's REST API. No Whisker specifics leak past this
/// class: HomeHub never talks to the Whisker cloud directly, it reads the entities HA's built-in
/// integration already maintains over its own websocket subscription.
/// </summary>
/// <remarks>
/// Entity ids are resolved by scanning HA's entity list for the robot's slug plus a known suffix,
/// rather than by formatting one guessed pattern. HA derives the slug from the robot's name in the
/// Whisker app and its suffixes have shifted between releases (the waste-drawer sensor in particular),
/// so a candidate list that degrades to "unknown" beats a format string that silently reads nothing.
/// </remarks>
public sealed class LitterRobotHomeAssistantProvider : ILitterRobotProvider
{
    private const string SensorPrefix = "sensor.";

    /// <summary>The suffix that identifies a robot; discovery keys off it and it is the one entity we require.</summary>
    private const string StatusSuffix = "_status_code";

    // Candidate suffixes per field, most-likely first.
    private static readonly string[] WasteDrawerSuffixes = ["_waste_drawer", "_waste_drawer_level"];
    private static readonly string[] LitterLevelSuffixes = ["_litter_level"];
    private static readonly string[] PetWeightSuffixes = ["_pet_weight"];
    private static readonly string[] TotalCyclesSuffixes = ["_total_cycles"];
    private static readonly string[] LastSeenSuffixes = ["_last_seen"];

    private readonly HomeAssistantClient _ha;
    private readonly CatSnapshotCache _cache;
    private readonly CatOptions _options;
    private readonly ILogger<LitterRobotHomeAssistantProvider> _logger;
    private readonly TimeProvider _time;

    public LitterRobotHomeAssistantProvider(
        HomeAssistantClient ha,
        CatSnapshotCache cache,
        IOptions<CatOptions> options,
        ILogger<LitterRobotHomeAssistantProvider> logger,
        TimeProvider time)
    {
        _ha = ha;
        _cache = cache;
        _options = options.Value;
        _logger = logger;
        _time = time;
    }

    public bool IsConfigured => _ha.IsConfigured && _options.Enabled;

    public async Task<CatHealth> GetHealthAsync(CancellationToken ct)
    {
        if (!IsConfigured)
            return new CatHealth(CatIntegrationStatus.NotConfigured, "Home Assistant is not configured.", null);

        var fresh = await TryRefreshAsync(ct);
        if (fresh)
        {
            return _cache.Robots.Count == 0
                ? new CatHealth(CatIntegrationStatus.IntegrationMissing,
                    "Home Assistant answered but exposes no Litter-Robot entities. Check the Whisker integration and its config flow.",
                    _cache.LastGoodUtc)
                : new CatHealth(CatIntegrationStatus.Ok, null, _cache.LastGoodUtc);
        }

        // Separate "HA is down" from "HA is up but the integration is broken" — different fixes.
        var reachable = await _ha.PingAsync(ct);
        if (!reachable)
            return new CatHealth(CatIntegrationStatus.HomeAssistantUnreachable,
                "Home Assistant did not respond.", _cache.LastGoodUtc);

        return _cache.HasValue
            ? new CatHealth(CatIntegrationStatus.Stale, "Serving the last known reading.", _cache.LastGoodUtc)
            : new CatHealth(CatIntegrationStatus.IntegrationMissing,
                "Home Assistant is reachable but no Litter-Robot data could be read.", null);
    }

    public async Task<IReadOnlyList<LitterRobotDescriptor>> GetRobotsAsync(CancellationToken ct)
    {
        if (!IsConfigured) return [];
        await TryRefreshAsync(ct);
        return _cache.Robots;
    }

    public async Task<LitterRobotSnapshot?> GetSnapshotAsync(string slug, CancellationToken ct)
    {
        if (!IsConfigured) return null;
        var fresh = await TryRefreshAsync(ct);
        return _cache.Get(slug, stale: !fresh);
    }

    public async Task<IReadOnlyList<LitterRobotSnapshot>> GetFreshSnapshotsAsync(CancellationToken ct)
    {
        if (!IsConfigured) return [];

        // No cache read: the recovery loop must not command a robot based on a ten-second-old status.
        // A throw here is deliberate — the caller treats a failed read as "don't intervene this tick",
        // which is different from "the robot is fine".
        var states = await _ha.GetStatesAsync(SensorPrefix, ct);
        var now = _time.GetUtcNow();
        var (robots, snapshots) = Build(states, now);
        _cache.Store(robots, snapshots, now);
        return snapshots;
    }

    /// <summary>
    /// Refreshes the cache if it has aged out. Returns false when the refresh failed and callers should
    /// serve cached data with a stale flag.
    /// </summary>
    private async Task<bool> TryRefreshAsync(CancellationToken ct)
    {
        var now = _time.GetUtcNow();
        if (!_cache.IsExpired(TimeSpan.FromSeconds(Math.Max(1, _options.CacheSeconds)), now))
            return true;

        try
        {
            var states = await _ha.GetStatesAsync(SensorPrefix, ct);
            var (robots, snapshots) = Build(states, now);
            _cache.Store(robots, snapshots, now);
            return true;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Litter-Robot refresh from Home Assistant failed; serving last known state.");
            return false;
        }
    }

    private (IReadOnlyList<LitterRobotDescriptor> Robots, IReadOnlyList<LitterRobotSnapshot> Snapshots) Build(
        IReadOnlyList<HaState> sensorStates, DateTimeOffset now)
    {
        var byEntity = sensorStates
            .Where(s => s.EntityId is not null)
            .ToDictionary(s => s.EntityId!, StringComparer.Ordinal);

        var slugs = _options.Robots.Count > 0 ? _options.Robots : DiscoverSlugs(byEntity.Keys);

        var robots = new List<LitterRobotDescriptor>(slugs.Count);
        var snapshots = new List<LitterRobotSnapshot>(slugs.Count);

        foreach (var slug in slugs)
        {
            byEntity.TryGetValue($"{SensorPrefix}{slug}{StatusSuffix}", out var status);
            var name = ResolveName(slug, status);
            robots.Add(new LitterRobotDescriptor(slug, name));

            snapshots.Add(new LitterRobotSnapshot(
                Slug: slug,
                Name: name,
                Fault: LitterRobotFaults.Classify(status is null || status.IsUnavailable ? null : status.State),
                WasteDrawerPercent: Number(byEntity, slug, WasteDrawerSuffixes),
                LitterPercent: Number(byEntity, slug, LitterLevelSuffixes),
                PetWeightLbs: Number(byEntity, slug, PetWeightSuffixes),
                TotalCycles: (int?)Number(byEntity, slug, TotalCyclesSuffixes),
                LastSeenUtc: Timestamp(byEntity, slug, LastSeenSuffixes),
                FetchedUtc: now,
                Stale: false));
        }

        return (robots, snapshots);
    }

    /// <summary>
    /// Slugs are the middles of <c>sensor.{slug}_status_code</c>. That entity exists for every
    /// Litter-Robot model and for no other integration we use, so one hit is enough to identify a robot
    /// — unlike Huckleberry children, which need corroborating entities to avoid false positives.
    /// </summary>
    private static List<string> DiscoverSlugs(IEnumerable<string> entityIds)
    {
        var slugs = new List<string>();
        foreach (var id in entityIds)
        {
            if (!id.StartsWith(SensorPrefix, StringComparison.Ordinal)) continue;
            var name = id[SensorPrefix.Length..];
            if (!name.EndsWith(StatusSuffix, StringComparison.Ordinal)) continue;
            if (name.Length <= StatusSuffix.Length) continue;
            slugs.Add(name[..^StatusSuffix.Length]);
        }
        slugs.Sort(StringComparer.Ordinal);
        return slugs;
    }

    private string ResolveName(string slug, HaState? status)
    {
        if (_options.RobotNames.TryGetValue(slug, out var configured) && !string.IsNullOrWhiteSpace(configured))
            return configured;

        // HA names the status sensor "<Robot> Status code"; the device name is the useful half.
        var friendly = status?.FriendlyName;
        if (!string.IsNullOrWhiteSpace(friendly))
        {
            const string suffix = " Status code";
            if (friendly.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
                return friendly[..^suffix.Length].Trim();
            return friendly;
        }

        return CultureInfo.CurrentCulture.TextInfo.ToTitleCase(slug.Replace('_', ' '));
    }

    /// <summary>Numeric sensor value from the entity <em>state</em> (HA puts sensor readings there, not in attributes).</summary>
    private static double? Number(Dictionary<string, HaState> byEntity, string slug, string[] suffixes)
    {
        var state = Resolve(byEntity, slug, suffixes);
        if (state is null || state.IsUnavailable) return null;
        return double.TryParse(state.State, NumberStyles.Float, CultureInfo.InvariantCulture, out var value)
            ? value
            : null;
    }

    private static DateTimeOffset? Timestamp(Dictionary<string, HaState> byEntity, string slug, string[] suffixes)
    {
        var state = Resolve(byEntity, slug, suffixes);
        if (state is null || state.IsUnavailable) return null;
        return DateTimeOffset.TryParse(state.State, CultureInfo.InvariantCulture,
            DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var parsed)
            ? parsed
            : null;
    }

    private static HaState? Resolve(Dictionary<string, HaState> byEntity, string slug, string[] suffixes)
    {
        foreach (var suffix in suffixes)
        {
            if (byEntity.TryGetValue($"{SensorPrefix}{slug}{suffix}", out var hit)) return hit;
        }
        return null;
    }
}
