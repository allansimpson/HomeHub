namespace HomeHub.Api.Baby;

using System.Globalization;
using HomeHub.Api.HomeAssistant;
using Microsoft.Extensions.Options;

/// <summary>
/// Reads Huckleberry data through Home Assistant's REST API: per-child <c>sensor.*</c> entities for
/// current state, and <c>calendar.{child}_events</c> for history. No Huckleberry/Firebase specifics
/// leak past this class — HomeHub never talks to Huckleberry directly (its Firebase security rules
/// block non-SDK requests, so all access is via the HA integration wrapping Woyken's library).
/// </summary>
/// <remarks>
/// Defensive by construction, because Gate H0.2 has not yet confirmed the real entity/attribute
/// names against a live install: every attribute read goes through the null-returning accessors on
/// <see cref="HaState"/>, and names live in <see cref="HuckleberryEntities"/>. A wrong guess shows
/// a field as unknown; it does not throw and does not take the section down.
/// </remarks>
public sealed class HuckleberryHomeAssistantProvider : IHuckleberryProvider
{
    private const string SensorPrefix = "sensor.";

    private readonly HomeAssistantClient _ha;
    private readonly HuckleberrySnapshotCache _cache;
    private readonly HuckleberryOptions _options;
    private readonly ILogger<HuckleberryHomeAssistantProvider> _logger;
    private readonly TimeProvider _time;

    public HuckleberryHomeAssistantProvider(
        HomeAssistantClient ha,
        HuckleberrySnapshotCache cache,
        IOptions<HuckleberryOptions> options,
        ILogger<HuckleberryHomeAssistantProvider> logger,
        TimeProvider time)
    {
        _ha = ha;
        _cache = cache;
        _options = options.Value;
        _logger = logger;
        _time = time;
    }

    public bool IsConfigured => _ha.IsConfigured && _options.Enabled;

    public async Task<HuckleberryHealth> GetHealthAsync(CancellationToken ct)
    {
        if (!IsConfigured)
            return new HuckleberryHealth(HuckleberryStatus.NotConfigured, "Home Assistant is not configured.", null);

        var fresh = await TryRefreshAsync(ct);
        if (fresh)
        {
            return _cache.Children.Count == 0
                ? new HuckleberryHealth(HuckleberryStatus.IntegrationMissing,
                    "Home Assistant answered but exposes no Huckleberry child entities. Check the HACS integration and its config flow.",
                    _cache.LastGoodUtc)
                : new HuckleberryHealth(HuckleberryStatus.Ok, null, _cache.LastGoodUtc);
        }

        // Separate "HA is down" from "HA is up but the integration is broken" — different fixes.
        var reachable = await _ha.PingAsync(ct);
        if (!reachable)
            return new HuckleberryHealth(HuckleberryStatus.HomeAssistantUnreachable,
                "Home Assistant did not respond.", _cache.LastGoodUtc);

        return _cache.HasValue
            ? new HuckleberryHealth(HuckleberryStatus.Stale, "Serving the last known reading.", _cache.LastGoodUtc)
            : new HuckleberryHealth(HuckleberryStatus.IntegrationMissing,
                "Home Assistant is reachable but no Huckleberry data could be read.", null);
    }

    public async Task<IReadOnlyList<BabyChild>> GetChildrenAsync(CancellationToken ct)
    {
        if (!IsConfigured) return [];
        await TryRefreshAsync(ct);
        return _cache.Children;
    }

    public async Task<BabyState?> GetStateAsync(string childKey, CancellationToken ct)
    {
        if (!IsConfigured) return null;
        var fresh = await TryRefreshAsync(ct);
        return _cache.GetState(childKey, stale: !fresh);
    }

    public async Task<IReadOnlyList<BabyHistoryEvent>> GetHistoryAsync(
        string childKey, DateTimeOffset fromUtc, DateTimeOffset toUtc, CancellationToken ct)
    {
        if (!IsConfigured) return [];
        try
        {
            var entity = string.Format(CultureInfo.InvariantCulture, _options.CalendarEntityFormat, childKey);
            var events = await _ha.GetCalendarEventsAsync(entity, fromUtc, toUtc, ct);
            return events
                .Select(ToHistoryEvent)
                .Where(e => e is not null)
                .Select(e => e!)
                .OrderByDescending(e => e.StartUtc)
                .ToList();
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            // An unusable calendar is a known possibility (Gate H0.3) — empty history, not an error page.
            _logger.LogWarning(ex, "Huckleberry history fetch failed for {Child}; returning no events.", childKey);
            return [];
        }
    }

    /// <summary>
    /// Refreshes the snapshot if it has aged out. Returns false when the refresh failed and callers
    /// should serve cached data with a stale flag.
    /// </summary>
    private async Task<bool> TryRefreshAsync(CancellationToken ct)
    {
        var now = _time.GetUtcNow();
        if (!_cache.IsExpired(TimeSpan.FromSeconds(Math.Max(1, _options.CacheSeconds)), now))
            return true;

        try
        {
            var states = await _ha.GetStatesAsync(SensorPrefix, ct);
            var byEntity = states
                .Where(s => s.EntityId is not null)
                .ToDictionary(s => s.EntityId!, StringComparer.Ordinal);

            var children = ResolveChildren(byEntity, states);
            var built = new Dictionary<string, BabyState>(StringComparer.Ordinal);

            foreach (var child in children)
            {
                var counts = await TryGetTodayCountsAsync(child.Key, now, ct);
                built[child.Key] = BuildState(child.Key, child.Name, byEntity, counts, now);
            }

            _cache.Store(children, built, now);
            return true;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Huckleberry refresh from Home Assistant failed; serving last known state.");
            return false;
        }
    }

    /// <summary>
    /// Resolves the children, preferring the integration's own <c>sensor.huckleberry_children</c>
    /// listing (which carries name, uid and birthday) over entity-name inference. Explicit config
    /// wins over both.
    /// </summary>
    private List<BabyChild> ResolveChildren(Dictionary<string, HaState> byEntity, IReadOnlyList<HaState> states)
    {
        // 1. Explicit config pin.
        if (_options.Children.Count > 0)
            return _options.Children.Select(k => new BabyChild(k, ResolveName(k, byEntity))).ToList();

        // 2. The integration's own child listing — authoritative when present.
        if (byEntity.TryGetValue(HuckleberryEntities.ChildrenSensor, out var listing)
            && listing.GetArray(HuckleberryEntities.Children) is { } array)
        {
            var fromListing = new List<BabyChild>();
            foreach (var element in array.EnumerateArray())
            {
                var name = element.TryGetProperty(HuckleberryEntities.ChildName, out var n) ? n.GetString() : null;
                if (string.IsNullOrWhiteSpace(name)) continue;

                var key = HaEntityId.Slugify(name);
                var uid = element.TryGetProperty(HuckleberryEntities.ChildUid, out var u) ? u.GetString() : null;
                DateOnly? birthday = element.TryGetProperty(HuckleberryEntities.Birthday, out var b)
                    && DateOnly.TryParse(b.GetString(), out var parsed) ? parsed : null;

                fromListing.Add(new BabyChild(key, _options.ChildNames.GetValueOrDefault(key) ?? name, uid, birthday));
            }
            if (fromListing.Count > 0) return fromListing;
        }

        // 3. Fall back to inferring from entity names.
        return DiscoverChildKeys(states).Select(k => new BabyChild(k, ResolveName(k, byEntity))).ToList();
    }

    /// <summary>
    /// Groups entity ids by child slug. Requires at least two distinct Huckleberry suffixes so an
    /// unrelated entity (a <c>sensor.guest_room_profile</c>) can't masquerade as a child.
    /// </summary>
    private static List<string> DiscoverChildKeys(IReadOnlyList<HaState> sensorStates)
    {
        var hits = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        foreach (var s in sensorStates)
        {
            if (s.EntityId is null || !s.EntityId.StartsWith(SensorPrefix, StringComparison.Ordinal)) continue;
            var name = s.EntityId[SensorPrefix.Length..];

            foreach (var suffix in HuckleberryEntities.AllSuffixes)
            {
                if (!name.EndsWith(suffix, StringComparison.Ordinal) || name.Length <= suffix.Length) continue;
                var key = name[..^suffix.Length];
                if (!hits.TryGetValue(key, out var set)) hits[key] = set = new(StringComparer.Ordinal);
                set.Add(suffix);
                break;
            }
        }

        return hits.Where(kv => kv.Value.Count >= 2)
            .Select(kv => kv.Key)
            .OrderBy(k => k, StringComparer.Ordinal)
            .ToList();
    }

    private string ResolveName(string key, Dictionary<string, HaState> byEntity)
    {
        if (_options.ChildNames.TryGetValue(key, out var configured) && !string.IsNullOrWhiteSpace(configured))
            return configured;

        if (byEntity.TryGetValue(Entity(key, HuckleberryEntities.ProfileSuffix), out var profile))
        {
            var fromAttr = profile.GetString(HuckleberryEntities.ChildName) ?? profile.FriendlyName;
            if (!string.IsNullOrWhiteSpace(fromAttr)) return fromAttr;
        }

        // Last resort: turn the slug into something presentable ("baby_alice" → "Baby Alice").
        return CultureInfo.CurrentCulture.TextInfo.ToTitleCase(key.Replace('_', ' '));
    }

    private static BabyState BuildState(
        string key, string name, Dictionary<string, HaState> byEntity, BabyDailyCounts counts, DateTimeOffset now)
    {
        byEntity.TryGetValue(Entity(key, HuckleberryEntities.SleepSuffix), out var sleep);
        byEntity.TryGetValue(Entity(key, HuckleberryEntities.NursingSuffix), out var nursing);
        byEntity.TryGetValue(Entity(key, HuckleberryEntities.BottleSuffix), out var bottle);
        byEntity.TryGetValue(Entity(key, HuckleberryEntities.DiaperSuffix), out var diaper);
        byEntity.TryGetValue(Entity(key, HuckleberryEntities.GrowthSuffix), out var growth);

        return new BabyState(
            ChildKey: key,
            ChildName: name,
            Sleep: ReadSleep(sleep),
            Nursing: ReadNursing(nursing),
            Bottle: ReadBottle(bottle),
            Diaper: ReadDiaper(diaper),
            Growth: ReadGrowth(growth),
            Today: counts,
            FetchedUtc: now,
            Stale: false);
    }

    /// <summary>
    /// Maps the timer state. <c>none</c> is a real answer (idle), so it is matched explicitly rather
    /// than falling through the generic "unavailable" test.
    /// </summary>
    private static BabySleepState ReadTimerState(HaState s) => s.State switch
    {
        HuckleberryEntities.StateActive => BabySleepState.Asleep,
        HuckleberryEntities.StatePaused => BabySleepState.Paused,
        HuckleberryEntities.StateNone or "None" => BabySleepState.Awake,
        _ => BabySleepState.Unknown,
    };

    /// <summary>
    /// Start basis for a running timer. The integration publishes no current-start attribute when
    /// idle, so the candidate names are unconfirmed; <c>last_changed</c> is the fallback, since the
    /// state flipping to <c>active</c> is when the timer began.
    /// </summary>
    private static DateTimeOffset? ReadActiveStart(HaState s)
    {
        foreach (var name in HuckleberryEntities.ActiveStartCandidates)
        {
            var value = s.GetDateTime(name);
            if (value is not null) return value.Value.ToUniversalTime();
        }
        return s.LastChanged?.ToUniversalTime();
    }

    private static BabySleepSummary ReadSleep(HaState? s)
    {
        if (s is null) return new BabySleepSummary(BabySleepState.Unknown, null, false);

        var state = ReadTimerState(s);
        var running = state is BabySleepState.Asleep or BabySleepState.Paused;

        return new BabySleepSummary(
            state,
            running ? ReadActiveStart(s) : null,
            Paused: state == BabySleepState.Paused,
            LastSessionStartUtc: s.GetDateTime(HuckleberryEntities.PreviousStart)?.ToUniversalTime(),
            LastSessionDuration: s.GetIso8601Duration(HuckleberryEntities.PreviousDuration));
    }

    private static BabyNursingSummary ReadNursing(HaState? s)
    {
        if (s is null) return new BabyNursingSummary(false, false, null, null, null);

        var state = ReadTimerState(s);
        var running = state is BabySleepState.Asleep or BabySleepState.Paused;

        return new BabyNursingSummary(
            Running: state == BabySleepState.Asleep,
            Paused: state == BabySleepState.Paused,
            StartedUtc: running ? ReadActiveStart(s) : null,
            Side: s.GetString(HuckleberryEntities.PreviousLastSide),
            LastAtUtc: s.GetDateTime(HuckleberryEntities.PreviousStart)?.ToUniversalTime(),
            LastDuration: s.GetIso8601Duration(HuckleberryEntities.PreviousDuration),
            LastLeftDuration: s.GetIso8601Duration(HuckleberryEntities.PreviousLeftDuration),
            LastRightDuration: s.GetIso8601Duration(HuckleberryEntities.PreviousRightDuration));
    }

    private static BabyBottleSummary ReadBottle(HaState? s)
    {
        if (s is null) return new BabyBottleSummary(null, null, null, null);
        // Both `time` and the state value carry the timestamp; prefer the attribute for precision.
        var last = s.GetDateTime(HuckleberryEntities.Time) ?? StateAsTime(s);
        return new BabyBottleSummary(
            last?.ToUniversalTime(),
            s.GetDouble(HuckleberryEntities.Amount),
            s.GetString(HuckleberryEntities.AmountUnit),
            s.GetString(HuckleberryEntities.EntryType));
    }

    private static BabyDiaperSummary ReadDiaper(HaState? s)
    {
        if (s is null) return new BabyDiaperSummary(null, null);
        var last = s.GetDateTime(HuckleberryEntities.Time) ?? StateAsTime(s);
        return new BabyDiaperSummary(last?.ToUniversalTime(), s.GetString(HuckleberryEntities.EntryType));
    }

    /// <summary>
    /// Growth attribute names are <b>unconfirmed</b> — the sensor reports <c>unknown</c> with no
    /// attributes until a measurement exists, so there was nothing to observe at Gate H0.2. The
    /// timestamp comes from the state value (the sensor is <c>device_class: timestamp</c>), which is
    /// verified; the measurement fields degrade to null until confirmed against real data.
    /// </summary>
    private static BabyGrowthSummary ReadGrowth(HaState? s)
    {
        if (s is null) return new BabyGrowthSummary(null, null, null, null, null, null);
        var measured = s.GetDateTime(HuckleberryEntities.Time) ?? StateAsTime(s);
        return new BabyGrowthSummary(
            measured?.ToUniversalTime(),
            s.GetDouble(HuckleberryEntities.Weight),
            s.GetString("units") ?? s.GetString("weight_units"),
            s.GetDouble(HuckleberryEntities.Height),
            s.GetDouble(HuckleberryEntities.HeadCircumference),
            s.GetString("length_units"));
    }

    /// <summary>Some of these sensors carry their timestamp as the state value itself.</summary>
    private static DateTimeOffset? StateAsTime(HaState s) =>
        !s.IsUnavailable && DateTimeOffset.TryParse(s.State, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : null;

    /// <summary>
    /// "Today" for the dashboard's counts line, as the household means it.
    /// </summary>
    /// <remarks>
    /// Deliberately the <b>local</b> calendar day, not the UTC one. Using
    /// <c>now.UtcDateTime.Date</c> was a real defect caught against live data: at UTC-05:00 a bottle
    /// logged at 20:28 local falls into the *next* UTC day, so every evening between 19:00 and
    /// midnight the previous night's feeds silently inflated today's tally. A wall panel must count
    /// the day the family is living in.
    /// </remarks>
    private async Task<BabyDailyCounts> TryGetTodayCountsAsync(string key, DateTimeOffset now, CancellationToken ct)
    {
        try
        {
            var tz = _time.LocalTimeZone;
            var localNow = TimeZoneInfo.ConvertTime(now, tz);
            var midnight = localNow.Date;
            var startOfDay = new DateTimeOffset(midnight, tz.GetUtcOffset(midnight));

            var events = await GetHistoryAsync(key, startOfDay, now, ct);
            var feeds = events.Count(e => BabyEventClassifier.IsFeed(e.Kind));
            var diapers = events.Count(e => e.Kind is "diaper");
            return new BabyDailyCounts(feeds, diapers);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch
        {
            return new BabyDailyCounts(0, 0);
        }
    }

    private static BabyHistoryEvent? ToHistoryEvent(HaCalendarEvent e)
    {
        var start = e.Start?.Value;
        if (start is null) return null;
        var summary = e.Summary ?? "Event";
        var end = e.End?.Value?.ToUniversalTime();
        // Point-in-time logs (bottle, diaper) arrive with end == start; only real sessions have a
        // span. Collapsing that to null keeps the UI from rendering a zero-length duration.
        var startUtc = start.Value.ToUniversalTime();
        return new BabyHistoryEvent(
            startUtc,
            end == startUtc ? null : end,
            BabyEventClassifier.ClassifyKind(summary),
            BabyEventClassifier.CleanSummary(summary),
            e.Description);
    }

    // Calendar summary → kind / display text lives in BabyEventClassifier.

    // ---- writes ----

    public Task<BabyWriteResult> TimerActionAsync(
        string childKey, BabyTimerKind timer, BabyTimerAction action, NursingSide? side, CancellationToken ct)
    {
        if (timer == BabyTimerKind.Sleep && action == BabyTimerAction.SwitchSide)
            return Task.FromResult(BabyWriteResult.Fail("Sleep timers have no side to switch."));

        var service = HuckleberryServiceValues.Service(timer, action);
        var payload = new Dictionary<string, object>(StringComparer.Ordinal);
        if (side is not null && HuckleberryServiceValues.AcceptsSide(timer, action))
            payload["side"] = HuckleberryServiceValues.Side(side.Value);

        return CallAsync(childKey, service, payload, ct);
    }

    public Task<BabyWriteResult> LogDiaperAsync(string childKey, DiaperEntry entry, CancellationToken ct)
    {
        var payload = new Dictionary<string, object>(StringComparer.Ordinal);

        // Only send fields the chosen service actually accepts — a dry check takes no amounts, and a
        // pee-only entry takes no colour or consistency.
        var takesPee = entry.Kind is DiaperKind.Pee or DiaperKind.Both;
        var takesPoo = entry.Kind is DiaperKind.Poo or DiaperKind.Both;

        if (takesPee && entry.PeeAmount is not null)
            payload["pee_amount"] = HuckleberryServiceValues.Amount(entry.PeeAmount.Value);
        if (takesPoo && entry.PooAmount is not null)
            payload["poo_amount"] = HuckleberryServiceValues.Amount(entry.PooAmount.Value);
        if (takesPoo && entry.Color is not null)
            payload["color"] = HuckleberryServiceValues.Color(entry.Color.Value);
        if (takesPoo && entry.Consistency is not null)
            payload["consistency"] = HuckleberryServiceValues.Consistency(entry.Consistency.Value);
        if (entry.DiaperRash is not null) payload["diaper_rash"] = entry.DiaperRash.Value;
        if (!string.IsNullOrWhiteSpace(entry.Notes)) payload["notes"] = entry.Notes;

        return CallAsync(childKey, HuckleberryServiceValues.DiaperService(entry.Kind), payload, ct);
    }

    public Task<BabyWriteResult> LogBottleAsync(string childKey, BottleEntry entry, CancellationToken ct)
    {
        if (entry.Amount <= 0)
            return Task.FromResult(BabyWriteResult.Fail("Bottle amount must be greater than zero."));

        var payload = new Dictionary<string, object>(StringComparer.Ordinal)
        {
            ["amount"] = entry.Amount,
            ["bottle_type"] = HuckleberryServiceValues.Bottle(entry.Type),
            ["units"] = HuckleberryServiceValues.Units(entry.Units),
        };
        return CallAsync(childKey, "log_bottle", payload, ct);
    }

    public Task<BabyWriteResult> LogGrowthAsync(string childKey, GrowthEntry entry, CancellationToken ct)
    {
        // Refuse an empty entry rather than writing a measurement-less record that can't be deleted.
        if (!entry.HasAnyMeasurement)
            return Task.FromResult(BabyWriteResult.Fail("Provide at least one of weight, height or head circumference."));

        var payload = new Dictionary<string, object>(StringComparer.Ordinal)
        {
            ["units"] = HuckleberryServiceValues.Units(entry.Units),
        };
        if (entry.Weight is not null) payload["weight"] = entry.Weight.Value;
        if (entry.Height is not null) payload["height"] = entry.Height.Value;
        // Upstream names this `head`, not `head_circumference`.
        if (entry.Head is not null) payload["head"] = entry.Head.Value;

        return CallAsync(childKey, "log_growth", payload, ct);
    }

    /// <summary>
    /// Resolves the child's device id, adds it to the payload, and calls the service. Failures are
    /// returned, not thrown or queued — see the seam's remarks.
    /// </summary>
    private async Task<BabyWriteResult> CallAsync(
        string childKey, string service, Dictionary<string, object> payload, CancellationToken ct)
    {
        if (!IsConfigured) return BabyWriteResult.Fail("Huckleberry is not connected.");

        try
        {
            var deviceId = await ResolveDeviceIdAsync(childKey, ct);
            if (deviceId is null)
                return BabyWriteResult.Fail($"Could not resolve a Home Assistant device for '{childKey}'.");

            payload["device_id"] = deviceId;
            await _ha.CallServiceAsync("huckleberry", service, payload, ct);

            // The change lands upstream asynchronously, so drop the snapshot to force a refresh on the
            // next read rather than showing pre-write state for up to CacheSeconds.
            _cache.Invalidate();
            return BabyWriteResult.Ok;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Huckleberry service {Service} failed for {Child}.", service, childKey);
            return BabyWriteResult.Fail($"Home Assistant rejected {service}: {ex.Message}");
        }
    }

    /// <summary>
    /// Every Huckleberry service targets <c>device_id</c>, which HA's REST API does not expose — but
    /// its template endpoint does. Resolved once per child and cached.
    /// </summary>
    private async Task<string?> ResolveDeviceIdAsync(string childKey, CancellationToken ct)
    {
        var cached = _cache.GetDeviceId(childKey);
        if (cached is not null) return cached;

        var entity = Entity(childKey, HuckleberryEntities.SleepSuffix);
        var resolved = await _ha.RenderTemplateAsync($"{{{{ device_id('{entity}') }}}}", ct);
        if (resolved is null) return null;

        _cache.StoreDeviceId(childKey, resolved);
        return resolved;
    }

    private static string Entity(string key, string suffix) => $"{SensorPrefix}{key}{suffix}";
}
