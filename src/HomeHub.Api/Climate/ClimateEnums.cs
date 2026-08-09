namespace HomeHub.Api.Climate;

/// <summary>
/// What a room is, and therefore what the panel may offer to do with it.
/// </summary>
/// <remarks>
/// The one thing the Climate list branches on. <see cref="Automated"/> rows get the deviation band
/// and the press-and-slide gesture; the other two get a read-only row and <b>never grow a control
/// of any kind</b> — a disabled control implies a capability the house does not have
/// (CLIMATE_SCREEN §6).
/// </remarks>
public enum ZoneClass
{
    /// <summary>A probe and a mini-split: the loop holds it.</summary>
    Automated = 0,

    /// <summary>A probe and no unit. Read, never commanded.</summary>
    Watched = 1,

    /// <summary>Fridge / freezer. Watched, plus an in-range band and an alarm state.</summary>
    ColdStorage = 2,
}

/// <summary>
/// How hard the loop pushes when a room is off target.
/// </summary>
/// <remarks>
/// Step size <em>and</em> the minimum gap between writes, because the two cannot be chosen
/// independently: a 3° step every twenty minutes is a different machine from a 3° step every six.
/// The interval half is compressor protection rather than taste, which is why the panel exposes the
/// strength and not the minutes (DECISIONS §7).
/// </remarks>
public enum CorrectionStrength
{
    /// <summary>1° per write, at most one write every 20 minutes.</summary>
    Gentle = 0,

    /// <summary>2° per write, at most one write every 10 minutes. The default.</summary>
    Steady = 1,

    /// <summary>3° per write, at most one write every 6 minutes.</summary>
    Hard = 2,
}

/// <summary>Why the loop touched (or decided not to touch) a unit. One per attempt.</summary>
public enum LoopWriteReason
{
    /// <summary>Ordinary correction toward the effective target.</summary>
    Correct = 0,

    /// <summary>Inside tolerance — recorded so "STEADY 3H 20M" has something to measure from.</summary>
    Settle = 1,

    /// <summary>The probe went quiet: hand the room back to the unit's own sensor.</summary>
    ProbeLost = 2,

    /// <summary>Quiet hours began.</summary>
    QuietStart = 3,

    /// <summary>Quiet hours ended — one write to re-establish the target.</summary>
    QuietEnd = 4,

    /// <summary>The room (or the house) came off pause.</summary>
    Resume = 5,

    /// <summary>The room (or the house) was paused. The unit is left exactly as it is.</summary>
    Pause = 6,

    /// <summary>A two-hour loan started.</summary>
    OverrideStart = 7,

    /// <summary>A loan expired and the standing target came back.</summary>
    OverrideEnd = 8,

    /// <summary>A loan was promoted to standing (3a / 3b), or the standing target was edited.</summary>
    Promote = 9,
}

/// <summary>What became of a write attempt. Failures are recorded, not swallowed.</summary>
public enum LoopWriteOutcome
{
    Written = 0,

    /// <summary>Home Assistant (or the unit behind it) could not be reached.</summary>
    Unreachable = 1,

    /// <summary>HA took the call but the unit came back reporting something else — usually a remote.</summary>
    Rejected = 2,

    /// <summary>Nothing was sent: paused, quiet, inside tolerance, or the unit is off.</summary>
    Skipped = 3,
}
