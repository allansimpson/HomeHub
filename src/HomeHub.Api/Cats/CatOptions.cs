namespace HomeHub.Api.Cats;

/// <summary>
/// Litter-Robot config, bound from the <c>Cats</c> section. No Whisker credentials here by design:
/// the Whisker login lives in Home Assistant's config flow, so HomeHub holds only the HA token (see
/// the <c>HomeAssistant</c> section) — same arrangement as Huckleberry.
/// </summary>
public sealed class CatOptions
{
    public const string Section = "Cats";

    /// <summary>Kill switch for the whole section. HA config gates the provider independently.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>
    /// Explicit robot slugs (the <c>{robot}</c> in <c>sensor.{robot}_status_code</c>, derived by HA
    /// from the name set in the Whisker app — e.g. <c>litter_robot_4</c>). Leave empty to
    /// auto-discover from HA's entity list; pin them here if discovery picks up something it shouldn't.
    /// </summary>
    /// <remarks>
    /// **Prefer discovery.** A pinned slug is a copy of an identifier this app doesn't own: rename the
    /// robot in a way that regenerates entity ids and the pin still resolves, producing a robot with
    /// every field null rather than an error — a ghost on the panel with hatched gauges and no cause.
    /// Discovery keys off the one entity every model publishes, so it survives renames untouched.
    /// </remarks>
    public List<string> Robots { get; set; } = new();

    /// <summary>Display-name overrides keyed by slug, when the HA friendly name isn't what you'd call it.</summary>
    public Dictionary<string, string> RobotNames { get; set; } = new();

    /// <summary>How long a fetched snapshot stays fresh, so panel polling doesn't become HA polling.</summary>
    public int CacheSeconds { get; set; } = 10;

    public RecoveryOptions Recovery { get; set; } = new();
}

/// <summary>
/// Auto-recovery tuning. The defaults are deliberately conservative: the failure mode being guarded
/// against is a robot that faults, "recovers", and re-faults every twenty minutes, quietly running
/// hundreds of motor cycles overnight while masking a part that needs replacing.
/// </summary>
public sealed class RecoveryOptions
{
    /// <summary>Master switch for automatic intervention. Off = observe and alert only.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>How often the loop evaluates each robot.</summary>
    public int PollSeconds { get; set; } = 30;

    /// <summary>
    /// How long a recoverable fault must persist before the first attempt. The LR4 reports odd codes
    /// transiently mid-cycle, and most of those clear on their own within a minute.
    /// </summary>
    public int DebounceSeconds { get; set; } = 90;

    /// <summary>
    /// Quiet period after a cat is last detected before any command is sent. The globe re-homes on
    /// reset, so this is a safety margin on top of the robot's own interlock — not a substitute for it.
    /// </summary>
    public int CatSettleSeconds { get; set; } = 120;

    /// <summary>How long to wait after pressing reset before re-reading status.</summary>
    public int ResetSettleSeconds { get; set; } = 35;

    /// <summary>How long to wait after starting a clean cycle before re-reading status.</summary>
    public int CycleSettleSeconds { get; set; } = 35;

    /// <summary>How long the robot must stay stable before an episode is closed and counters reset.</summary>
    public int StableConfirmSeconds { get; set; } = 300;

    /// <summary>Attempts per fault episode before escalating to a person. Per-code ceilings can lower this.</summary>
    public int MaxAttemptsPerEpisode { get; set; } = 3;

    /// <summary>
    /// Hard ceiling on attempts in any rolling 24h, across all episodes, persisted so a restart can't
    /// reset it. Hitting this raises an alert and stops intervening: at that point the robot needs
    /// hands, not more software.
    /// </summary>
    public int MaxAttemptsPerDay { get; set; } = 6;

    /// <summary>Minutes to wait before attempt 2, 3, … within one episode. The first attempt fires as soon as the debounce passes.</summary>
    public List<int> BackoffMinutes { get; set; } = new() { 5, 15 };

    /// <summary>
    /// Litter level below which cycling is pointless — the globe is empty and the cat has nowhere to
    /// go regardless of position, so alert instead of retrying. Ignored when the robot can't report a
    /// litter level (LR3).
    /// </summary>
    public double LitterFloorPercent { get; set; } = 5;

    /// <summary>Backoff for attempt <paramref name="attemptNumber"/> (1-based); the last configured value repeats.</summary>
    public TimeSpan BackoffFor(int attemptNumber)
    {
        if (attemptNumber <= 1 || BackoffMinutes.Count == 0) return TimeSpan.Zero;
        var index = Math.Min(attemptNumber - 2, BackoffMinutes.Count - 1);
        return TimeSpan.FromMinutes(Math.Max(0, BackoffMinutes[index]));
    }
}
