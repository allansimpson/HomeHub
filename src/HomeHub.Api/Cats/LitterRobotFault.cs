namespace HomeHub.Api.Cats;

/// <summary>
/// What the app should do about a Litter-Robot status. The whole recovery loop keys off this, so a
/// mis-classified code is the difference between clearing a fault and hammering a motor that will
/// never recover on its own.
/// </summary>
public enum LitterRobotFaultClass
{
    /// <summary>Usable. Ready, or a drawer-nearly-full warning that still cycles.</summary>
    Stable,

    /// <summary>Mid-cycle or powering. Never intervene — wait for it to land.</summary>
    Transient,

    /// <summary>A cat is in or on the unit. Hard stop on every command (see the safety gate).</summary>
    CatPresent,

    /// <summary>A lock-in a reset + re-cycle can clear. This is what the recovery loop exists for.</summary>
    Recoverable,

    /// <summary>Physical intervention required. Retrying is useless and hides the real problem.</summary>
    NeedsHuman,

    /// <summary>Powered off or no cloud connection. No command will land.</summary>
    Offline,

    /// <summary>Unrecognised code, or the entity is unavailable. Treated as "do nothing, report".</summary>
    Unknown,
}

/// <summary>
/// One Litter-Robot status code, its human text, and how the recovery loop treats it.
/// </summary>
/// <param name="Code">The lowercase code HA puts in <c>sensor.{robot}_status_code</c>.</param>
/// <param name="Text">Human-readable text, matching pylitterbot's wording so it lines up with the Whisker app.</param>
/// <param name="Class">What to do about it.</param>
/// <param name="MaxAttempts">
/// Per-code attempt ceiling, overriding the configured default. Set for faults where a repeat means
/// mechanical trouble rather than a transient lock-in — retrying those is how you turn a jam into a
/// broken motor.
/// </param>
public sealed record LitterRobotFault(
    string Code,
    string Text,
    LitterRobotFaultClass Class,
    int? MaxAttempts = null)
{
    public bool IsRecoverable => Class == LitterRobotFaultClass.Recoverable;
}

/// <summary>
/// The full Litter-Robot status vocabulary and its recovery classification.
/// </summary>
/// <remarks>
/// The 25 codes are the documented options of Home Assistant's <c>status_code</c> sensor, and the
/// texts come from pylitterbot's <c>LitterBoxStatus</c> enum — so this table is verified against the
/// integration rather than guessed, unlike the Huckleberry entity names.
///
/// <para>The classification is ours, and it is the one thing here worth arguing about:</para>
/// <list type="bullet">
/// <item><c>hpf</c> (home position fault) is the fault behind "the globe parked somewhere the cat
/// can't use it" — the reason this whole subsystem exists, alongside <c>p</c> (paused).</item>
/// <item><c>dfs</c>/<c>sdf</c> (drawer full) are deliberately <see cref="LitterRobotFaultClass.NeedsHuman"/>.
/// The robot refuses to cycle with a full drawer, so a reset loop would spin forever and never
/// surface the actual "go empty me" message.</item>
/// <item><c>otf</c>/<c>pd</c>/<c>spf</c> get a hard one-attempt ceiling. A single over-torque or
/// pinch-detect is often a stray litter granule; a second one in the same episode means something is
/// physically in the way and more motor cycles make it worse.</item>
/// <item><c>df1</c>/<c>df2</c> are <see cref="LitterRobotFaultClass.Stable"/>, not faults — the unit
/// is still working, it just wants emptying soon. That is a drawer-level display concern.</item>
/// </list>
/// </remarks>
public static class LitterRobotFaults
{
    /// <summary>Status reported when HA has no value for the entity at all.</summary>
    public static readonly LitterRobotFault Unavailable =
        new("unavailable", "Unavailable", LitterRobotFaultClass.Unknown);

    private static readonly LitterRobotFault[] All =
    [
        // --- usable ---
        new("rdy", "Ready", LitterRobotFaultClass.Stable),
        new("df1", "Drawer Almost Full - 2 Cycles Left", LitterRobotFaultClass.Stable),
        new("df2", "Drawer Almost Full - 1 Cycle Left", LitterRobotFaultClass.Stable),

        // --- in motion / powering: wait it out ---
        new("ccp", "Clean Cycle In Progress", LitterRobotFaultClass.Transient),
        new("ccc", "Clean Cycle Complete", LitterRobotFaultClass.Transient),
        new("ec", "Empty Cycle", LitterRobotFaultClass.Transient),
        new("pwru", "Powering Up", LitterRobotFaultClass.Transient),
        new("pwrd", "Powering Down", LitterRobotFaultClass.Transient),

        // --- occupied: never command the globe ---
        new("cd", "Cat Detected", LitterRobotFaultClass.CatPresent),

        // --- lock-ins a reset + re-cycle clears ---
        new("p", "Clean Cycle Paused", LitterRobotFaultClass.Recoverable),
        new("hpf", "Home Position Fault", LitterRobotFaultClass.Recoverable),
        new("dpf", "Dump Position Fault", LitterRobotFaultClass.Recoverable),
        new("dhf", "Dump + Home Position Fault", LitterRobotFaultClass.Recoverable),
        // Cat-sensor faults usually clear themselves once the sensor settles; give them room but
        // still recover, because a stuck cat sensor blocks cycling entirely.
        new("csf", "Cat Sensor Fault", LitterRobotFaultClass.Recoverable),
        new("scf", "Cat Sensor Fault At Startup", LitterRobotFaultClass.Recoverable),
        new("csi", "Cat Sensor Interrupted", LitterRobotFaultClass.Recoverable),
        new("cst", "Cat Sensor Timing", LitterRobotFaultClass.Recoverable),
        // Mechanical: one attempt, then hands. See the remarks above.
        new("otf", "Over Torque Fault", LitterRobotFaultClass.Recoverable, MaxAttempts: 1),
        new("pd", "Pinch Detect", LitterRobotFaultClass.Recoverable, MaxAttempts: 1),
        new("spf", "Pinch Detect At Startup", LitterRobotFaultClass.Recoverable, MaxAttempts: 1),

        // --- needs a person ---
        new("dfs", "Drawer Full", LitterRobotFaultClass.NeedsHuman),
        new("sdf", "Drawer Full At Startup", LitterRobotFaultClass.NeedsHuman),
        new("br", "Bonnet Removed", LitterRobotFaultClass.NeedsHuman),

        // --- unreachable ---
        new("off", "Off", LitterRobotFaultClass.Offline),
        new("offline", "Offline", LitterRobotFaultClass.Offline),
    ];

    private static readonly Dictionary<string, LitterRobotFault> ByCode =
        All.ToDictionary(f => f.Code, StringComparer.OrdinalIgnoreCase);

    /// <summary>Every known code, for tests and diagnostics.</summary>
    public static IReadOnlyList<LitterRobotFault> Known => All;

    /// <summary>
    /// Classify an HA <c>status_code</c> state. Unknown or missing codes come back as
    /// <see cref="LitterRobotFaultClass.Unknown"/> — reported, never acted on, so a firmware update
    /// that adds a code can't make the loop start resetting on something it doesn't understand.
    /// </summary>
    public static LitterRobotFault Classify(string? statusCode)
    {
        if (string.IsNullOrWhiteSpace(statusCode)) return Unavailable;
        var code = statusCode.Trim();
        if (ByCode.TryGetValue(code, out var known)) return known;
        return new LitterRobotFault(code.ToLowerInvariant(), code, LitterRobotFaultClass.Unknown);
    }
}
