namespace HomeHub.Api.Cats;

using HomeHub.Api.Data;
using Microsoft.Extensions.Options;

/// <summary>Result of one recovery attempt, with the evidence for its verdict.</summary>
public sealed record RecoveryAttemptResult(
    RecoveryOutcome Outcome,
    RecoveryStep Step,
    string? ResultingCode,
    string? Detail)
{
    public bool Recovered => Outcome == RecoveryOutcome.Recovered;
}

/// <summary>
/// Executes one pass of the escalation ladder and decides whether it worked. Shared by the automatic
/// loop and the panel's manual "cycle now" button so both paths get the same safety gate and the same
/// verification.
/// </summary>
/// <remarks>
/// <para><b>Verification is by observed state, never by HTTP success.</b> The robot accepts commands it
/// then silently drops — a clean cycle requested with a cat detected returns success and does nothing.
/// So every rung is followed by re-reading the status until it becomes usable or the settle window
/// expires. Without this the panel would confidently report "cycling" while the globe sat faulted.</para>
///
/// <para>The cat gate lives here rather than in the loop so the manual button cannot bypass it. A reset
/// re-homes the globe; the robot has its own interlock and this is a margin on top of it, not a
/// substitute. Manual attempts may skip the debounce, the backoff and the caps — but not this.</para>
/// </remarks>
public sealed class LitterRobotRecoveryRunner
{
    /// <summary>How often to re-read status while waiting for a rung to take effect.</summary>
    private static readonly TimeSpan PollStep = TimeSpan.FromSeconds(5);

    private readonly ILitterRobotProvider _provider;
    private readonly ILitterRobotCommands _commands;
    private readonly RecoveryOptions _options;
    private readonly IServiceProvider _services;
    private readonly ILogger<LitterRobotRecoveryRunner> _logger;
    private readonly TimeProvider _time;

    public LitterRobotRecoveryRunner(
        ILitterRobotProvider provider,
        ILitterRobotCommands commands,
        IOptions<CatOptions> options,
        IServiceProvider services,
        ILogger<LitterRobotRecoveryRunner> logger,
        TimeProvider time)
    {
        _provider = provider;
        _commands = commands;
        _options = options.Value.Recovery;
        _services = services;
        _logger = logger;
        _time = time;
    }

    /// <summary>
    /// Run the ladder for one robot. <paramref name="manual"/> attempts are recorded but excluded from
    /// the rolling 24h cap, and are permitted on a robot that is already ready (a person asking for a
    /// cycle is a legitimate request, not a recovery).
    /// </summary>
    public async Task<RecoveryAttemptResult> AttemptAsync(
        string slug, int attemptNumber, bool manual, CancellationToken ct)
    {
        var startedAt = _time.GetUtcNow();
        var before = await FreshAsync(slug, ct);

        if (before is null)
            return await RecordAsync(slug, "unknown", attemptNumber, RecoveryStep.Reset, manual, startedAt,
                new RecoveryAttemptResult(RecoveryOutcome.Aborted, RecoveryStep.Reset, null,
                    "Robot not found in Home Assistant."), ct);

        var faultCode = before.Fault.Code;

        // --- safety gate: never command a globe with a cat in or on it ---
        if (before.Fault.Class == LitterRobotFaultClass.CatPresent)
            return await RecordAsync(slug, faultCode, attemptNumber, RecoveryStep.Reset, manual, startedAt,
                new RecoveryAttemptResult(RecoveryOutcome.Aborted, RecoveryStep.Reset, faultCode,
                    "Cat detected — no commands sent."), ct);

        if (before.Fault.Class == LitterRobotFaultClass.Offline)
            return await RecordAsync(slug, faultCode, attemptNumber, RecoveryStep.Reset, manual, startedAt,
                new RecoveryAttemptResult(RecoveryOutcome.Aborted, RecoveryStep.Reset, faultCode,
                    "Robot is off or unreachable — no command would land."), ct);

        if (before.Fault.Class == LitterRobotFaultClass.NeedsHuman)
            return await RecordAsync(slug, faultCode, attemptNumber, RecoveryStep.Reset, manual, startedAt,
                new RecoveryAttemptResult(RecoveryOutcome.Aborted, RecoveryStep.Reset, faultCode,
                    $"{before.Fault.Text} needs physical intervention; cycling would not clear it."), ct);

        // Already usable: only a manual request proceeds, and then it is just a cycle — no reset needed.
        var alreadyUsable = before.IsUsable;
        if (alreadyUsable && !manual)
            return await RecordAsync(slug, faultCode, attemptNumber, RecoveryStep.Reset, manual, startedAt,
                new RecoveryAttemptResult(RecoveryOutcome.Aborted, RecoveryStep.Reset, faultCode,
                    "Fault cleared on its own before the attempt started."), ct);

        var ladder = BuildLadder(alreadyUsable, attemptNumber);
        var result = await ClimbAsync(slug, ladder, ct);
        return await RecordAsync(slug, faultCode, attemptNumber, result.Step, manual, startedAt, result, ct);
    }

    /// <summary>
    /// The rungs to try, gentlest first, filtered to what the command provider can actually reach.
    /// Over Home Assistant that is reset → clean cycle; a direct-Whisker provider adds a short reset in
    /// front and a power cycle at the end.
    /// </summary>
    private List<RecoveryStep> BuildLadder(bool alreadyUsable, int attemptNumber)
    {
        // A cycle on a healthy robot is the whole request when a person pressed the button.
        if (alreadyUsable) return [RecoveryStep.CleanCycle];

        var ladder = new List<RecoveryStep>();
        if (_commands.Supports(RecoveryStep.ShortReset)) ladder.Add(RecoveryStep.ShortReset);
        if (_commands.Supports(RecoveryStep.Reset)) ladder.Add(RecoveryStep.Reset);
        if (_commands.Supports(RecoveryStep.CleanCycle)) ladder.Add(RecoveryStep.CleanCycle);
        // Power cycling is the harshest rung; hold it back until the gentler ones have failed at least once.
        if (attemptNumber > 1 && _commands.Supports(RecoveryStep.PowerCycle)) ladder.Add(RecoveryStep.PowerCycle);
        return ladder;
    }

    private async Task<RecoveryAttemptResult> ClimbAsync(string slug, List<RecoveryStep> ladder, CancellationToken ct)
    {
        if (ladder.Count == 0)
            return new RecoveryAttemptResult(RecoveryOutcome.Errored, RecoveryStep.Reset, null,
                "No recovery command is available from the configured provider.");

        var lastStep = ladder[0];
        string? lastCode = null;

        foreach (var step in ladder)
        {
            lastStep = step;
            try
            {
                await SendAsync(slug, step, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Recovery step {Step} failed to send for {Slug}.", step, slug);
                return new RecoveryAttemptResult(RecoveryOutcome.Errored, step, lastCode, Trim(ex.Message));
            }

            var settled = await SettleAsync(slug, SettleFor(step), ct);
            lastCode = settled?.Fault.Code;

            // A cat arriving mid-recovery ends the attempt: the next rung would command an occupied globe.
            if (settled?.Fault.Class == LitterRobotFaultClass.CatPresent)
                return new RecoveryAttemptResult(RecoveryOutcome.Aborted, step, lastCode,
                    "Cat arrived during recovery — stopped before the next step.");

            if (settled?.IsUsable == true)
                return new RecoveryAttemptResult(RecoveryOutcome.Recovered, step, lastCode, null);
        }

        return new RecoveryAttemptResult(RecoveryOutcome.Failed, lastStep, lastCode,
            $"Ladder exhausted ({string.Join(" → ", ladder)}); robot still reports {lastCode ?? "unknown"}.");
    }

    private Task SendAsync(string slug, RecoveryStep step, CancellationToken ct) => step switch
    {
        RecoveryStep.ShortReset => _commands.ShortResetAsync(slug, ct),
        RecoveryStep.Reset => _commands.ResetAsync(slug, ct),
        RecoveryStep.CleanCycle => _commands.StartCleanCycleAsync(slug, ct),
        RecoveryStep.PowerCycle => _commands.PowerCycleAsync(slug, ct),
        _ => throw new ArgumentOutOfRangeException(nameof(step)),
    };

    private TimeSpan SettleFor(RecoveryStep step) => step switch
    {
        RecoveryStep.CleanCycle => TimeSpan.FromSeconds(Math.Max(0, _options.CycleSettleSeconds)),
        _ => TimeSpan.FromSeconds(Math.Max(0, _options.ResetSettleSeconds)),
    };

    /// <summary>
    /// Re-read status until the robot is usable or the window expires. Polling rather than one flat
    /// sleep so a fast recovery is noticed promptly instead of always costing the full settle time.
    /// </summary>
    private async Task<LitterRobotSnapshot?> SettleAsync(string slug, TimeSpan window, CancellationToken ct)
    {
        if (window <= TimeSpan.Zero) return await FreshAsync(slug, ct);

        var deadline = _time.GetUtcNow() + window;
        var step = PollStep < window ? PollStep : window;
        LitterRobotSnapshot? latest = null;

        while (true)
        {
            // Delay against the TimeProvider, not the wall clock, so tests don't sit through settle windows.
            await Task.Delay(step, _time, ct);
            latest = await FreshAsync(slug, ct);
            if (latest?.IsUsable == true) return latest;
            if (latest?.Fault.Class == LitterRobotFaultClass.CatPresent) return latest;
            if (_time.GetUtcNow() >= deadline) return latest;
        }
    }

    private async Task<LitterRobotSnapshot?> FreshAsync(string slug, CancellationToken ct)
    {
        try
        {
            var all = await _provider.GetFreshSnapshotsAsync(ct);
            return all.FirstOrDefault(s => s.Slug == slug);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            // A failed read is "we don't know", which the callers treat as not-recovered rather than
            // as a reason to keep sending commands blind.
            _logger.LogWarning(ex, "Could not read status for {Slug} during recovery.", slug);
            return null;
        }
    }

    /// <summary>
    /// Persist the attempt. The database is optional (the shell boots without a connection string), so a
    /// missing context downgrades to a log line rather than failing the recovery — the attempt still
    /// happened and the panel still needs its answer.
    /// </summary>
    private async Task<RecoveryAttemptResult> RecordAsync(
        string slug, string faultCode, int attemptNumber, RecoveryStep step, bool manual,
        DateTimeOffset startedAt, RecoveryAttemptResult result, CancellationToken ct)
    {
        _logger.Log(
            result.Recovered ? LogLevel.Information : LogLevel.Warning,
            "Litter-Robot {Slug}: attempt {Attempt} on {Fault} via {Step} → {Outcome} ({Detail}).",
            slug, attemptNumber, faultCode, step, result.Outcome, result.Detail ?? "verified by status");

        var db = _services.GetService<HomeHubDbContext>();
        if (db is null) return result;

        try
        {
            db.LitterRobotRecoveries.Add(new LitterRobotRecovery
            {
                Slug = slug,
                FaultCode = faultCode,
                AttemptNumber = attemptNumber,
                Step = step,
                Outcome = result.Outcome,
                ResultingCode = result.ResultingCode,
                Detail = Trim(result.Detail),
                Manual = manual,
                StartedAtUtc = startedAt.UtcDateTime,
                CompletedAtUtc = _time.GetUtcNow().UtcDateTime,
            });
            await db.SaveChangesAsync(ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not record the recovery attempt for {Slug}.", slug);
        }

        return result;
    }

    /// <summary>Keeps free text inside the column width.</summary>
    private static string? Trim(string? text) =>
        text is null ? null : text.Length <= 300 ? text : text[..300];
}
