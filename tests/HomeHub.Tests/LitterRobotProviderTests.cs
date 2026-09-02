namespace HomeHub.Tests;

using System.Net;
using System.Text;
using HomeHub.Api.Cats;
using HomeHub.Api.HomeAssistant;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

/// <summary>
/// Litter-Robot reads and the fault classification, against a stubbed Home Assistant REST API — no
/// network, no HA, no Whisker cloud.
/// </summary>
/// <remarks>
/// The classification tests matter more than the mapping tests. Every automatic reset the app performs
/// is authorised by this table, so a code drifting into the wrong bucket means either a box left
/// faulted overnight or a motor being cycled at a fault no reset can clear.
/// </remarks>
public class LitterRobotProviderTests
{
    /// <summary>Serves canned responses per URL substring, and can be flipped to fail on demand.</summary>
    private sealed class StubHaHandler : HttpMessageHandler
    {
        private readonly Dictionary<string, string> _routes;
        public bool Fail { get; set; }

        public StubHaHandler(Dictionary<string, string> routes) => _routes = routes;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            if (Fail) throw new HttpRequestException("Home Assistant is unreachable.");

            var url = request.RequestUri!.ToString();
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
    /// An LR4's sensor entities as the Whisker integration exposes them. Note <c>pet_weight</c> is
    /// <c>unavailable</c>: entities drop out whenever Whisker's cloud hiccups, and the provider must
    /// report that as unknown rather than as zero.
    /// </summary>
    private const string StatesJson = """
    [
      { "entity_id": "sensor.litter_robot_4_status_code", "state": "rdy",
        "attributes": { "device_class": "enum", "friendly_name": "Litter-Robot 4 Status code" } },
      { "entity_id": "sensor.litter_robot_4_waste_drawer", "state": "42",
        "attributes": { "unit_of_measurement": "%", "friendly_name": "Litter-Robot 4 Waste drawer" } },
      { "entity_id": "sensor.litter_robot_4_litter_level", "state": "78",
        "attributes": { "unit_of_measurement": "%", "friendly_name": "Litter-Robot 4 Litter level" } },
      { "entity_id": "sensor.litter_robot_4_pet_weight", "state": "unavailable",
        "attributes": { "unit_of_measurement": "lb", "friendly_name": "Litter-Robot 4 Pet weight" } },
      { "entity_id": "sensor.litter_robot_4_total_cycles", "state": "1843",
        "attributes": { "friendly_name": "Litter-Robot 4 Total cycles" } },
      { "entity_id": "sensor.litter_robot_4_last_seen", "state": "2026-07-29T19:40:00+00:00",
        "attributes": { "device_class": "timestamp", "friendly_name": "Litter-Robot 4 Last seen" } },
      { "entity_id": "sensor.living_room_temperature", "state": "72",
        "attributes": { "friendly_name": "Living Room Temperature" } }
    ]
    """;

    private sealed class FakeTime : TimeProvider
    {
        private DateTimeOffset _now = new(2026, 7, 29, 20, 0, 0, TimeSpan.Zero);
        public override DateTimeOffset GetUtcNow() => _now;
        public void Advance(TimeSpan by) => _now += by;
    }

    private static (LitterRobotHomeAssistantProvider Provider, StubHaHandler Handler) NewProvider(
        string? statesJson = null, CatOptions? options = null, TimeProvider? time = null)
    {
        var handler = new StubHaHandler(new()
        {
            ["api/states"] = statesJson ?? StatesJson,
            ["api/"] = "{}",
        });

        /*
         * The shape a real household now has to configure.
         *
         * A URL and a token used to be the whole of `IsConfigured`, and these tests said so by
         * passing without either of the two lines below. Home Assistant holds a long-lived
         * service-call token, so its origin is approved exactly rather than by reach — and plain http
         * to a host that is not this machine puts that token on the LAN in the clear, which is a
         * decision the deployment has to make out loud. Both are stated here for the same reason a
         * household states them: the alternative is the integration silently not being configured.
         */
        var ha = new HomeAssistantClient(new HttpClient(handler), Options.Create(new HomeAssistantOptions
        {
            BaseUrl = "http://ha.test:8123",
            Token = "test-token",
            AllowedOrigins = ["http://ha.test:8123"],
            AcknowledgeCleartextLan = true,
        }));

        var provider = new LitterRobotHomeAssistantProvider(
            ha,
            new CatSnapshotCache(),
            Options.Create(options ?? new CatOptions()),
            NullLogger<LitterRobotHomeAssistantProvider>.Instance,
            time ?? new FakeTime());

        return (provider, handler);
    }

    // ---- classification ----

    /// <summary>
    /// Every option Home Assistant's <c>status_code</c> sensor declares must be classified. An
    /// unclassified code falls to <see cref="LitterRobotFaultClass.Unknown"/> and is never acted on, so
    /// a gap here silently disables recovery for that fault.
    /// </summary>
    [Theory]
    [InlineData("br")] [InlineData("ccc")] [InlineData("ccp")] [InlineData("cd")] [InlineData("csf")]
    [InlineData("csi")] [InlineData("cst")] [InlineData("df1")] [InlineData("df2")] [InlineData("dfs")]
    [InlineData("dhf")] [InlineData("dpf")] [InlineData("ec")] [InlineData("hpf")] [InlineData("off")]
    [InlineData("offline")] [InlineData("otf")] [InlineData("p")] [InlineData("pd")] [InlineData("pwrd")]
    [InlineData("pwru")] [InlineData("rdy")] [InlineData("scf")] [InlineData("sdf")] [InlineData("spf")]
    public void Every_home_assistant_status_option_is_classified(string code)
    {
        var fault = LitterRobotFaults.Classify(code);
        Assert.NotEqual(LitterRobotFaultClass.Unknown, fault.Class);
        Assert.False(string.IsNullOrWhiteSpace(fault.Text));
    }

    /// <summary>The lock-ins this subsystem exists for: paused mid-cycle, and a globe parked off-home.</summary>
    [Theory]
    [InlineData("p")]
    [InlineData("hpf")]
    [InlineData("dpf")]
    [InlineData("dhf")]
    public void Lock_in_faults_are_recoverable(string code) =>
        Assert.Equal(LitterRobotFaultClass.Recoverable, LitterRobotFaults.Classify(code).Class);

    /// <summary>
    /// A full drawer makes the robot refuse to cycle, so retrying is a loop that never ends and never
    /// tells anyone. Bonnet-removed is likewise physical.
    /// </summary>
    [Theory]
    [InlineData("dfs")]
    [InlineData("sdf")]
    [InlineData("br")]
    public void Physical_faults_are_never_retried(string code) =>
        Assert.Equal(LitterRobotFaultClass.NeedsHuman, LitterRobotFaults.Classify(code).Class);

    [Fact]
    public void Cat_detected_is_its_own_class_so_commands_can_be_gated() =>
        Assert.Equal(LitterRobotFaultClass.CatPresent, LitterRobotFaults.Classify("cd").Class);

    /// <summary>Drawer-nearly-full still cycles; treating it as a fault would trigger pointless resets.</summary>
    [Theory]
    [InlineData("df1")]
    [InlineData("df2")]
    [InlineData("rdy")]
    public void Nearly_full_drawer_is_still_usable(string code) =>
        Assert.Equal(LitterRobotFaultClass.Stable, LitterRobotFaults.Classify(code).Class);

    /// <summary>Mechanical faults get one attempt: a repeat means an obstruction, and more cycles make it worse.</summary>
    [Theory]
    [InlineData("otf")]
    [InlineData("pd")]
    [InlineData("spf")]
    public void Mechanical_faults_cap_at_one_attempt(string code)
    {
        var fault = LitterRobotFaults.Classify(code);
        Assert.Equal(LitterRobotFaultClass.Recoverable, fault.Class);
        Assert.Equal(1, fault.MaxAttempts);
    }

    /// <summary>A code added by a firmware update must not be guessed at.</summary>
    [Fact]
    public void Unrecognised_codes_are_reported_not_acted_on()
    {
        var fault = LitterRobotFaults.Classify("wat");
        Assert.Equal(LitterRobotFaultClass.Unknown, fault.Class);
        Assert.False(fault.IsRecoverable);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void Missing_status_is_unknown(string? code) =>
        Assert.Equal(LitterRobotFaultClass.Unknown, LitterRobotFaults.Classify(code).Class);

    // ---- reads ----

    [Fact]
    public async Task Robots_are_discovered_from_the_status_code_sensor()
    {
        var (provider, _) = NewProvider();

        var robots = await provider.GetRobotsAsync(default);

        var robot = Assert.Single(robots);
        Assert.Equal("litter_robot_4", robot.Slug);
        // The device name is the useful half of "Litter-Robot 4 Status code".
        Assert.Equal("Litter-Robot 4", robot.Name);
    }

    [Fact]
    public async Task Snapshot_maps_the_numeric_sensors()
    {
        var (provider, _) = NewProvider();

        var snapshot = await provider.GetSnapshotAsync("litter_robot_4", default);

        Assert.NotNull(snapshot);
        Assert.Equal("rdy", snapshot.Fault.Code);
        Assert.True(snapshot.IsUsable);
        Assert.Equal(42, snapshot.WasteDrawerPercent);
        Assert.Equal(78, snapshot.LitterPercent);
        Assert.Equal(1843, snapshot.TotalCycles);
        Assert.Equal(new DateTimeOffset(2026, 7, 29, 19, 40, 0, TimeSpan.Zero), snapshot.LastSeenUtc);
    }

    /// <summary>
    /// The distinction that keeps the empty-globe alert honest: an unavailable entity is unknown, not
    /// zero. Reading it as 0% would fire "out of litter" on every Whisker cloud hiccup.
    /// </summary>
    [Fact]
    public async Task Unavailable_sensors_read_as_unknown_not_zero()
    {
        var (provider, _) = NewProvider();

        var snapshot = await provider.GetSnapshotAsync("litter_robot_4", default);

        Assert.NotNull(snapshot);
        Assert.Null(snapshot.PetWeightLbs);
    }

    /// <summary>
    /// The observed failure: the Whisker integration stops refreshing <c>_last_seen</c> and it freezes
    /// days in the past while the rest of the robot's entities keep updating. Trusting it alone made the
    /// panel say "last seen 2d ago" beside gauges read minutes earlier.
    /// </summary>
    [Fact]
    public async Task Frozen_last_seen_sensor_defers_to_fresher_telemetry()
    {
        const string json = """
        [
          { "entity_id": "sensor.lr4_status_code", "state": "rdy",
            "attributes": { "friendly_name": "LR4 Status code" },
            "last_changed": "2026-07-29T19:58:00+00:00", "last_updated": "2026-07-29T19:58:00+00:00" },
          { "entity_id": "sensor.lr4_last_seen", "state": "2026-07-27T12:54:59+00:00",
            "attributes": { "device_class": "timestamp", "friendly_name": "LR4 Last seen" },
            "last_changed": "2026-07-28T13:26:47+00:00" }
        ]
        """;
        var (provider, _) = NewProvider(json);

        var snapshot = await provider.GetSnapshotAsync("lr4", default);

        Assert.NotNull(snapshot);
        Assert.Equal(new DateTimeOffset(2026, 7, 29, 19, 58, 0, TimeSpan.Zero), snapshot.LastSeenUtc);
    }

    /// <summary>
    /// The exclusion that keeps the fix honest. When Whisker's cloud drops, its entities go
    /// <c>unavailable</c> and HA restamps them with the current time. Counting those would report a
    /// robot that has genuinely gone silent as freshly seen — the one failure this screen exists for.
    /// </summary>
    [Fact]
    public async Task Unavailable_entities_restamped_by_a_restart_are_not_contact()
    {
        const string json = """
        [
          { "entity_id": "sensor.lr4_status_code", "state": "unavailable",
            "attributes": { "friendly_name": "LR4 Status code" },
            "last_changed": "2026-07-29T19:59:00+00:00", "last_updated": "2026-07-29T19:59:00+00:00" },
          { "entity_id": "sensor.lr4_last_seen", "state": "2026-07-27T12:54:59+00:00",
            "attributes": { "device_class": "timestamp", "friendly_name": "LR4 Last seen" },
            "last_changed": "2026-07-29T19:59:00+00:00", "last_updated": "2026-07-29T19:59:00+00:00" }
        ]
        """;
        var (provider, _) = NewProvider(json);

        var snapshot = await provider.GetSnapshotAsync("lr4", default);

        Assert.NotNull(snapshot);
        Assert.Equal(new DateTimeOffset(2026, 7, 27, 12, 54, 59, TimeSpan.Zero), snapshot.LastSeenUtc);
    }

    /// <summary>
    /// A <c>button</c>'s state is the moment it was last pressed, and the recovery ladder presses
    /// <c>_reset</c>. HomeHub commanding the robot must never be mistaken for the robot answering.
    /// </summary>
    [Fact]
    public async Task Commands_we_issued_do_not_count_as_the_robot_reporting()
    {
        const string json = """
        [
          { "entity_id": "sensor.lr4_status_code", "state": "rdy",
            "attributes": { "friendly_name": "LR4 Status code" },
            "last_changed": "2026-07-27T12:00:00+00:00", "last_updated": "2026-07-27T12:00:00+00:00" },
          { "entity_id": "sensor.lr4_last_seen", "state": "2026-07-27T12:54:59+00:00",
            "attributes": { "device_class": "timestamp", "friendly_name": "LR4 Last seen" },
            "last_changed": "2026-07-27T12:54:59+00:00" },
          { "entity_id": "button.lr4_reset", "state": "2026-07-29T19:59:00+00:00",
            "attributes": { "friendly_name": "LR4 Reset" },
            "last_changed": "2026-07-29T19:59:00+00:00", "last_updated": "2026-07-29T19:59:00+00:00" }
        ]
        """;
        var (provider, _) = NewProvider(json);

        var snapshot = await provider.GetSnapshotAsync("lr4", default);

        Assert.NotNull(snapshot);
        Assert.Equal(new DateTimeOffset(2026, 7, 27, 12, 54, 59, TimeSpan.Zero), snapshot.LastSeenUtc);
    }

    /// <summary>The waste-drawer suffix has moved between HA releases, so both spellings resolve.</summary>
    [Fact]
    public async Task Alternate_waste_drawer_entity_name_still_resolves()
    {
        const string json = """
        [
          { "entity_id": "sensor.lr4_status_code", "state": "rdy", "attributes": { "friendly_name": "LR4 Status code" } },
          { "entity_id": "sensor.lr4_waste_drawer_level", "state": "17", "attributes": { "friendly_name": "LR4 Waste drawer level" } }
        ]
        """;
        var (provider, _) = NewProvider(json);

        var snapshot = await provider.GetSnapshotAsync("lr4", default);

        Assert.NotNull(snapshot);
        Assert.Equal(17, snapshot.WasteDrawerPercent);
    }

    [Fact]
    public async Task Unrelated_sensors_are_not_mistaken_for_robots()
    {
        const string json = """
        [ { "entity_id": "sensor.living_room_temperature", "state": "72", "attributes": {} } ]
        """;
        var (provider, _) = NewProvider(json);

        Assert.Empty(await provider.GetRobotsAsync(default));
    }

    /// <summary>
    /// The pinned-slug branch, using the household's real slug. Pinning bypasses discovery entirely, so
    /// a typo here would silently yield a robot with every field unknown rather than an error — worth a
    /// test that the configured slug actually resolves its entities.
    /// </summary>
    [Fact]
    public async Task An_explicitly_configured_slug_resolves_without_discovery()
    {
        const string json = """
        [
          { "entity_id": "sensor.mika_toliet_status_code", "state": "hpf",
            "attributes": { "friendly_name": "Mika Toliet Status code" } },
          { "entity_id": "sensor.mika_toliet_waste_drawer", "state": "31",
            "attributes": { "friendly_name": "Mika Toliet Waste drawer" } },
          { "entity_id": "sensor.mika_toliet_litter_level", "state": "64",
            "attributes": { "friendly_name": "Mika Toliet Litter level" } }
        ]
        """;
        var options = new CatOptions { Robots = { "mika_toliet" } };
        var (provider, _) = NewProvider(json, options);

        var robot = Assert.Single(await provider.GetRobotsAsync(default));
        Assert.Equal("mika_toliet", robot.Slug);
        Assert.Equal("Mika Toliet", robot.Name);

        var snapshot = await provider.GetSnapshotAsync("mika_toliet", default);
        Assert.NotNull(snapshot);
        Assert.Equal(LitterRobotFaultClass.Recoverable, snapshot.Fault.Class);
        Assert.Equal("Home Position Fault", snapshot.Fault.Text);
        Assert.Equal(31, snapshot.WasteDrawerPercent);
        Assert.Equal(64, snapshot.LitterPercent);
    }

    [Fact]
    public async Task Configured_names_override_the_friendly_name()
    {
        var options = new CatOptions { RobotNames = { ["litter_robot_4"] = "Downstairs box" } };
        var (provider, _) = NewProvider(options: options);

        var robot = Assert.Single(await provider.GetRobotsAsync(default));
        Assert.Equal("Downstairs box", robot.Name);
    }

    // ---- health ----

    [Fact]
    public async Task Health_is_ok_when_entities_are_present()
    {
        var (provider, _) = NewProvider();
        var health = await provider.GetHealthAsync(default);
        Assert.Equal(CatIntegrationStatus.Ok, health.Status);
    }

    /// <summary>"HA is up but the integration isn't there" and "HA is down" need different fixes.</summary>
    [Fact]
    public async Task Health_reports_integration_missing_when_ha_answers_with_no_robots()
    {
        var (provider, _) = NewProvider("[]");
        var health = await provider.GetHealthAsync(default);
        Assert.Equal(CatIntegrationStatus.IntegrationMissing, health.Status);
    }

    [Fact]
    public async Task Health_reports_home_assistant_unreachable_when_it_does_not_answer()
    {
        var (provider, handler) = NewProvider();
        handler.Fail = true;

        var health = await provider.GetHealthAsync(default);

        Assert.Equal(CatIntegrationStatus.HomeAssistantUnreachable, health.Status);
    }

    [Fact]
    public async Task A_failed_refresh_serves_the_last_snapshot_flagged_stale()
    {
        var time = new FakeTime();
        var (provider, handler) = NewProvider(time: time);
        var first = await provider.GetSnapshotAsync("litter_robot_4", default);
        Assert.False(first!.Stale);

        handler.Fail = true;
        time.Advance(TimeSpan.FromMinutes(5));
        var second = await provider.GetSnapshotAsync("litter_robot_4", default);

        Assert.NotNull(second);
        Assert.True(second.Stale);
        Assert.Equal("rdy", second.Fault.Code);
    }

    /// <summary>
    /// The recovery loop must never command a robot on a cached status, so its read path bypasses the
    /// cache and surfaces failures instead of quietly serving stale data.
    /// </summary>
    [Fact]
    public async Task The_recovery_read_path_bypasses_the_cache_and_propagates_failure()
    {
        var (provider, handler) = NewProvider();
        await provider.GetSnapshotAsync("litter_robot_4", default);

        handler.Fail = true;

        await Assert.ThrowsAsync<HttpRequestException>(() => provider.GetFreshSnapshotsAsync(default));
    }

    // ---- controls ----

    /// <summary>
    /// An LR4 with the full control set: three switches and both maintenance buttons. The panel gates
    /// every control on these, so a suffix drifting upstream shows up here as a control that quietly
    /// stops being offered rather than as a button that presses nothing.
    /// </summary>
    private const string ControlsJson = """
    [
      { "entity_id": "sensor.litter_robot_4_status_code", "state": "rdy",
        "attributes": { "friendly_name": "Litter-Robot 4 Status code" } },
      { "entity_id": "switch.litter_robot_4_sleep_mode", "state": "on",
        "attributes": { "friendly_name": "Litter-Robot 4 Sleep mode" } },
      { "entity_id": "switch.litter_robot_4_night_light", "state": "off",
        "attributes": { "friendly_name": "Litter-Robot 4 Night light" } },
      { "entity_id": "switch.litter_robot_4_panel_lockout", "state": "unavailable",
        "attributes": { "friendly_name": "Litter-Robot 4 Panel lockout" } },
      { "entity_id": "button.litter_robot_4_reset_waste_drawer", "state": "2026-07-29T18:00:00+00:00",
        "attributes": { "friendly_name": "Litter-Robot 4 Reset waste drawer" } }
    ]
    """;

    /// <summary>
    /// The four multi-position settings, as HA publishes them. The night light is the one that
    /// matters: it is a four-option select, and treating it as a boolean was the single biggest error
    /// in the original design.
    /// </summary>
    private const string SelectsJson = """
    [
      { "entity_id": "sensor.litter_robot_4_status_code", "state": "rdy",
        "attributes": { "friendly_name": "Litter-Robot 4 Status code" } },
      { "entity_id": "select.litter_robot_4_globe_light", "state": "Medium",
        "attributes": { "options": ["Off", "Low", "Medium", "High"] } },
      { "entity_id": "select.litter_robot_4_clean_cycle_wait_time_minutes", "state": "7",
        "attributes": { "options": ["3", "7", "15"] } },
      { "entity_id": "select.litter_robot_4_panel_brightness", "state": "unavailable",
        "attributes": { "options": ["Low", "Medium", "High"] } },
      { "entity_id": "sensor.litter_robot_4_hopper_status", "state": "Enabled",
        "attributes": { "friendly_name": "Litter-Robot 4 Hopper status" } }
    ]
    """;

    [Fact]
    public async Task Selects_carry_their_current_value_and_the_options_the_entity_declares()
    {
        var (provider, _) = NewProvider(SelectsJson);

        var snapshot = await provider.GetSnapshotAsync("litter_robot_4", default);

        Assert.NotNull(snapshot);
        var light = snapshot.Controls.Selects[LitterRobotSelect.NightLight];
        Assert.Equal("Medium", light.Current);
        // Options come from the entity rather than a hardcoded list, so a robot that offers a
        // different set gets its own set — not this one.
        Assert.Equal(["Off", "Low", "Medium", "High"], light.Options);

        Assert.Equal("7", snapshot.Controls.Selects[LitterRobotSelect.CleanCycleWait].Current);
        Assert.Equal("Enabled", snapshot.Controls.HopperStatus);
    }

    /// <summary>An unavailable select still reports its options, so the panel can say what it wants to be.</summary>
    [Fact]
    public async Task An_unavailable_select_reports_no_value_but_keeps_its_options()
    {
        var (provider, _) = NewProvider(SelectsJson);

        var snapshot = await provider.GetSnapshotAsync("litter_robot_4", default);

        Assert.NotNull(snapshot);
        var panel = snapshot.Controls.Selects[LitterRobotSelect.PanelBrightness];
        Assert.Null(panel.Current);
        Assert.Equal(3, panel.Options.Count);
    }

    /// <summary>A robot with no selects reports none — the LR3 shape, and the not-connected shape.</summary>
    [Fact]
    public async Task A_robot_with_no_selects_reports_none()
    {
        var (provider, _) = NewProvider();

        var snapshot = await provider.GetSnapshotAsync("litter_robot_4", default);

        Assert.NotNull(snapshot);
        Assert.Empty(snapshot.Controls.Selects);
        Assert.Null(snapshot.Controls.HopperStatus);
    }

    [Fact]
    public async Task Controls_report_switch_positions_and_the_buttons_that_exist()
    {
        var (provider, _) = NewProvider(ControlsJson);

        var snapshot = await provider.GetSnapshotAsync("litter_robot_4", default);

        Assert.NotNull(snapshot);
        Assert.True(snapshot.Controls.SleepMode);
        Assert.False(snapshot.Controls.NightLight);
        Assert.True(snapshot.Controls.CanResetDrawer);
        // No litter-level button in the payload: not every model has one, and the panel must not offer
        // ADD LITTER on a robot that can't accept it.
        Assert.False(snapshot.Controls.CanAddLitter);
    }

    /// <summary>
    /// The same rule the gauges follow. An <c>unavailable</c> switch reading as "off" would draw a panel
    /// lock that looks disengaged whenever Whisker's cloud hiccups, inviting a press into nothing.
    /// </summary>
    [Fact]
    public async Task An_unavailable_switch_reads_as_unknown_rather_than_off()
    {
        var (provider, _) = NewProvider(ControlsJson);

        var snapshot = await provider.GetSnapshotAsync("litter_robot_4", default);

        Assert.NotNull(snapshot);
        Assert.Null(snapshot.Controls.PanelLock);
    }

    /// <summary>A robot exposing only sensors — the LR3 shape — offers no controls at all.</summary>
    [Fact]
    public async Task A_robot_with_no_control_entities_offers_none()
    {
        var (provider, _) = NewProvider();

        var snapshot = await provider.GetSnapshotAsync("litter_robot_4", default);

        Assert.NotNull(snapshot);
        // Field by field rather than against LitterRobotControls.None: the record now holds a
        // dictionary, and record equality compares that by reference.
        var controls = snapshot.Controls;
        Assert.Null(controls.SleepMode);
        Assert.Null(controls.NightLight);
        Assert.Null(controls.PanelLock);
        Assert.False(controls.CanResetDrawer);
        Assert.False(controls.CanAddLitter);
        Assert.Empty(controls.Selects);
    }

    // ---- history ----

    private static HaState Sample(string entityId, string state, DateTimeOffset at) =>
        new(entityId, state, default, at);

    /// <summary>
    /// Emptying the drawer drops the reading to near zero. Folding that fall into the average would
    /// report a box that fills more slowly the more it is used, so only rises count.
    /// </summary>
    [Fact]
    public void Drawer_fill_rate_counts_rises_and_ignores_the_drop_when_it_is_emptied()
    {
        var day0 = new DateTimeOffset(2026, 7, 20, 12, 0, 0, TimeSpan.Zero);
        var drawer = new List<HaState>
        {
            Sample("d", "10", day0),
            Sample("d", "20", day0.AddDays(1)),
            Sample("d", "30", day0.AddDays(2)),
            Sample("d", "2", day0.AddDays(3)),   // emptied
            Sample("d", "12", day0.AddDays(4)),
        };

        var history = LitterHistoryBuilder.Build(
            "box", 7, day0, day0.AddDays(4), [], drawer, [], []);

        // Rises are 10 + 10 + 10 = 30 over 4 days. The 28-point fall is not a negative fill rate.
        Assert.NotNull(history.DrawerFillPercentPerDay);
        Assert.Equal(7.5, history.DrawerFillPercentPerDay!.Value, 3);
        // From 12%, reaching 90% at 7.5%/day takes 11 days.
        Assert.Equal(11, history.DaysUntilDrawerFull);
    }

    /// <summary>
    /// A day the recorder holds nothing for is unknown, not empty.
    /// </summary>
    /// <remarks>
    /// The same rule as the gauges, and it bites twice here: zeros would draw days of "empty drawer"
    /// that never happened, and the jump from a phantom 0 to the first real reading would be counted
    /// as a rise, inflating the fill rate and shortening the "reaches 90%" estimate.
    /// </remarks>
    [Fact]
    public void Days_with_no_recorded_reading_are_unknown_rather_than_zero()
    {
        var to = new DateTimeOffset(2026, 7, 30, 12, 0, 0, TimeSpan.Zero);
        var from = to.AddDays(-7);
        var drawer = new List<HaState>
        {
            Sample("d", "14", to.AddDays(-1)),
            Sample("d", "17", to),
        };

        var history = LitterHistoryBuilder.Build("box", 7, from, to, [], drawer, [], []);

        var unrecorded = history.Days.Where(d => d.Day < DateOnly.FromDateTime(to.AddDays(-1).LocalDateTime));
        Assert.NotEmpty(unrecorded);
        Assert.All(unrecorded, d =>
        {
            Assert.Null(d.DrawerPercent);
            Assert.Null(d.LitterPercent);
        });

        // Only the one real rise counts: 14 → 17 across a single day.
        Assert.Equal(3, history.DrawerFillPercentPerDay!.Value, 3);
    }

    /// <summary>
    /// Share is weighted by how long each state lasted, not by how many samples it produced — a status
    /// that flickers ten times in a minute is not ten times as important as one that held for a day.
    /// </summary>
    [Fact]
    public void Fault_class_share_is_weighted_by_duration_not_by_sample_count()
    {
        var start = new DateTimeOffset(2026, 7, 20, 0, 0, 0, TimeSpan.Zero);
        var end = start.AddHours(10);
        var status = new List<HaState>
        {
            Sample("s", "rdy", start),                          // 9 hours stable
            Sample("s", "cd", start.AddHours(9)),               // 4 rapid samples in the last hour
            Sample("s", "rdy", start.AddHours(9).AddMinutes(20)),
            Sample("s", "cd", start.AddHours(9).AddMinutes(40)),
            Sample("s", "rdy", start.AddHours(9).AddMinutes(50)),
        };

        var history = LitterHistoryBuilder.Build("box", 1, start, end, status, [], [], []);

        // Stable holds 9h + 20m + 10m = 9h30m of 10h; cat present holds 30m.
        Assert.Equal(0.95, history.ClassShare["Stable"], 2);
        Assert.Equal(0.05, history.ClassShare["CatPresent"], 2);
    }

    /// <summary>
    /// Home Assistant publishes no cycle counter, but every cycle passes through <c>ccp</c>, so the
    /// status history counts them. Consecutive <c>ccp</c> samples are one cycle still running, not
    /// several — the robot re-reports the same state while the globe turns.
    /// </summary>
    [Fact]
    public void Cycles_are_counted_from_entries_into_the_cycling_state()
    {
        var start = new DateTimeOffset(2026, 7, 28, 0, 0, 0, TimeSpan.Zero);
        var to = start.AddDays(2);
        var status = new List<HaState>
        {
            Sample("s", "rdy", start),
            Sample("s", "ccp", start.AddHours(2)),      // cycle 1
            Sample("s", "ccp", start.AddHours(2).AddMinutes(1)),  // same cycle, still running
            Sample("s", "ccc", start.AddHours(2).AddMinutes(3)),
            Sample("s", "rdy", start.AddHours(3)),
            Sample("s", "cd", start.AddHours(8)),
            Sample("s", "ccp", start.AddHours(9)),      // cycle 2
            Sample("s", "rdy", start.AddHours(9).AddMinutes(4)),
        };

        var history = LitterHistoryBuilder.Build("box", 7, start, to, status, [], [], []);

        Assert.Equal(2, history.CyclesObserved);
        Assert.Equal(1, history.CyclesPerDay!.Value, 2);
    }

    /// <summary>
    /// The rate divides by the window the recorder covered, not the one that was asked for. Dividing
    /// two cycles by 90 days when only one day was recorded reports a robot that never runs.
    /// </summary>
    [Fact]
    public void Cycle_rate_uses_the_covered_window_not_the_requested_one()
    {
        var to = new DateTimeOffset(2026, 7, 30, 12, 0, 0, TimeSpan.Zero);
        var from = to.AddDays(-90);
        var status = new List<HaState>
        {
            Sample("s", "rdy", to.AddDays(-2)),
            Sample("s", "ccp", to.AddDays(-2).AddHours(1)),
            Sample("s", "rdy", to.AddDays(-1)),
            Sample("s", "ccp", to.AddHours(-6)),
        };

        var history = LitterHistoryBuilder.Build("box", 90, from, to, status, [], [], []);

        Assert.Equal(2, history.CyclesObserved);
        // Two cycles across the two days actually held, not across 90.
        Assert.Equal(1, history.CyclesPerDay!.Value, 1);
    }

    /// <summary>
    /// The recorder purges — by default at 10 days. A 90-day request that comes back holding a week
    /// must say so, or the panel draws a partial series as though it were the whole story.
    /// </summary>
    [Fact]
    public void A_window_the_recorder_could_not_cover_is_reported_as_incomplete()
    {
        var to = new DateTimeOffset(2026, 7, 30, 12, 0, 0, TimeSpan.Zero);
        var from = to.AddDays(-90);
        var drawer = new List<HaState> { Sample("d", "17", to.AddDays(-6)) };

        var history = LitterHistoryBuilder.Build("box", 90, from, to, [], drawer, [], []);

        Assert.False(history.Complete);
        Assert.Equal(to.AddDays(-6), history.OldestSampleUtc);
    }

    [Fact]
    public void A_window_the_recorder_covers_is_reported_as_complete()
    {
        var to = new DateTimeOffset(2026, 7, 30, 12, 0, 0, TimeSpan.Zero);
        var from = to.AddDays(-7);
        var drawer = new List<HaState>
        {
            Sample("d", "10", from.AddMinutes(5)),
            Sample("d", "17", to.AddHours(-1)),
        };

        var history = LitterHistoryBuilder.Build("box", 7, from, to, [], drawer, [], []);

        Assert.True(history.Complete);
    }

    // ---- the event log ----

    /// <summary>
    /// Home Assistant reports where the robot is, never how it got there, so the log is built from
    /// transitions. A state the recorder re-published without it changing is the same event, not a
    /// second one — otherwise a cat that sat in the box through four polls visits four times.
    /// </summary>
    [Fact]
    public void Events_are_transitions_not_samples()
    {
        var start = new DateTimeOffset(2026, 7, 30, 8, 0, 0, TimeSpan.Zero);
        var status = new List<HaState>
        {
            Sample("s", "rdy", start),
            Sample("s", "cd", start.AddMinutes(10)),
            Sample("s", "cd", start.AddMinutes(11)),
            Sample("s", "cd", start.AddMinutes(12)),
            Sample("s", "ccp", start.AddMinutes(15)),
            Sample("s", "rdy", start.AddMinutes(17)),
        };

        var history = LitterHistoryBuilder.Build("box", 1, start, start.AddHours(4), status, [], [], []);

        Assert.Equal(
            [LitterEventKinds.CycleComplete, LitterEventKinds.CatVisit],
            history.Events.Select(e => e.Kind));
        // Newest first — the panel shows the top five and never re-sorts them.
        Assert.Equal(start.AddMinutes(17), history.Events[0].AtUtc);
    }

    /// <summary>
    /// A cycle counts as finished when the robot says so (<c>ccc</c>) or when it leaves a running
    /// cycle for a usable state. Both must not fire for one cycle: `ccp → ccc → rdy` is one
    /// completion, not two.
    /// </summary>
    [Fact]
    public void A_cycle_that_reports_complete_and_then_ready_is_one_event()
    {
        var start = new DateTimeOffset(2026, 7, 30, 8, 0, 0, TimeSpan.Zero);
        var status = new List<HaState>
        {
            Sample("s", "ccp", start),
            Sample("s", "ccc", start.AddMinutes(2)),
            Sample("s", "rdy", start.AddMinutes(3)),
        };

        var history = LitterHistoryBuilder.Build("box", 1, start, start.AddHours(1), status, [], [], []);

        Assert.Single(history.Events);
        Assert.Equal(LitterEventKinds.CycleComplete, history.Events[0].Kind);
    }

    /// <summary>
    /// A recoverable fault that went away on its own is only visible on the way *out* of it, and it
    /// carries pylitterbot's own text for the code it left — the household reads the same words in
    /// the Whisker app.
    /// </summary>
    [Fact]
    public void A_fault_that_clears_itself_is_reported_against_the_code_it_left()
    {
        var start = new DateTimeOffset(2026, 7, 30, 8, 0, 0, TimeSpan.Zero);
        var status = new List<HaState>
        {
            Sample("s", "rdy", start),
            Sample("s", "cst", start.AddMinutes(5)),
            Sample("s", "rdy", start.AddMinutes(9)),
        };

        var history = LitterHistoryBuilder.Build("box", 1, start, start.AddHours(1), status, [], [], []);

        var cleared = history.Events.Single(e => e.Kind == LitterEventKinds.ClearedItself);
        Assert.Equal("cst", cleared.StatusCode);
        Assert.Equal("Cat Sensor Timing", cleared.StatusText);
    }

    /// <summary>
    /// A fault already in progress when the window opened did not clear <em>itself</em> as far as the
    /// panel can tell — it may well have been fixed by hand. The doc comment on <c>Events</c> states
    /// this rule; the code did not follow it, so the first sample was treated like an observed
    /// arrival and its exit produced a "cleared itself" row.
    /// </summary>
    [Fact]
    public void A_fault_carried_into_the_window_is_not_reported_as_self_clearing()
    {
        var windowStart = new DateTimeOffset(2026, 7, 30, 8, 0, 0, TimeSpan.Zero);
        var status = new List<HaState>
        {
            // The recorder's first sample is the state as it stood at the window edge, stamped with
            // the real (earlier) transition — here, a fault that began the previous evening.
            Sample("s", "cst", windowStart.AddHours(-14)),
            Sample("s", "rdy", windowStart.AddMinutes(20)),
        };

        var history = LitterHistoryBuilder.Build("box", 1, windowStart, windowStart.AddHours(1), status, [], [], []);

        Assert.DoesNotContain(history.Events, e => e.Kind == LitterEventKinds.ClearedItself);
    }

    /// <summary>
    /// The scale weighs whoever is in the box, one reading per visit. A zero is not a weighing — it
    /// is the sensor with nothing on it, and a row saying the cat weighed 0 lb is worse than no row.
    /// </summary>
    [Fact]
    public void Weight_events_carry_the_reading_and_skip_empty_ones()
    {
        var start = new DateTimeOffset(2026, 7, 30, 8, 0, 0, TimeSpan.Zero);
        var weights = new List<HaState>
        {
            Sample("w", "6.5", start.AddMinutes(4)),
            Sample("w", "0", start.AddMinutes(6)),
            Sample("w", "unavailable", start.AddMinutes(8)),
        };

        var history = LitterHistoryBuilder.Build("box", 1, start, start.AddHours(1), [], [], [], weights);

        var weight = Assert.Single(history.Events);
        Assert.Equal(LitterEventKinds.Weight, weight.Kind);
        Assert.Equal(6.5, weight.Value!.Value, 2);
    }

    // ---- backoff ----

    [Fact]
    public void Backoff_schedule_holds_the_last_value_for_later_attempts()
    {
        var options = new RecoveryOptions { BackoffMinutes = { } };
        options.BackoffMinutes.Clear();
        options.BackoffMinutes.AddRange([5, 15]);

        Assert.Equal(TimeSpan.Zero, options.BackoffFor(1));
        Assert.Equal(TimeSpan.FromMinutes(5), options.BackoffFor(2));
        Assert.Equal(TimeSpan.FromMinutes(15), options.BackoffFor(3));
        Assert.Equal(TimeSpan.FromMinutes(15), options.BackoffFor(9));
    }
}
