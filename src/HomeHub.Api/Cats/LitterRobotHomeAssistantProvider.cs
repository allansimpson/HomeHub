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
    private const string SwitchPrefix = "switch.";
    private const string ButtonPrefix = "button.";
    private const string SelectPrefix = "select.";
    private const string UpdatePrefix = "update.";
    private const string VacuumPrefix = "vacuum.";

    /// <summary>
    /// Domains whose state moves only when the robot reports. Deliberately excludes
    /// <c>button</c>/<c>switch</c>/<c>select</c>: those move when <em>HomeHub</em> commands them, and the
    /// recovery ladder pressing reset must never be able to make a silent robot look alive.
    /// </summary>
    private static readonly string[] TelemetryPrefixes = [SensorPrefix, VacuumPrefix];

    /// <summary>The suffix that identifies a robot; discovery keys off it and it is the one entity we require.</summary>
    private const string StatusSuffix = "_status_code";

    // Candidate suffixes per field, most-likely first.
    private static readonly string[] WasteDrawerSuffixes = ["_waste_drawer", "_waste_drawer_level"];
    private static readonly string[] LitterLevelSuffixes = ["_litter_level"];
    private static readonly string[] PetWeightSuffixes = ["_pet_weight"];
    private static readonly string[] TotalCyclesSuffixes = ["_total_cycles"];
    private static readonly string[] LastSeenSuffixes = ["_last_seen"];
    private static readonly string[] SleepStartSuffixes = ["_sleep_mode_start_time"];
    private static readonly string[] SleepEndSuffixes = ["_sleep_mode_end_time"];
    private static readonly string[] HopperSuffixes = ["_hopper_status"];

    /// <summary>Token sets for the <c>select</c> entities, matched the same way the switches are.</summary>
    private static readonly (LitterRobotSelect Key, string[] Tokens)[] SelectTokens =
    [
        (LitterRobotSelect.NightLight, ["globe", "light"]),
        (LitterRobotSelect.GlobeBrightness, ["globe", "brightness"]),
        (LitterRobotSelect.PanelBrightness, ["panel", "brightness"]),
        (LitterRobotSelect.CleanCycleWait, ["clean", "cycle", "wait"]),
    ];

    // Controls, matched by the words in the entity id rather than by a whole suffix. The Whisker
    // integration decorates these names differently per model and per release — "night light" has
    // shipped as both `_night_light` and `_night_light_mode` — and a control that silently stops
    // being offered because a suffix gained a word is worse than one matched a little loosely. Every
    // set below needs *all* its tokens, so `_reset_waste_drawer` can't be confused with the plain
    // `_reset` button the recovery ladder uses.
    private static readonly string[] SleepModeTokens = ["sleep"];
    private static readonly string[] NightLightTokens = ["night", "light"];
    private static readonly string[] PanelLockTokens = ["panel", "lock"];
    private static readonly string[] DrawerResetTokens = ["reset", "waste", "drawer"];
    private static readonly string[] AddLitterTokens = ["reset", "litter", "level"];

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
        // Every domain, not just sensors: the controls live on switch.* and button.*, and HA serves the
        // whole state list in one call regardless of how it's filtered afterwards.
        var states = await _ha.GetStatesAsync(ct);
        var now = _time.GetUtcNow();
        var (robots, snapshots) = Build(states, now);
        _cache.Store(robots, snapshots, now);
        return snapshots;
    }

    public async Task<LitterRobotHistory?> GetHistoryAsync(string slug, int days, CancellationToken ct)
    {
        if (!IsConfigured) return null;

        // Resolve the real entity ids first: the suffixes vary by model and release, and asking the
        // recorder for an id that doesn't exist returns an empty series rather than an error, which
        // would render as "nothing ever happened".
        var states = await _ha.GetStatesAsync(ct);
        var byEntity = states
            .Where(s => s.EntityId is not null)
            .ToDictionary(s => s.EntityId!, StringComparer.Ordinal);

        // Null (→ 404) whenever HA has no status entity for this slug, pinned robots included.
        //
        // The `_options.Robots.Count == 0` clause used to disable this check entirely whenever
        // `Cats:Robots` was configured, on the reasoning that a pinned robot is known-good. But
        // pinning names a slug, not an entity — so a robot renamed in HA still passes the guard, and
        // the recorder is then asked for an id that does not exist. It answers with an empty series
        // rather than an error, so the panel drew "nothing ever happened" over a box with real
        // history. A 404 says the thing that is actually true.
        if (!byEntity.ContainsKey($"{SensorPrefix}{slug}{StatusSuffix}")) return null;

        var status = $"{SensorPrefix}{slug}{StatusSuffix}";
        var drawer = ResolveId(byEntity, slug, WasteDrawerSuffixes);
        var litter = ResolveId(byEntity, slug, LitterLevelSuffixes);
        var weight = ResolveId(byEntity, slug, PetWeightSuffixes);

        var to = _time.GetUtcNow();
        var from = to.AddDays(-Math.Max(1, days));
        var ids = new[] { status, drawer, litter, weight }.Where(id => id is not null).Select(id => id!).ToList();

        var series = await _ha.GetHistoryAsync(ids, from, to, ct);

        return LitterHistoryBuilder.Build(
            slug, days, from, to,
            SeriesFor(series, status),
            SeriesFor(series, drawer),
            SeriesFor(series, litter),
            SeriesFor(series, weight));
    }

    /// <summary>
    /// The series for one entity. HA groups history per entity and, under <c>minimal_response</c>,
    /// only the first sample of each group carries its <c>entity_id</c>.
    /// </summary>
    private static IReadOnlyList<HaState> SeriesFor(
        IReadOnlyList<IReadOnlyList<HaState>> series, string? entityId)
    {
        if (entityId is null) return [];
        foreach (var group in series)
        {
            if (group.Count > 0 && group[0].EntityId == entityId) return group;
        }
        return [];
    }

    private static string? ResolveId(Dictionary<string, HaState> byEntity, string slug, string[] suffixes)
    {
        foreach (var suffix in suffixes)
        {
            var id = $"{SensorPrefix}{slug}{suffix}";
            if (byEntity.ContainsKey(id)) return id;
        }
        return null;
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
            // Every domain, not just sensors: the controls live on switch.* and button.*, and HA serves the
        // whole state list in one call regardless of how it's filtered afterwards.
        var states = await _ha.GetStatesAsync(ct);
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
        IReadOnlyList<HaState> states, DateTimeOffset now)
    {
        var byEntity = states
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
                LastSeenUtc: LastContact(byEntity, slug),
                FetchedUtc: now,
                Stale: false)
            {
                StatusSinceUtc = status?.LastChanged,
                // Presence of the entity, never its value: an LR4 with a dropped cloud connection
                // reports `unavailable` and is still an LR4.
                Model = ResolveId(byEntity, slug, LitterLevelSuffixes) is not null ? "LR4" : "LR3",
                Controls = new LitterRobotControls(
                    SleepMode: Flag(byEntity, slug, SleepModeTokens),
                    NightLight: Flag(byEntity, slug, NightLightTokens),
                    PanelLock: Flag(byEntity, slug, PanelLockTokens),
                    CanResetDrawer: Exists(byEntity, ButtonPrefix, slug, DrawerResetTokens),
                    CanAddLitter: Exists(byEntity, ButtonPrefix, slug, AddLitterTokens))
                {
                    SleepStartsUtc = Timestamp(byEntity, slug, SleepStartSuffixes),
                    SleepEndsUtc = Timestamp(byEntity, slug, SleepEndSuffixes),
                    Selects = Selects(byEntity, slug),
                    HopperStatus = Text(byEntity, slug, HopperSuffixes),
                    FirmwareVersion = Firmware(byEntity, slug)?.GetString("installed_version"),
                    FirmwareUpdateAvailable = Firmware(byEntity, slug) is { } fw && !fw.IsUnavailable
                        ? fw.State == "on"
                        : null,
                },
            });
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

    /// <summary>
    /// When the robot was last heard from — the newest of the <c>_last_seen</c> sensor's value and the
    /// freshest telemetry timestamp on the robot's own entities.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>_last_seen</c> is the intended source but is not trustworthy on its own: on some units the
    /// Whisker integration stops refreshing it, freezing it days in the past while every other entity
    /// keeps updating. Trusting it alone made the panel report "last seen 2d ago" beside gauges read
    /// minutes earlier — exactly the self-contradiction <c>LitterScreen</c> is built to avoid.
    /// </para>
    /// <para>
    /// Entities that are <c>unavailable</c> are skipped, and that exclusion is load-bearing rather than
    /// tidiness: when Whisker's cloud drops, its entities go unavailable and HA stamps them with the
    /// current time. Counting those would report a robot that has genuinely gone silent as freshly seen
    /// — the one failure this screen exists to surface.
    /// </para>
    /// </remarks>
    private static DateTimeOffset? LastContact(Dictionary<string, HaState> byEntity, string slug)
    {
        var newest = Timestamp(byEntity, slug, LastSeenSuffixes);
        var reportedId = ResolveId(byEntity, slug, LastSeenSuffixes);

        foreach (var (id, state) in byEntity)
        {
            // Skip the `_last_seen` entity itself: its value is already taken above, and its own
            // `last_changed` is restamped by an HA restart even when the frozen value did not move —
            // counting it would manufacture contact out of a reboot.
            if (string.Equals(id, reportedId, StringComparison.Ordinal)) continue;
            if (state.IsUnavailable || !IsTelemetryFor(id, slug)) continue;
            var stamp = state.LastUpdated ?? state.LastChanged;
            if (stamp is not null && (newest is null || stamp > newest)) newest = stamp;
        }

        return newest;
    }

    /// <summary>Whether an entity id is robot telemetry for <paramref name="slug"/>.</summary>
    private static bool IsTelemetryFor(string entityId, string slug)
    {
        foreach (var prefix in TelemetryPrefixes)
        {
            if (!entityId.StartsWith(prefix, StringComparison.Ordinal)) continue;
            var name = entityId[prefix.Length..];
            if (!name.StartsWith(slug, StringComparison.Ordinal)) continue;
            // The slug exactly, or the slug then a separator — never a longer slug that merely starts
            // with this one, which would let two robots contaminate each other's freshness.
            if (name.Length == slug.Length || name[slug.Length] == '_') return true;
        }
        return false;
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

    /// <summary>
    /// A switch's position, or null when the entity is absent or unavailable. Null is a real answer —
    /// see <see cref="LitterRobotControls"/> for why it must not collapse to false.
    /// </summary>
    private static bool? Flag(Dictionary<string, HaState> byEntity, string slug, string[] tokens)
    {
        var state = Find(byEntity, SwitchPrefix, slug, tokens);
        if (state is null || state.IsUnavailable) return null;
        return state.State switch
        {
            "on" => true,
            "off" => false,
            _ => null,
        };
    }

    /// <summary>
    /// The robot's HA update entity. `on` means an update is waiting; the version itself is an
    /// attribute, because the state slot carries the availability flag.
    /// </summary>
    private static HaState? Firmware(Dictionary<string, HaState> byEntity, string slug) =>
        Find(byEntity, UpdatePrefix, slug, ["firmware"]);

    /// <summary>A sensor's state as text — for the ones that report words, not numbers.</summary>
    private static string? Text(Dictionary<string, HaState> byEntity, string slug, string[] suffixes)
    {
        var state = Resolve(byEntity, slug, suffixes);
        return state is null || state.IsUnavailable ? null : state.State;
    }

    /// <summary>
    /// The robot's multi-position settings. Options come from the entity's own <c>options</c>
    /// attribute rather than a hardcoded list, so the panel offers exactly what this robot accepts —
    /// the option sets differ by model and have changed between integration releases.
    /// </summary>
    private static IReadOnlyDictionary<LitterRobotSelect, LitterRobotSelectState> Selects(
        Dictionary<string, HaState> byEntity, string slug)
    {
        var found = new Dictionary<LitterRobotSelect, LitterRobotSelectState>();
        foreach (var (key, tokens) in SelectTokens)
        {
            var state = Find(byEntity, SelectPrefix, slug, tokens);
            if (state is null) continue;

            var options = new List<string>();
            if (state.GetArray("options") is { } array)
            {
                foreach (var option in array.EnumerateArray())
                {
                    if (option.GetString() is { } text) options.Add(text);
                }
            }

            // An entity with no options list can still be reported; it just can't be changed from
            // here, and the panel renders it read-only rather than guessing at a vocabulary.
            found[key] = new LitterRobotSelectState(state.IsUnavailable ? null : state.State, options);
        }
        return found;
    }

    /// <summary>
    /// Whether a momentary entity exists and is reachable. Buttons carry no meaningful state (HA reports
    /// the last press timestamp), so presence is the only thing worth asking.
    /// </summary>
    private static bool Exists(Dictionary<string, HaState> byEntity, string prefix, string slug, string[] tokens)
    {
        var state = Find(byEntity, prefix, slug, tokens);
        return state is not null && !state.IsUnavailable;
    }

    /// <summary>
    /// The first entity in <paramref name="prefix"/> belonging to this robot whose name contains every
    /// token. Ordinal and case-sensitive: HA entity ids are always lower-snake.
    /// </summary>
    private static HaState? Find(
        Dictionary<string, HaState> byEntity, string prefix, string slug, string[] tokens)
    {
        var head = $"{prefix}{slug}_";
        foreach (var (id, state) in byEntity)
        {
            if (!id.StartsWith(head, StringComparison.Ordinal)) continue;
            var rest = id[head.Length..];
            var all = true;
            foreach (var token in tokens)
            {
                if (rest.Contains(token, StringComparison.Ordinal)) continue;
                all = false;
                break;
            }
            if (all) return state;
        }
        return null;
    }

    private static HaState? Resolve(
        Dictionary<string, HaState> byEntity, string slug, string[] suffixes, string prefix = SensorPrefix)
    {
        foreach (var suffix in suffixes)
        {
            if (byEntity.TryGetValue($"{prefix}{slug}{suffix}", out var hit)) return hit;
        }
        return null;
    }
}
