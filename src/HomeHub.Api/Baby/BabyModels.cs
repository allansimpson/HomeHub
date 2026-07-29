namespace HomeHub.Api.Baby;

/// <summary>Sleep state for a child, as the panel shows it.</summary>
public enum BabySleepState
{
    Unknown,
    Awake,
    Asleep,
    Paused,
}

/// <summary>How the Huckleberry integration is doing, kept distinguishable so the panel is truthful.</summary>
/// <remarks>
/// Per the design doc's risk list, "HA down" and "integration broken" must not collapse into one
/// vague error — they need different fixes and the panel should say which.
/// </remarks>
public enum HuckleberryStatus
{
    /// <summary>No HA config — the Baby section renders "Not connected", which is not an error.</summary>
    NotConfigured,
    Ok,
    /// <summary>HA itself did not answer.</summary>
    HomeAssistantUnreachable,
    /// <summary>HA answered but exposes no Huckleberry entities (not installed, or auth failed in its config flow).</summary>
    IntegrationMissing,
    /// <summary>Serving a cached snapshot after a failed refresh.</summary>
    Stale,
}

public sealed record HuckleberryHealth(HuckleberryStatus Status, string? Detail, DateTimeOffset? LastGoodUtc);

/// <summary>
/// A child. <paramref name="Key"/> is the entity-id slug (<c>conrad</c> →
/// <c>sensor.conrad_sleep</c>); <paramref name="Uid"/> is Huckleberry's own identifier, which is
/// what service calls target.
/// </summary>
public sealed record BabyChild(string Key, string Name, string? Uid = null, DateOnly? Birthday = null);

/// <summary>
/// Sleep state plus the last completed session.
/// </summary>
/// <remarks>
/// <paramref name="StartedUtc"/> is only populated while a timer is running. Verified against a live
/// install: the sensor exposes no current-start attribute when idle, so an active timer's basis is
/// resolved from whichever start attribute the integration publishes, falling back to the entity's
/// <c>last_changed</c> — the moment the state flipped to <c>active</c> is a sound proxy for when the
/// timer started.
/// </remarks>
public sealed record BabySleepSummary(
    BabySleepState State,
    DateTimeOffset? StartedUtc,
    bool Paused,
    DateTimeOffset? LastSessionStartUtc = null,
    TimeSpan? LastSessionDuration = null);

/// <summary>Nursing state plus the last completed session's per-side breakdown.</summary>
public sealed record BabyNursingSummary(
    bool Running,
    bool Paused,
    DateTimeOffset? StartedUtc,
    string? Side,
    DateTimeOffset? LastAtUtc,
    TimeSpan? LastDuration = null,
    TimeSpan? LastLeftDuration = null,
    TimeSpan? LastRightDuration = null);

public sealed record BabyBottleSummary(DateTimeOffset? LastAtUtc, double? Amount, string? Unit, string? Kind);

public sealed record BabyDiaperSummary(DateTimeOffset? LastAtUtc, string? Kind);

/// <summary>
/// Latest growth measurements. Units are carried rather than normalised: the family's Huckleberry
/// account decides kg-vs-lb, and Gate H0.2 hasn't confirmed which attribute reports it — converting
/// on a guess would silently mis-state a baby's weight.
/// </summary>
public sealed record BabyGrowthSummary(
    DateTimeOffset? MeasuredAtUtc,
    double? Weight,
    string? WeightUnit,
    double? Height,
    double? HeadCircumference,
    string? LengthUnit);

/// <summary>Today's tallies for the dashboard's counts line ("4 feeds · 3 diapers today").</summary>
public sealed record BabyDailyCounts(int Feeds, int Diapers);

/// <summary>Everything the panel needs for one child in a single read.</summary>
public sealed record BabyState(
    string ChildKey,
    string ChildName,
    BabySleepSummary Sleep,
    BabyNursingSummary Nursing,
    BabyBottleSummary Bottle,
    BabyDiaperSummary Diaper,
    BabyGrowthSummary Growth,
    BabyDailyCounts Today,
    DateTimeOffset FetchedUtc,
    bool Stale);

/// <summary>One historical event from the child's HA calendar.</summary>
public sealed record BabyHistoryEvent(
    DateTimeOffset StartUtc,
    DateTimeOffset? EndUtc,
    string Kind,
    string Summary,
    string? Detail);

/// <summary>
/// Entity ids, attribute names and state values the Huckleberry HA integration exposes.
/// </summary>
/// <remarks>
/// <b>Verified against a live install (Gate H0.2, integration v0.4.3, HA 2026.7.4).</b> Centralised
/// here so a future upstream rename is a one-file correction rather than a hunt through the
/// provider. Reads remain defensive (<see cref="HomeAssistant.HaState"/> accessors return null
/// rather than throwing), so an upstream change degrades a field to "unknown" instead of taking the
/// section down.
/// <para>
/// Two things remain unverified because there was no data to observe: the attributes published
/// while a timer is <c>active</c> (see <see cref="ActiveStartCandidates"/>), and the growth
/// measurement attributes (the growth sensor reports <c>unknown</c> with no attributes until
/// something is logged).
/// </para>
/// </remarks>
public static class HuckleberryEntities
{
    public const string SleepSuffix = "_sleep";
    public const string NursingSuffix = "_nursing";
    public const string BottleSuffix = "_bottle";
    public const string DiaperSuffix = "_diaper";
    public const string GrowthSuffix = "_growth";
    public const string ProfileSuffix = "_profile";

    /// <summary>Every suffix that identifies an entity as belonging to a Huckleberry child.</summary>
    public static readonly string[] AllSuffixes =
        [SleepSuffix, NursingSuffix, BottleSuffix, DiaperSuffix, GrowthSuffix, ProfileSuffix];

    /// <summary>Integration-level entity listing every child — the preferred discovery source.</summary>
    public const string ChildrenSensor = "sensor.huckleberry_children";
    public const string Children = "children";

    // --- timers (sleep + nursing share this shape) ---
    /// <summary>Start of the last <em>completed</em> session. Present even when idle.</summary>
    public const string PreviousStart = "previous_start";
    /// <summary>ISO-8601 duration of the last completed session, e.g. <c>PT16M12S</c>.</summary>
    public const string PreviousDuration = "previous_duration";

    /// <summary>
    /// Start of the <em>running</em> timer. Only published while the state is <c>active</c> or
    /// <c>paused</c>, which is why it wasn't visible during the idle enumeration.
    /// </summary>
    /// <remarks>
    /// Verified against a live running timer. Preferring this over the entity's
    /// <c>last_changed</c> is load-bearing, not cosmetic: on the observed sample the two differed by
    /// <b>98 seconds</b>, because restarting a timer updates <c>current_start</c> without changing
    /// the state value. A <c>last_changed</c>-based elapsed counter would simply have read wrong.
    /// </remarks>
    public const string CurrentStart = "current_start";

    /// <summary>
    /// Fallbacks for a running timer's start, tried in order after <see cref="CurrentStart"/>, then
    /// the entity's <c>last_changed</c>. Kept as a hedge against an upstream rename.
    /// </summary>
    public static readonly string[] ActiveStartCandidates =
        [CurrentStart, "start", "started_at", "timer_start_time"];

    // --- nursing ---
    public const string PreviousLastSide = "previous_last_side";
    public const string PreviousLeftDuration = "previous_left_duration";
    public const string PreviousRightDuration = "previous_right_duration";

    // --- bottle / diaper (both carry their timestamp as the state value and as `time`) ---
    public const string Time = "time";
    public const string Amount = "amount";
    /// <summary>Plural — the integration publishes <c>units</c>, not <c>unit</c>.</summary>
    public const string AmountUnit = "units";
    public const string EntryType = "type";

    // --- growth (names unconfirmed — nothing logged yet; see remarks) ---
    public const string Weight = "weight";
    public const string Height = "height";
    public const string HeadCircumference = "head_circumference";

    // --- profile ---
    public const string ChildName = "name";
    public const string ChildUid = "uid";
    public const string Birthday = "birthday";
    /// <summary>Hour the child's night begins — pairs with the panel's night-dim / Subdued voice.</summary>
    public const string NightStart = "night_start";
    public const string MorningCutoff = "morning_cutoff";

    // --- state values, from the sensors' own `options` list: ["active","paused","none"] ---
    /// <summary>A timer is running. (Was <c>sleeping</c> before integration v0.4.0.)</summary>
    public const string StateActive = "active";
    public const string StatePaused = "paused";
    /// <summary>No timer running — a real answer, not an unavailable entity.</summary>
    public const string StateNone = "none";
}
