namespace HomeHub.Tests;

using HomeHub.Api.Alerts;
using HomeHub.Api.Cats;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

/// <summary>
/// The recovery ladder: which commands get sent, in what order, and — the part that actually protects
/// the cat — how the outcome is decided.
/// </summary>
/// <remarks>
/// The Litter-Robot accepts commands it then silently drops; a clean cycle requested while a cat is
/// detected returns success and does nothing. So "the call didn't throw" proves nothing, and these tests
/// exist to keep the runner honest about that: recovery is only ever reported when the status is
/// observed to become usable.
/// </remarks>
public class LitterRobotRecoveryTests
{
    private sealed class FakeTime : TimeProvider
    {
        private DateTimeOffset _now = new(2026, 7, 29, 3, 0, 0, TimeSpan.Zero);
        public override DateTimeOffset GetUtcNow() => _now;
        public void Advance(TimeSpan by) => _now += by;
    }

    /// <summary>
    /// A robot whose status only changes when a command it "responds to" arrives. Commands not listed in
    /// <see cref="ClearsTo"/> are accepted and ignored — modelling the real silent-refusal behaviour.
    /// </summary>
    private sealed class FakeRobot : ILitterRobotProvider, ILitterRobotCommands
    {
        public string Code { get; set; } = "rdy";
        public double? LitterPercent { get; set; } = 80;
        public List<RecoveryStep> Sent { get; } = [];
        public Dictionary<RecoveryStep, string> ClearsTo { get; } = [];
        public HashSet<RecoveryStep> Supported { get; } = [RecoveryStep.Reset, RecoveryStep.CleanCycle];

        public bool IsConfigured => true;

        public Task<CatHealth> GetHealthAsync(CancellationToken ct) =>
            Task.FromResult(new CatHealth(CatIntegrationStatus.Ok, null, null));

        public Task<IReadOnlyList<LitterRobotDescriptor>> GetRobotsAsync(CancellationToken ct) =>
            Task.FromResult<IReadOnlyList<LitterRobotDescriptor>>([new("box", "Box")]);

        public Task<LitterRobotSnapshot?> GetSnapshotAsync(string slug, CancellationToken ct) =>
            Task.FromResult<LitterRobotSnapshot?>(Snapshot());

        public Task<IReadOnlyList<LitterRobotSnapshot>> GetFreshSnapshotsAsync(CancellationToken ct) =>
            Task.FromResult<IReadOnlyList<LitterRobotSnapshot>>([Snapshot()]);

        // History is a panel concern; the recovery loop never asks for it.
        public Task<LitterRobotHistory?> GetHistoryAsync(string slug, int days, CancellationToken ct) =>
            Task.FromResult<LitterRobotHistory?>(null);

        private LitterRobotSnapshot Snapshot() => new(
            "box", "Box", LitterRobotFaults.Classify(Code),
            WasteDrawerPercent: 20, LitterPercent: LitterPercent, PetWeightLbs: null,
            TotalCycles: 100, LastSeenUtc: null,
            FetchedUtc: new DateTimeOffset(2026, 7, 29, 3, 0, 0, TimeSpan.Zero), Stale: false);

        public bool Supports(RecoveryStep step) => Supported.Contains(step);

        private Task Send(RecoveryStep step)
        {
            Sent.Add(step);
            if (ClearsTo.TryGetValue(step, out var next)) Code = next;
            return Task.CompletedTask;
        }

        public Task ResetAsync(string slug, CancellationToken ct) => Send(RecoveryStep.Reset);
        public Task StartCleanCycleAsync(string slug, CancellationToken ct) => Send(RecoveryStep.CleanCycle);
        public Task ShortResetAsync(string slug, CancellationToken ct) => Send(RecoveryStep.ShortReset);
        public Task PowerCycleAsync(string slug, CancellationToken ct) => Send(RecoveryStep.PowerCycle);

        // Maintenance commands are not rungs of the ladder — the recovery loop never sends them, and a
        // test that saw one would be describing a bug.
        public List<string> Maintenance { get; } = [];
        public Task ResetWasteDrawerAsync(string slug, CancellationToken ct) => Note("drawer");
        public Task ResetLitterLevelAsync(string slug, CancellationToken ct) => Note("litter");
        public Task SetSwitchAsync(string slug, LitterRobotSwitch which, bool on, CancellationToken ct) =>
            Note($"{which}:{(on ? "on" : "off")}");
        public Task SetSelectAsync(string slug, LitterRobotSelect which, string option, CancellationToken ct) =>
            Note($"{which}:{option}");

        private Task Note(string what)
        {
            Maintenance.Add(what);
            return Task.CompletedTask;
        }
    }

    /// <summary>No DbContext: the runner must still work on a shell with no database configured.</summary>
    private sealed class EmptyServices : IServiceProvider
    {
        public object? GetService(Type serviceType) => null;
    }

    private static LitterRobotRecoveryRunner NewRunner(FakeRobot robot)
    {
        // Zero settle windows keep the tests instant; the polling path is exercised by the settle logic
        // taking a single immediate reading.
        var options = new CatOptions
        {
            Recovery = new RecoveryOptions { ResetSettleSeconds = 0, CycleSettleSeconds = 0 },
        };

        return new LitterRobotRecoveryRunner(
            robot,
            robot,
            Options.Create(options),
            new EmptyServices(),
            NullLogger<LitterRobotRecoveryRunner>.Instance,
            new FakeTime());
    }

    // ---- the happy paths ----

    [Fact]
    public async Task A_reset_that_clears_the_fault_stops_before_the_clean_cycle()
    {
        var robot = new FakeRobot { Code = "hpf" };
        robot.ClearsTo[RecoveryStep.Reset] = "rdy";

        var result = await NewRunner(robot).AttemptAsync("box", 1, manual: false, default);

        Assert.True(result.Recovered);
        Assert.Equal(RecoveryStep.Reset, result.Step);
        Assert.Equal([RecoveryStep.Reset], robot.Sent);
    }

    [Fact]
    public async Task A_reset_that_does_not_help_escalates_to_a_clean_cycle()
    {
        var robot = new FakeRobot { Code = "p" };
        robot.ClearsTo[RecoveryStep.CleanCycle] = "ccp";

        var result = await NewRunner(robot).AttemptAsync("box", 1, manual: false, default);

        Assert.True(result.Recovered);
        Assert.Equal(RecoveryStep.CleanCycle, result.Step);
        Assert.Equal([RecoveryStep.Reset, RecoveryStep.CleanCycle], robot.Sent);
        // A cycle in progress is a recovered box, not a still-faulted one.
        Assert.Equal("ccp", result.ResultingCode);
    }

    /// <summary>
    /// The central guarantee. Both commands are accepted, neither changes anything, and the runner must
    /// say so rather than reporting the success the HTTP layer saw.
    /// </summary>
    [Fact]
    public async Task Commands_accepted_but_ignored_report_failure_not_success()
    {
        var robot = new FakeRobot { Code = "hpf" };

        var result = await NewRunner(robot).AttemptAsync("box", 1, manual: false, default);

        Assert.False(result.Recovered);
        Assert.Equal(RecoveryOutcome.Failed, result.Outcome);
        Assert.Equal("hpf", result.ResultingCode);
        Assert.Equal([RecoveryStep.Reset, RecoveryStep.CleanCycle], robot.Sent);
    }

    // ---- the safety gate ----

    /// <summary>A reset re-homes the globe. Nothing may command it while the cat is in there.</summary>
    [Fact]
    public async Task No_command_is_sent_while_a_cat_is_detected()
    {
        var robot = new FakeRobot { Code = "cd" };

        var result = await NewRunner(robot).AttemptAsync("box", 1, manual: false, default);

        Assert.Equal(RecoveryOutcome.Aborted, result.Outcome);
        Assert.Empty(robot.Sent);
    }

    /// <summary>The gate is not a policy the panel can override — a manual press is refused too.</summary>
    [Fact]
    public async Task A_manual_request_cannot_override_the_cat_gate()
    {
        var robot = new FakeRobot { Code = "cd" };

        var result = await NewRunner(robot).AttemptAsync("box", 1, manual: true, default);

        Assert.Equal(RecoveryOutcome.Aborted, result.Outcome);
        Assert.Empty(robot.Sent);
    }

    [Fact]
    public async Task A_cat_arriving_mid_recovery_stops_the_ladder()
    {
        var robot = new FakeRobot { Code = "hpf" };
        robot.ClearsTo[RecoveryStep.Reset] = "cd";

        var result = await NewRunner(robot).AttemptAsync("box", 1, manual: false, default);

        Assert.Equal(RecoveryOutcome.Aborted, result.Outcome);
        Assert.Equal([RecoveryStep.Reset], robot.Sent);
        Assert.DoesNotContain(RecoveryStep.CleanCycle, robot.Sent);
    }

    // ---- faults that must not be retried ----

    [Theory]
    [InlineData("dfs")]
    [InlineData("sdf")]
    [InlineData("br")]
    public async Task Physical_faults_send_no_commands(string code)
    {
        var robot = new FakeRobot { Code = code };

        var result = await NewRunner(robot).AttemptAsync("box", 1, manual: false, default);

        Assert.Equal(RecoveryOutcome.Aborted, result.Outcome);
        Assert.Empty(robot.Sent);
        Assert.Contains("physical intervention", result.Detail);
    }

    [Theory]
    [InlineData("off")]
    [InlineData("offline")]
    public async Task An_unreachable_robot_is_not_commanded(string code)
    {
        var robot = new FakeRobot { Code = code };

        var result = await NewRunner(robot).AttemptAsync("box", 1, manual: false, default);

        Assert.Equal(RecoveryOutcome.Aborted, result.Outcome);
        Assert.Empty(robot.Sent);
    }

    [Fact]
    public async Task An_automatic_attempt_aborts_when_the_fault_cleared_first()
    {
        var robot = new FakeRobot { Code = "rdy" };

        var result = await NewRunner(robot).AttemptAsync("box", 1, manual: false, default);

        Assert.Equal(RecoveryOutcome.Aborted, result.Outcome);
        Assert.Empty(robot.Sent);
    }

    // ---- manual ----

    /// <summary>"Cycle now" on a healthy box is a legitimate request, and needs no reset.</summary>
    [Fact]
    public async Task A_manual_cycle_on_a_ready_robot_skips_the_reset()
    {
        var robot = new FakeRobot { Code = "rdy" };
        robot.ClearsTo[RecoveryStep.CleanCycle] = "ccp";

        var result = await NewRunner(robot).AttemptAsync("box", 1, manual: true, default);

        Assert.True(result.Recovered);
        Assert.Equal([RecoveryStep.CleanCycle], robot.Sent);
    }

    // ---- ladder composition ----

    /// <summary>
    /// With a command provider that can reach them, the gentler short reset goes first — the reason the
    /// command seam is separate from the read provider.
    /// </summary>
    [Fact]
    public async Task A_provider_that_supports_a_short_reset_tries_it_first()
    {
        var robot = new FakeRobot { Code = "hpf" };
        robot.Supported.Add(RecoveryStep.ShortReset);
        robot.ClearsTo[RecoveryStep.ShortReset] = "rdy";

        var result = await NewRunner(robot).AttemptAsync("box", 1, manual: false, default);

        Assert.True(result.Recovered);
        Assert.Equal([RecoveryStep.ShortReset], robot.Sent);
    }

    /// <summary>Power cycling is the harshest rung, so the first attempt never reaches for it.</summary>
    [Fact]
    public async Task Power_cycling_is_held_back_until_the_gentler_rungs_have_failed()
    {
        var robot = new FakeRobot { Code = "hpf" };
        robot.Supported.Add(RecoveryStep.PowerCycle);

        var first = await NewRunner(robot).AttemptAsync("box", 1, manual: false, default);
        Assert.False(first.Recovered);
        Assert.DoesNotContain(RecoveryStep.PowerCycle, robot.Sent);

        robot.Sent.Clear();
        var second = await NewRunner(robot).AttemptAsync("box", 2, manual: false, default);
        Assert.False(second.Recovered);
        Assert.Contains(RecoveryStep.PowerCycle, robot.Sent);
    }

    [Fact]
    public async Task A_provider_with_no_reachable_command_errors_rather_than_claiming_success()
    {
        var robot = new FakeRobot { Code = "hpf" };
        robot.Supported.Clear();

        var result = await NewRunner(robot).AttemptAsync("box", 1, manual: false, default);

        Assert.Equal(RecoveryOutcome.Errored, result.Outcome);
        Assert.Empty(robot.Sent);
    }

    // ---- episode bookkeeping ----

    /// <summary>
    /// Counters survive a recovery until the robot has been stable for the confirm window, so a box that
    /// clears and immediately re-faults keeps spending the same episode's budget instead of resetting it
    /// and looping all night.
    /// </summary>
    [Fact]
    public void An_episode_only_closes_after_a_sustained_stable_period()
    {
        var tracker = new RecoveryTracker();
        var start = new DateTimeOffset(2026, 7, 29, 3, 0, 0, TimeSpan.Zero);
        var confirm = TimeSpan.FromMinutes(5);
        var options = new RecoveryOptions();

        tracker.NoteFault("box", "hpf", start);
        tracker.NoteAttempt("box", start, options);

        // Recovered, but not yet proven stable.
        Assert.False(tracker.NoteStable("box", start.AddMinutes(1), confirm));
        Assert.Equal(1, tracker.Read("box").Attempts);

        // Re-faults inside the window: same episode, budget already spent.
        tracker.NoteFault("box", "hpf", start.AddMinutes(2));
        Assert.Equal(1, tracker.Read("box").Attempts);

        // Now genuinely stable for long enough.
        Assert.False(tracker.NoteStable("box", start.AddMinutes(3), confirm));
        Assert.True(tracker.NoteStable("box", start.AddMinutes(9), confirm));
        Assert.Equal(0, tracker.Read("box").Attempts);
    }

    /// <summary>A different fault code mid-episode is the same problem, not a fresh attempt budget.</summary>
    [Fact]
    public void A_changed_fault_code_keeps_the_episode_and_its_counters()
    {
        var tracker = new RecoveryTracker();
        var start = new DateTimeOffset(2026, 7, 29, 3, 0, 0, TimeSpan.Zero);

        tracker.NoteFault("box", "p", start);
        tracker.NoteAttempt("box", start, new RecoveryOptions());
        tracker.NoteFault("box", "hpf", start.AddSeconds(30));

        var state = tracker.Read("box");
        Assert.Equal(1, state.Attempts);
        Assert.Equal(start, state.FaultSince);
    }

    [Fact]
    public void Backoff_is_scheduled_from_the_attempt_that_just_happened()
    {
        var tracker = new RecoveryTracker();
        var now = new DateTimeOffset(2026, 7, 29, 3, 0, 0, TimeSpan.Zero);
        var options = new RecoveryOptions();
        options.BackoffMinutes.Clear();
        options.BackoffMinutes.AddRange([5, 15]);

        tracker.NoteFault("box", "hpf", now);
        tracker.NoteAttempt("box", now, options);

        Assert.Equal(now.AddMinutes(5), tracker.Read("box").NextDue);

        tracker.NoteAttempt("box", now.AddMinutes(5), options);
        Assert.Equal(now.AddMinutes(20), tracker.Read("box").NextDue);
    }

    // ---- pausing from the panel ----

    /// <summary>
    /// The panel's "leave it alone". It reports as disabled through the same flag the configured master
    /// switch uses, so the UI reads one value rather than reconciling two.
    /// </summary>
    [Fact]
    public void Pausing_from_the_panel_reports_recovery_as_disabled()
    {
        var tracker = new RecoveryTracker();

        Assert.True(tracker.Snapshot("box", enabled: true, attemptsToday: 0).Enabled);

        tracker.SetPaused("box", true);

        var state = tracker.Snapshot("box", enabled: true, attemptsToday: 0);
        Assert.False(state.Enabled);
        Assert.Equal("Paused from the panel", state.HoldReason);
        Assert.True(tracker.IsPaused("box"));

        tracker.SetPaused("box", false);
        Assert.True(tracker.Snapshot("box", enabled: true, attemptsToday: 0).Enabled);
        Assert.Null(tracker.Snapshot("box", enabled: true, attemptsToday: 0).HoldReason);
    }

    /// <summary>
    /// Pausing means paused until someone resumes it — not until the box next looks fine. A pause that
    /// evaporated when the episode closed would quietly re-arm the loop on the same robot the household
    /// had just told it to leave.
    /// </summary>
    [Fact]
    public void A_pause_survives_the_episode_closing()
    {
        var tracker = new RecoveryTracker();
        var now = new DateTimeOffset(2026, 7, 29, 3, 0, 0, TimeSpan.Zero);

        tracker.NoteFault("box", "hpf", now);
        tracker.SetPaused("box", true);

        Assert.True(tracker.NoteStable("box", now.AddMinutes(10), TimeSpan.Zero));

        Assert.True(tracker.IsPaused("box"));
        var state = tracker.Snapshot("box", enabled: true, attemptsToday: 0);
        Assert.False(state.Enabled);
        // And it still says *why*. NoteStable used to clear HoldReason unconditionally, so the first
        // usable reading left the panel reporting auto-recovery off with no explanation beside it —
        // the pause intact but invisible, which reads as the panel having decided on its own.
        Assert.Equal("Paused from the panel", state.HoldReason);
    }

    /// <summary>The configured master switch still wins — resuming a robot can't switch the section on.</summary>
    [Fact]
    public void Resuming_cannot_override_the_configured_master_switch()
    {
        var tracker = new RecoveryTracker();
        tracker.SetPaused("box", false);

        Assert.False(tracker.Snapshot("box", enabled: false, attemptsToday: 0).Enabled);
    }

    // ---- The change-the-litter alert ----

    private static LitterRobotSnapshot Drawer(double? percent, string code = "rdy") => new(
        "box", "Box", LitterRobotFaults.Classify(code),
        WasteDrawerPercent: percent, LitterPercent: 60, PetWeightLbs: null,
        TotalCycles: 100, LastSeenUtc: null,
        FetchedUtc: new DateTimeOffset(2026, 7, 29, 3, 0, 0, TimeSpan.Zero), Stale: false);

    [Theory]
    [InlineData(79, 80, false)]  // just under — silent
    [InlineData(80, 80, true)]   // exactly at the threshold counts as reaching it
    [InlineData(95, 80, true)]
    [InlineData(55, 50, true)]   // the household's own number is what is honoured, not a constant
    [InlineData(45, 50, false)]
    public void The_drawer_alert_follows_the_configured_threshold(double percent, int threshold, bool expected)
    {
        var alert = LitterRobotRecoveryService.DrawerAlert(Drawer(percent), threshold);

        Assert.Equal(expected, alert is not null);
        if (expected)
        {
            // Warning, not Severe: the box still cycles. Severe is reserved for it refusing to.
            Assert.Equal(AlertSeverity.Warning, alert!.Severity);
            Assert.Contains("change the litter", alert.Message, StringComparison.OrdinalIgnoreCase);
        }
    }

    /// <summary>
    /// The LR3 cannot measure its drawer at all. A missing reading is not a low one, and inventing
    /// either answer would be worse than staying quiet.
    /// </summary>
    [Fact]
    public void A_robot_that_cannot_measure_its_drawer_raises_nothing()
    {
        Assert.Null(LitterRobotRecoveryService.DrawerAlert(Drawer(null), 80));
    }

    /// <summary>
    /// Once the robot reports drawer-full itself, that fault raises its own Severe alert. Two banners
    /// about one drawer is one too many, and the quieter of the two is the one to drop.
    /// </summary>
    [Theory]
    [InlineData("dfs")]
    [InlineData("sdf")]
    public void The_robots_own_drawer_full_fault_suppresses_this_one(string code)
    {
        Assert.Null(LitterRobotRecoveryService.DrawerAlert(Drawer(100, code), 80));
    }

    /// <summary>
    /// Distinct from the fault alert's key, so both can be open at once — a robot can be jammed *and*
    /// have a full drawer, and collapsing them would lose one.
    /// </summary>
    [Fact]
    public void The_drawer_alert_has_its_own_dedupe_key()
    {
        var alert = LitterRobotRecoveryService.DrawerAlert(Drawer(90), 80);

        Assert.Equal("litterrobot:box:drawer_full", alert!.DedupeKey);
        // Source drives where the dashboard banner navigates.
        Assert.Equal("cat:box", alert.Source);
    }
}
