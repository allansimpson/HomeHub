namespace HomeHub.Api.Cats;

using HomeHub.Api.Alerts;
using HomeHub.Api.Data;
using HomeHub.Api.Notifications;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

/// <summary>
/// Watches every Litter-Robot and clears the lock-in faults — <c>p</c> (clean cycle paused) and
/// <c>hpf</c> (home position fault) chiefly — that leave the globe parked where the cat can't use it.
/// Escalates to a person when it can't.
/// </summary>
/// <remarks>
/// The intent is a box that is never left unusable overnight, without becoming a machine that grinds a
/// failing motor. Four brakes do that work:
/// <list type="number">
/// <item><b>Debounce</b> — the LR4 reports odd codes transiently mid-cycle; most clear themselves.</item>
/// <item><b>Cat gate</b> — enforced in <see cref="LitterRobotRecoveryRunner"/>, so no path skips it.</item>
/// <item><b>Per-episode cap</b>, with tighter per-code ceilings for the mechanical faults
/// (<c>otf</c>, <c>pd</c>) where a repeat means an obstruction rather than a glitch.</item>
/// <item><b>Rolling 24h cap</b>, counted from persisted rows so a restart can't reset it. This is the
/// one that matters most: a robot that faults, recovers and re-faults every twenty minutes would
/// otherwise run hundreds of motor cycles overnight while looking healthy on the panel.</item>
/// </list>
/// Every brake that stops the loop raises an alert instead, because "we stopped trying" is exactly the
/// state a person needs to be told about.
/// </remarks>
public sealed class LitterRobotRecoveryService : BackgroundService
{
    /// <summary>Alert type for everything this service raises; shares the store and banner with sensors and weather.</summary>
    public const string AlertType = "cat";

    private readonly IServiceScopeFactory _scopeFactory;
    private readonly RecoveryTracker _tracker;
    private readonly CatOptions _options;
    private readonly ILogger<LitterRobotRecoveryService> _logger;
    private readonly TimeProvider _time;

    public LitterRobotRecoveryService(
        IServiceScopeFactory scopeFactory,
        RecoveryTracker tracker,
        IOptions<CatOptions> options,
        ILogger<LitterRobotRecoveryService> logger,
        TimeProvider time)
    {
        _scopeFactory = scopeFactory;
        _tracker = tracker;
        _options = options.Value;
        _logger = logger;
        _time = time;
    }

    private RecoveryOptions Recovery => _options.Recovery;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var pollSeconds = Math.Max(10, Recovery.PollSeconds);
        _logger.LogInformation(
            "Litter-Robot watcher started; interval {Seconds}s, auto-recovery {State}.",
            pollSeconds, Recovery.Enabled ? "enabled" : "disabled (observe and alert only)");

        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(pollSeconds));
        do
        {
            try
            {
                await EvaluateOnceAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                // Transient HA/DB failure — log and keep the panel alive; retry next tick.
                _logger.LogError(ex, "Litter-Robot evaluation failed; will retry.");
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    /// <summary>
    /// One evaluation pass over every robot. Internal so tests can drive a single deterministic tick
    /// instead of waiting on the timer.
    /// </summary>
    internal async Task EvaluateOnceAsync(CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        var provider = scope.ServiceProvider.GetRequiredService<ILitterRobotProvider>();
        var runner = scope.ServiceProvider.GetRequiredService<LitterRobotRecoveryRunner>();
        var db = scope.ServiceProvider.GetService<HomeHubDbContext>();
        var engine = scope.ServiceProvider.GetService<AlertEngine>();

        if (!provider.IsConfigured) return;

        var snapshots = await provider.GetFreshSnapshotsAsync(ct);
        if (snapshots.Count == 0) return;

        var now = _time.GetUtcNow();
        var alerts = new List<ExternalAlert>();

        // The household's threshold, read per pass so a change in Config takes effect on the next
        // tick instead of at the next restart. Falls back to the default when there is no database.
        var fullPercent = db is null
            ? DefaultLitterFullPercent
            : (await db.Settings.Where(s => s.Id == 1).Select(s => (int?)s.LitterFullPercent).FirstOrDefaultAsync(ct))
              ?? DefaultLitterFullPercent;

        foreach (var snapshot in snapshots)
        {
            var alert = await EvaluateRobotAsync(snapshot, runner, db, now, ct);
            if (alert is not null) alerts.Add(alert);

            // Evaluated separately from the fault switch above, and added alongside rather than
            // instead of it. A robot can be perfectly Ready and still have a drawer that needs
            // emptying — folding this into the fault classification would mean a healthy box never
            // reports a full drawer, which is precisely the case this exists for.
            var drawer = DrawerAlert(snapshot, fullPercent);
            if (drawer is not null) alerts.Add(drawer);
        }

        // Reconcile the whole set in one call so alerts for robots that recovered are cleared as a
        // side effect of no longer being in the list.
        if (db is not null && engine is not null)
        {
            var raised = await engine.ReconcileAsync(db, AlertType, alerts, now.UtcDateTime, ct);

            // Only the transitions notify. The auto-recovery subsystem retries silently, so a
            // notification means something changed that the panel could not fix by itself — not that
            // a fault is still sitting there, which the Litter screen already says plainly.
            var notifications = scope.ServiceProvider.GetService<NotificationService>();
            if (notifications is not null)
            {
                foreach (var alert in raised)
                {
                    await notifications.RecordAsync(
                        NotificationSources.Litter,
                        "Litter Robot",
                        alert.Severity >= AlertSeverity.Warning
                            ? NotificationSeverities.WantsYou
                            : NotificationSeverities.WorthKnowing,
                        alert.Severity >= AlertSeverity.Warning ? "terracotta" : "verdigris",
                        alert.Message,
                        $"cat:{alert.DedupeKey}:{now.UtcDateTime:O}",
                        now.UtcDateTime,
                        // `/care`, since the consolidation: the robot is a subject of the Care
                        // section rather than a tab, and `?subject=` names which one.
                        route: "/care?subject=mika",
                        ct: ct);
                }
            }
        }
    }

    /// <summary>
    /// Decide what to do about one robot, and return the alert it should be raising (null for none).
    /// </summary>
    private async Task<ExternalAlert?> EvaluateRobotAsync(
        LitterRobotSnapshot snapshot,
        LitterRobotRecoveryRunner runner,
        HomeHubDbContext? db,
        DateTimeOffset now,
        CancellationToken ct)
    {
        var slug = snapshot.Slug;
        var fault = snapshot.Fault;

        switch (fault.Class)
        {
            case LitterRobotFaultClass.Stable:
            case LitterRobotFaultClass.Transient:
                if (_tracker.NoteStable(slug, now, TimeSpan.FromSeconds(Math.Max(0, Recovery.StableConfirmSeconds))))
                    _logger.LogInformation("Litter-Robot {Slug} is stable again; recovery episode closed.", slug);
                return null;

            case LitterRobotFaultClass.CatPresent:
                _tracker.NoteCat(slug, now);
                return null;

            case LitterRobotFaultClass.Offline:
                _tracker.SetHold(slug, fault.Text);
                return Alert(snapshot, "offline", AlertSeverity.Warning,
                    $"{snapshot.Name}: {fault.Text.ToLowerInvariant()} — no commands can reach it.");

            case LitterRobotFaultClass.NeedsHuman:
                _tracker.SetHold(slug, fault.Text);
                // Drawer-full is severe: the robot refuses to cycle, so the box is about to be unusable.
                var severity = fault.Code is "dfs" or "sdf" ? AlertSeverity.Severe : AlertSeverity.Warning;
                return Alert(snapshot, "needs_human", severity,
                    $"{snapshot.Name}: {fault.Text} — needs you, not a reset.");

            case LitterRobotFaultClass.Unknown:
                // Never act on a code we don't understand; a firmware update that adds one must not make
                // the loop start resetting on it.
                _logger.LogInformation(
                    "Litter-Robot {Slug} reports unrecognised status '{Code}'; observing only.", slug, fault.Code);
                _tracker.SetHold(slug, $"Unrecognised status '{fault.Code}'");
                return null;

            case LitterRobotFaultClass.Recoverable:
                return await EvaluateRecoverableAsync(snapshot, runner, db, now, ct);

            default:
                return null;
        }
    }

    private async Task<ExternalAlert?> EvaluateRecoverableAsync(
        LitterRobotSnapshot snapshot,
        LitterRobotRecoveryRunner runner,
        HomeHubDbContext? db,
        DateTimeOffset now,
        CancellationToken ct)
    {
        var slug = snapshot.Slug;
        var fault = snapshot.Fault;
        _tracker.NoteFault(slug, fault.Code, now);
        var (attempts, faultSince, nextDue, lastCat) = _tracker.Read(slug);

        // 1. Debounce — most transient oddities clear themselves inside this window.
        var debounce = TimeSpan.FromSeconds(Math.Max(0, Recovery.DebounceSeconds));
        if (faultSince is not null && now - faultSince.Value < debounce)
        {
            _tracker.SetHold(slug, "Confirming the fault");
            return null;
        }

        // 2. Observe-only mode still tells someone the box is stuck — whether that's the configured
        //    master switch or someone on the panel saying "leave it". Pausing stops the intervening,
        //    never the reporting: a paused box is still a box the cat can't use.
        var paused = _tracker.IsPaused(slug);
        if (!Recovery.Enabled || paused)
        {
            _tracker.SetHold(slug, paused ? "Paused from the panel" : "Auto-recovery disabled");
            return Alert(snapshot, "faulted", AlertSeverity.Severe,
                $"{snapshot.Name}: {fault.Text} — auto-recovery is {(paused ? "paused" : "off")}, so it needs clearing by hand.");
        }

        // 3. An empty globe has the same symptom and a different fix. Cycling it achieves nothing, and
        //    reporting "recovered" on a box with no litter would be a lie the cat pays for.
        if (snapshot.LitterPercent is { } litter && litter < Recovery.LitterFloorPercent)
        {
            _tracker.SetHold(slug, "Out of litter");
            return Alert(snapshot, "no_litter", AlertSeverity.Severe,
                $"{snapshot.Name}: {fault.Text} and litter at {litter:0}% — needs refilling, not cycling.");
        }

        // 4. Cat settle window. The runner enforces the gate too; this avoids burning an attempt.
        var catSettle = TimeSpan.FromSeconds(Math.Max(0, Recovery.CatSettleSeconds));
        if (lastCat is not null && now - lastCat.Value < catSettle)
        {
            _tracker.SetHold(slug, "Waiting for the cat to leave");
            return null;
        }

        // 5. Per-episode ceiling, tightened by per-code limits for the mechanical faults.
        var episodeLimit = Math.Min(
            Math.Max(1, Recovery.MaxAttemptsPerEpisode),
            fault.MaxAttempts ?? int.MaxValue);
        if (attempts >= episodeLimit)
        {
            _tracker.SetHold(slug, "Attempts exhausted");
            return Alert(snapshot, "stuck", AlertSeverity.Severe,
                $"{snapshot.Name}: {fault.Text} — {attempts} reset/cycle attempt(s) didn't clear it. The box is unusable.");
        }

        // 6. Rolling 24h cap, from persisted rows so a restart can't reset it.
        var attemptsToday = await CountRecentAttemptsAsync(db, slug, now, ct);
        if (attemptsToday >= Math.Max(1, Recovery.MaxAttemptsPerDay))
        {
            _tracker.SetHold(slug, "Daily attempt cap reached");
            return Alert(snapshot, "capped", AlertSeverity.Severe,
                $"{snapshot.Name}: {fault.Text} — {attemptsToday} recoveries in 24h, so automatic attempts have stopped. This needs looking at.");
        }

        // 7. Backoff between attempts within an episode.
        if (nextDue is not null && now < nextDue.Value)
        {
            _tracker.SetHold(slug, "Waiting before the next attempt");
            return null;
        }

        // --- attempt ---
        var attemptNumber = attempts + 1;
        _tracker.NoteAttempt(slug, now, Recovery);
        var result = await runner.AttemptAsync(slug, attemptNumber, manual: false, ct);

        if (result.Recovered)
        {
            // Counters deliberately stay until the robot has been stable for StableConfirmSeconds, so a
            // robot that recovers and immediately re-faults keeps spending the same episode's budget.
            _tracker.SetHold(slug, null);
            return null;
        }

        // Not recovered: no alert yet if attempts remain — the next tick will retry after the backoff.
        if (attemptNumber < episodeLimit) return null;

        return Alert(snapshot, "stuck", AlertSeverity.Severe,
            $"{snapshot.Name}: {fault.Text} — {attemptNumber} reset/cycle attempt(s) didn't clear it. The box is unusable.");
    }

    /// <summary>
    /// Automatic attempts in the last 24h. Manual presses are excluded: a person deciding to cycle the
    /// box should not consume the safety budget that exists to stop <em>unattended</em> grinding.
    /// </summary>
    private static async Task<int> CountRecentAttemptsAsync(
        HomeHubDbContext? db, string slug, DateTimeOffset now, CancellationToken ct)
    {
        if (db is null) return 0;
        var since = now.AddDays(-1).UtcDateTime;
        return await db.LitterRobotRecoveries
            .CountAsync(r => r.Slug == slug && !r.Manual && r.StartedAtUtc >= since, ct);
    }

    private static ExternalAlert Alert(
        LitterRobotSnapshot snapshot, string kind, AlertSeverity severity, string message) =>
        new($"litterrobot:{snapshot.Slug}:{kind}", severity, message, $"cat:{snapshot.Slug}", null);

    /// <summary>Used when the panel has no database to read the household's threshold from.</summary>
    private const int DefaultLitterFullPercent = 80;

    /// <summary>
    /// "The drawer is getting full" — raised ahead of the robot's own drawer-full fault, which only
    /// fires once the box has already stopped cycling.
    /// </summary>
    /// <remarks>
    /// Warning, not Severe. The box still works: this is a chore with a day or two of slack on it,
    /// and reserving Severe for the robot actually refusing to cycle is what keeps the difference
    /// between the two legible on the dashboard banner.
    /// <para>
    /// Null when the robot cannot measure its drawer — the LR3 reports no percentage at all, and a
    /// missing reading is not a low one. Also null once the robot is reporting drawer-full itself,
    /// because that fault raises its own Severe alert and two banners about one drawer is one too
    /// many.
    /// </para>
    /// </remarks>
    internal static ExternalAlert? DrawerAlert(LitterRobotSnapshot snapshot, int fullPercent)
    {
        if (snapshot.WasteDrawerPercent is not { } percent) return null;
        if (percent < fullPercent) return null;
        // The robot's own drawer-full codes already speak for this drawer, and louder.
        if (snapshot.Fault.Code is "dfs" or "sdf") return null;

        return Alert(snapshot, "drawer_full", AlertSeverity.Warning,
            $"{snapshot.Name}: waste drawer {Math.Round(percent)}% full — time to change the litter.");
    }
}
