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

        var ha = new HomeAssistantClient(new HttpClient(handler), Options.Create(new HomeAssistantOptions
        {
            BaseUrl = "http://ha.test:8123",
            Token = "test-token",
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
