namespace HomeHub.Tests;

using System.Net;
using System.Text;
using HomeHub.Api.Baby;
using HomeHub.Api.HomeAssistant;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

/// <summary>
/// Stage H2 Huckleberry reads, against a stubbed Home Assistant REST API — no network, no HA, and
/// no dependency on the live install that Gate H0 will verify. These lock in the behaviour that
/// matters when the real entity names land: defensive attribute reads, honest staleness, and a
/// health signal that distinguishes "HA down" from "integration missing".
/// </summary>
public class HuckleberryProviderTests
{
    /// <summary>Serves canned responses per URL substring, and can be flipped to fail on demand.</summary>
    private sealed class StubHaHandler : HttpMessageHandler
    {
        private readonly Dictionary<string, string> _routes;
        public bool Fail { get; set; }
        public int StatesCalls { get; private set; }
        /// <summary>Calendar URLs requested, so tests can assert the window that was asked for.</summary>
        public List<string> CalendarUrls { get; } = [];

        public StubHaHandler(Dictionary<string, string> routes) => _routes = routes;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var url = request.RequestUri!.ToString();
            if (url.Contains("api/states", StringComparison.Ordinal)) StatesCalls++;
            if (url.Contains("api/calendars", StringComparison.Ordinal)) CalendarUrls.Add(url);
            if (Fail) throw new HttpRequestException("Home Assistant is unreachable.");

            var match = _routes.FirstOrDefault(r => url.Contains(r.Key, StringComparison.Ordinal));
            var response = match.Value is null
                ? new HttpResponseMessage(HttpStatusCode.NotFound)
                : new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(match.Value, Encoding.UTF8, "application/json"),
                };
            return Task.FromResult(response);
        }
    }

    /// <summary>
    /// Captured verbatim from a live Home Assistant 2026.7.4 with huckleberry-homeassistant v0.4.3
    /// (Gate H0.2), trimmed to the fields under test. Using the real payload shape matters: the
    /// earlier invented fixture used <c>sleeping</c>, <c>is_paused</c>, <c>unit</c> and
    /// <c>last_bottle</c>, none of which the integration actually publishes — so the tests passed
    /// while the mapping was wrong.
    /// </summary>
    private const string StatesJson = """
    [
      { "entity_id": "sensor.conrad_sleep", "state": "none",
        "last_changed": "2026-07-29T19:39:35.972100+00:00",
        "attributes": { "options": ["active","paused","none"], "previous_start": "2026-07-20T19:51:31+00:00",
                        "previous_duration": "PT39M44S", "device_class": "enum", "friendly_name": "Conrad Sleep" } },
      { "entity_id": "sensor.conrad_nursing", "state": "none",
        "last_changed": "2026-07-29T19:39:35.968803+00:00",
        "attributes": { "options": ["active","paused","none"], "previous_start": "2026-07-29T10:54:37+00:00",
                        "previous_duration": "PT16M12S", "previous_left_duration": "PT12M16S",
                        "previous_right_duration": "PT3M56S", "previous_last_side": "Right",
                        "device_class": "enum", "friendly_name": "Conrad Nursing" } },
      { "entity_id": "sensor.conrad_bottle", "state": "2026-07-29T17:50:19+00:00",
        "attributes": { "time": "2026-07-29T17:50:19.020000+00:00", "amount": 3.0, "units": "oz",
                        "type": "Breast Milk", "device_class": "timestamp", "friendly_name": "Conrad Bottle" } },
      { "entity_id": "sensor.conrad_diaper", "state": "2026-07-29T19:16:46+00:00",
        "attributes": { "time": "2026-07-29T19:16:46.026000+00:00", "type": "Pee",
                        "device_class": "timestamp", "friendly_name": "Conrad Diaper" } },
      { "entity_id": "sensor.conrad_growth", "state": "unknown",
        "attributes": { "device_class": "timestamp", "friendly_name": "Conrad Growth" } },
      { "entity_id": "sensor.conrad_profile", "state": "Conrad",
        "attributes": { "uid": "WnAj5qIxizcnHtCcCheSAx0zvAt1", "name": "Conrad", "birthday": "2026-05-04",
                        "night_start": 10.0, "morning_cutoff": 6.0, "friendly_name": "Conrad Profile" } },
      { "entity_id": "sensor.huckleberry_children", "state": "1",
        "attributes": { "children": [ { "uid": "WnAj5qIxizcnHtCcCheSAx0zvAt1", "name": "Conrad",
                                        "birthday": "2026-05-04", "expected_naps": "4-5" } ],
                        "child_ids": ["WnAj5qIxizcnHtCcCheSAx0zvAt1"], "child_names": ["Conrad"],
                        "friendly_name": "Huckleberry Children" } },
      { "entity_id": "sensor.baby_room_monitor_temperature", "state": "71.2", "attributes": {} },
      { "entity_id": "sensor.mika_toliet_sleep_mode_end_time", "state": "unknown", "attributes": {} }
    ]
    """;

    /// <summary>
    /// Captured verbatim from <c>calendar.conrad_events</c> (Gate H0.3), including the emoji
    /// prefixes, the local -05:00 offsets, and the fact that point-in-time logs arrive with
    /// <c>end == start</c>. Crucially it preserves that nursing sessions are titled <b>"Feed"</b>,
    /// not "Nursing" — the payload detail that exposed the classifier defect.
    /// </summary>
    private const string CalendarJson = """
    [
      { "summary": "🍼 Bottle (3.5 oz)", "description": "Bottle feeding: 3.5 oz\nType: Breast Milk",
        "start": { "dateTime": "2026-07-29T12:50:19.655000-05:00" }, "end": { "dateTime": "2026-07-29T12:50:19.655000-05:00" } },
      { "summary": "🍼 Feed (R:6m)", "description": "Feeding - Total: 6 min 29 sec\nLeft: 1 sec\nRight: 6 min 28 sec",
        "start": { "dateTime": "2026-07-29T05:54:37-05:00" }, "end": { "dateTime": "2026-07-29T06:01:06-05:00" } },
      { "summary": "💧 Diaper (Pee)", "description": "Diaper: Pee",
        "start": { "dateTime": "2026-07-29T14:16:46-05:00" }, "end": { "dateTime": "2026-07-29T14:16:46-05:00" } },
      { "summary": "😴 Sleep (39m)", "description": "Sleep - Total: 39 min 44 sec",
        "start": { "dateTime": "2026-07-29T14:51:31-05:00" }, "end": { "dateTime": "2026-07-29T15:31:15-05:00" } }
    ]
    """;

    /// <summary>
    /// A clock the test drives, so cache expiry and day boundaries are deterministic rather than
    /// depending on wall time or the build agent's timezone.
    /// </summary>
    private sealed class FakeTime : TimeProvider
    {
        private DateTimeOffset _now;
        private readonly TimeZoneInfo _zone;

        public FakeTime(DateTimeOffset? now = null, TimeSpan? utcOffset = null)
        {
            _now = now ?? new DateTimeOffset(2026, 7, 25, 18, 0, 0, TimeSpan.Zero);
            // Mirrors the real household server (US Central, -05:00 in summer).
            _zone = TimeZoneInfo.CreateCustomTimeZone(
                "test-fixed", utcOffset ?? TimeSpan.FromHours(-5), "Test Fixed", "Test Fixed");
        }

        public override DateTimeOffset GetUtcNow() => _now;
        public override TimeZoneInfo LocalTimeZone => _zone;
        public void Advance(TimeSpan by) => _now += by;
    }

    private static (HuckleberryHomeAssistantProvider Provider, StubHaHandler Handler) NewProvider(
        string? statesJson = null, HuckleberryOptions? options = null, TimeProvider? time = null)
    {
        var handler = new StubHaHandler(new()
        {
            ["api/states"] = statesJson ?? StatesJson,
            ["api/calendars"] = CalendarJson,
            ["api/"] = "{}",
        });

        var http = new HttpClient(handler);
        var ha = new HomeAssistantClient(http, Options.Create(new HomeAssistantOptions
        {
            BaseUrl = "http://ha.test:8123",
            Token = "test-token",
        }));

        var provider = new HuckleberryHomeAssistantProvider(
            ha,
            new HuckleberrySnapshotCache(),
            Options.Create(options ?? new HuckleberryOptions()),
            NullLogger<HuckleberryHomeAssistantProvider>.Instance,
            time ?? TimeProvider.System);

        return (provider, handler);
    }

    [Fact]
    public async Task Discovers_children_from_the_integrations_own_listing()
    {
        var (provider, _) = NewProvider();

        var children = await provider.GetChildrenAsync(default);

        var child = Assert.Single(children);
        Assert.Equal("conrad", child.Key);           // slugified from the name, matching entity ids
        Assert.Equal("Conrad", child.Name);
        Assert.Equal("WnAj5qIxizcnHtCcCheSAx0zvAt1", child.Uid);
        Assert.Equal(new DateOnly(2026, 5, 4), child.Birthday);
    }

    [Theory]
    [InlineData("Conrad", "conrad")]
    [InlineData("Mary Jane", "mary_jane")]
    [InlineData("O'Brien", "o_brien")]
    [InlineData("  Anne-Marie  ", "anne_marie")]
    public void Slugify_matches_home_assistant_entity_id_convention(string name, string expected) =>
        Assert.Equal(expected, HaEntityId.Slugify(name));

    [Fact]
    public async Task Discovery_falls_back_to_entity_names_and_requires_two_suffixes()
    {
        // No huckleberry_children listing here, so the heuristic path runs. A lone `*_profile`
        // entity from some other integration must not become a child.
        const string states = """
        [
          { "entity_id": "sensor.guest_room_profile", "state": "ok",   "attributes": {} },
          { "entity_id": "sensor.bob_sleep",          "state": "none", "attributes": {} },
          { "entity_id": "sensor.bob_diaper",         "state": "none", "attributes": {} }
        ]
        """;
        var (provider, _) = NewProvider(states);

        var children = await provider.GetChildrenAsync(default);

        Assert.Equal(["bob"], children.Select(c => c.Key));
    }

    [Fact]
    public async Task Real_sensors_that_are_not_children_are_not_discovered()
    {
        // Guards against regressions from the live instance: a room monitor and a cat litter box
        // sit alongside the Huckleberry entities.
        var (provider, _) = NewProvider();

        var children = await provider.GetChildrenAsync(default);

        Assert.DoesNotContain(children, c => c.Key.Contains("monitor", StringComparison.Ordinal));
        Assert.DoesNotContain(children, c => c.Key.Contains("mika", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Maps_idle_timers_and_last_completed_sessions()
    {
        var (provider, _) = NewProvider();

        var state = await provider.GetStateAsync("conrad", default);

        Assert.NotNull(state);
        Assert.Equal("Conrad", state.ChildName);

        // state "none" means idle — awake, with no running-timer basis.
        Assert.Equal(BabySleepState.Awake, state.Sleep.State);
        Assert.Null(state.Sleep.StartedUtc);
        Assert.False(state.Sleep.Paused);
        Assert.Equal(new DateTimeOffset(2026, 7, 20, 19, 51, 31, TimeSpan.Zero), state.Sleep.LastSessionStartUtc);
        Assert.Equal(TimeSpan.FromSeconds(39 * 60 + 44), state.Sleep.LastSessionDuration);

        Assert.False(state.Nursing.Running);
        Assert.Equal("Right", state.Nursing.Side);
        Assert.Equal(TimeSpan.FromSeconds(16 * 60 + 12), state.Nursing.LastDuration);
        Assert.Equal(TimeSpan.FromSeconds(12 * 60 + 16), state.Nursing.LastLeftDuration);
        Assert.Equal(TimeSpan.FromSeconds(3 * 60 + 56), state.Nursing.LastRightDuration);

        Assert.Equal(3.0, state.Bottle.Amount);
        Assert.Equal("oz", state.Bottle.Unit);            // `units`, plural, upstream
        Assert.Equal("Breast Milk", state.Bottle.Kind);
        Assert.Equal(new DateTimeOffset(2026, 7, 29, 17, 50, 19, 20, TimeSpan.Zero), state.Bottle.LastAtUtc);

        Assert.Equal("Pee", state.Diaper.Kind);
        Assert.Equal(new DateTimeOffset(2026, 7, 29, 19, 16, 46, 26, TimeSpan.Zero), state.Diaper.LastAtUtc);

        // Growth has no measurement logged yet — must be null, not zero or a crash.
        Assert.Null(state.Growth.Weight);
        Assert.Null(state.Growth.MeasuredAtUtc);

        Assert.False(state.Stale);
    }

    [Fact]
    public async Task A_running_sleep_timer_reports_asleep_with_an_elapsed_basis()
    {
        // Captured from a live running timer. `active` is the post-v0.4.0 state value (was
        // `sleeping`). Note last_changed deliberately differs from current_start by 98s, exactly as
        // observed upstream — restarting a timer updates current_start without changing the state,
        // so an elapsed counter built on last_changed reads wrong.
        const string states = """
        [
          { "entity_id": "sensor.conrad_sleep", "state": "active",
            "last_changed": "2026-07-29T20:24:16.143749+00:00",
            "attributes": { "options": ["active","paused","none"],
                            "current_start": "2026-07-29T20:25:54.888343+00:00",
                            "previous_start": "2026-07-20T19:51:31+00:00",
                            "previous_duration": "PT39M44S", "device_class": "enum" } },
          { "entity_id": "sensor.conrad_profile", "state": "Conrad", "attributes": { "name": "Conrad" } }
        ]
        """;
        var (provider, _) = NewProvider(states);

        var state = await provider.GetStateAsync("conrad", default);

        Assert.NotNull(state);
        Assert.Equal(BabySleepState.Asleep, state.Sleep.State);
        Assert.Equal(
            new DateTimeOffset(2026, 7, 29, 20, 25, 54, 888, TimeSpan.Zero).AddTicks(3430),
            state.Sleep.StartedUtc);
        Assert.False(state.Sleep.Paused);
        // The last completed session stays available alongside the running one.
        Assert.Equal(TimeSpan.FromSeconds(39 * 60 + 44), state.Sleep.LastSessionDuration);
    }

    [Fact]
    public async Task A_running_timer_without_current_start_falls_back_to_last_changed()
    {
        // Hedge against an upstream rename of current_start: the elapsed basis degrades to
        // last_changed rather than disappearing.
        const string states = """
        [
          { "entity_id": "sensor.conrad_sleep", "state": "active",
            "last_changed": "2026-07-29T18:30:00+00:00",
            "attributes": { "options": ["active","paused","none"] } },
          { "entity_id": "sensor.conrad_profile", "state": "Conrad", "attributes": { "name": "Conrad" } }
        ]
        """;
        var (provider, _) = NewProvider(states);

        var state = await provider.GetStateAsync("conrad", default);

        Assert.NotNull(state);
        Assert.Equal(new DateTimeOffset(2026, 7, 29, 18, 30, 0, TimeSpan.Zero), state.Sleep.StartedUtc);
    }

    [Fact]
    public async Task A_paused_timer_is_distinguished_from_running_and_idle()
    {
        const string states = """
        [
          { "entity_id": "sensor.conrad_sleep", "state": "paused",
            "last_changed": "2026-07-29T18:30:00+00:00",
            "attributes": { "options": ["active","paused","none"] } },
          { "entity_id": "sensor.conrad_profile", "state": "Conrad", "attributes": { "name": "Conrad" } }
        ]
        """;
        var (provider, _) = NewProvider(states);

        var state = await provider.GetStateAsync("conrad", default);

        Assert.NotNull(state);
        Assert.Equal(BabySleepState.Paused, state.Sleep.State);
        Assert.True(state.Sleep.Paused);
        Assert.NotNull(state.Sleep.StartedUtc); // a paused timer still has an elapsed basis
    }

    [Fact]
    public async Task Missing_attributes_degrade_to_null_rather_than_throwing()
    {
        // What a wrong guess in HuckleberryEntities actually looks like: entities exist, attributes
        // are named differently. The section must still render.
        const string sparse = """
        [
          { "entity_id": "sensor.conrad_sleep",  "state": "none", "attributes": {} },
          { "entity_id": "sensor.conrad_growth", "state": "unknown", "attributes": { "totally_different": 1 } }
        ]
        """;
        var (provider, _) = NewProvider(sparse);

        var state = await provider.GetStateAsync("conrad", default);

        Assert.NotNull(state);
        Assert.Equal(BabySleepState.Awake, state.Sleep.State);
        Assert.Null(state.Sleep.StartedUtc);
        Assert.Null(state.Growth.Weight);
        Assert.Null(state.Growth.MeasuredAtUtc);
    }

    [Fact]
    public async Task Serves_last_known_state_flagged_stale_when_home_assistant_fails()
    {
        var clock = new FakeTime();
        var (provider, handler) = NewProvider(options: new HuckleberryOptions { CacheSeconds = 10 }, time: clock);
        var fresh = await provider.GetStateAsync("conrad", default);
        Assert.NotNull(fresh);
        Assert.False(fresh.Stale);

        handler.Fail = true;
        clock.Advance(TimeSpan.FromMinutes(1)); // age past the freshness window so a refresh is attempted
        var cached = await provider.GetStateAsync("conrad", default);

        Assert.NotNull(cached);
        Assert.True(cached.Stale);
        Assert.Equal(fresh.Sleep.State, cached.Sleep.State);
    }

    [Fact]
    public async Task Counts_today_feeds_and_diapers_from_the_calendar()
    {
        var (provider, _) = NewProvider();

        var state = await provider.GetStateAsync("conrad", default);

        Assert.NotNull(state);
        Assert.Equal(2, state.Today.Feeds);   // bottle + nursing
        Assert.Equal(1, state.Today.Diapers);
    }

    [Fact]
    public async Task Todays_counts_use_the_local_day_not_the_utc_day()
    {
        // The defect this pins: at 20:00 local on 7/29 (-05:00) it is already 01:00Z on 7/30, so a
        // UTC-day window would start at 7/30 00:00Z and pull in the previous evening's feeds —
        // inflating the tally every night between 19:00 and midnight local.
        var clock = new FakeTime(
            now: new DateTimeOffset(2026, 7, 30, 1, 0, 0, TimeSpan.Zero),   // 20:00 local on 7/29
            utcOffset: TimeSpan.FromHours(-5));
        var (provider, handler) = NewProvider(time: clock);

        await provider.GetStateAsync("conrad", default);

        var url = Assert.Single(handler.CalendarUrls);
        // Local midnight on 7/29 is 05:00Z on 7/29 — not 7/30 00:00Z.
        Assert.Contains("start=2026-07-29T05%3A00%3A00Z", url, StringComparison.Ordinal);
        Assert.DoesNotContain("start=2026-07-30", url, StringComparison.Ordinal);
    }

    [Fact]
    public void Health_events_are_classified_rather_than_falling_through_to_other()
    {
        // Observed live: the calendar carries kinds the five sensors never expose.
        Assert.Equal("health", BabyEventClassifier.ClassifyKind("🩺 Health (Medication)"));
        Assert.False(BabyEventClassifier.IsFeed("health"));
    }

    [Fact]
    public async Task History_classifies_events_and_orders_newest_first()
    {
        var (provider, _) = NewProvider();

        var events = await provider.GetHistoryAsync(
            "conrad", new DateTimeOffset(2026, 7, 29, 0, 0, 0, TimeSpan.Zero), new DateTimeOffset(2026, 7, 30, 0, 0, 0, TimeSpan.Zero), default);

        Assert.Equal(4, events.Count);
        Assert.Equal("sleep", events[0].Kind); // 15:31 local is the latest
        Assert.Contains(events, e => e.Kind == "bottle");
        Assert.Contains(events, e => e.Kind == "diaper");
        Assert.Contains(events, e => e.Kind == "nursing");

        // The emoji prefix is stripped — the panel draws its own icon from Kind.
        Assert.Contains(events, e => e.Summary == "Bottle (3.5 oz)");
        Assert.DoesNotContain(events, e => e.Summary.StartsWith("🍼", StringComparison.Ordinal));

        // Point-in-time logs collapse a zero-length span to null; real sessions keep theirs.
        var bottle = events.Single(e => e.Kind == "bottle");
        Assert.Null(bottle.EndUtc);
        var sleep = events.Single(e => e.Kind == "sleep");
        Assert.NotNull(sleep.EndUtc);
    }

    [Theory]
    // The defect Gate H0.3 caught: nursing sessions are titled "Feed", not "Nursing", and share the
    // bottle emoji — so "bottle" must win before any "feed" match.
    [InlineData("🍼 Feed (R:6m)", "nursing")]
    [InlineData("🍼 Bottle (3.5 oz)", "bottle")]
    [InlineData("😴 Sleep (39m)", "sleep")]
    [InlineData("💧 Diaper (Pee)", "diaper")]
    [InlineData("Nap", "sleep")]
    [InlineData("Growth", "growth")]
    [InlineData("Something else", "other")]
    public void Classifies_real_calendar_summaries(string summary, string expected) =>
        Assert.Equal(expected, BabyEventClassifier.ClassifyKind(summary));

    [Fact]
    public async Task Health_reports_integration_missing_when_no_children_are_exposed()
    {
        var (provider, _) = NewProvider("[]");

        var health = await provider.GetHealthAsync(default);

        Assert.Equal(HuckleberryStatus.IntegrationMissing, health.Status);
    }

    [Fact]
    public async Task Health_separates_home_assistant_being_down_from_the_integration_being_broken()
    {
        var (provider, handler) = NewProvider();
        handler.Fail = true;

        var health = await provider.GetHealthAsync(default);

        Assert.Equal(HuckleberryStatus.HomeAssistantUnreachable, health.Status);
    }

    [Fact]
    public async Task Caches_within_the_freshness_window_so_polling_does_not_hammer_home_assistant()
    {
        var (provider, handler) = NewProvider(options: new HuckleberryOptions { CacheSeconds = 300 });

        await provider.GetStateAsync("conrad", default);
        var afterFirst = handler.StatesCalls;
        await provider.GetStateAsync("conrad", default);
        await provider.GetStateAsync("conrad", default);

        Assert.Equal(1, afterFirst);
        Assert.Equal(1, handler.StatesCalls);
    }

    [Fact]
    public async Task Not_connected_provider_is_honest_rather_than_simulated()
    {
        var provider = new NotConnectedHuckleberryProvider();

        Assert.False(provider.IsConfigured);
        Assert.Empty(await provider.GetChildrenAsync(default));
        Assert.Null(await provider.GetStateAsync("conrad", default));
        var health = await provider.GetHealthAsync(default);
        Assert.Equal(HuckleberryStatus.NotConfigured, health.Status);
    }
}
