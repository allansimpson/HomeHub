namespace HomeHub.Api.Cats;

/// <summary>
/// One recorded auto-recovery attempt. Persisted rather than kept in memory for two reasons: the
/// rolling 24h attempt cap has to survive an app restart (otherwise a restart loop becomes an
/// unlimited motor-cycle loop), and the history is the diagnostic that tells you when a robot has
/// stopped being flaky and started being broken.
/// </summary>
public class LitterRobotRecovery
{
    public int Id { get; set; }

    /// <summary>Robot entity-id slug, matching <see cref="LitterRobotDescriptor.Slug"/>.</summary>
    public string Slug { get; set; } = "";

    /// <summary>The status code that triggered the attempt (e.g. <c>hpf</c>, <c>p</c>).</summary>
    public string FaultCode { get; set; } = "";

    /// <summary>1-based attempt number within this fault episode.</summary>
    public int AttemptNumber { get; set; }

    /// <summary>Highest rung of the ladder actually used.</summary>
    public RecoveryStep Step { get; set; }

    public RecoveryOutcome Outcome { get; set; }

    /// <summary>Status code observed after the attempt settled — the evidence for <see cref="Outcome"/>.</summary>
    public string? ResultingCode { get; set; }

    /// <summary>Why the attempt ended as it did, when the outcome alone doesn't say enough.</summary>
    public string? Detail { get; set; }

    /// <summary>True when a person pressed the button rather than the loop deciding. Manual attempts don't count against the caps.</summary>
    public bool Manual { get; set; }

    public DateTime StartedAtUtc { get; set; }

    public DateTime? CompletedAtUtc { get; set; }
}
