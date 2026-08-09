namespace HomeHub.Api.Climate;

/// <summary>
/// Everything the Climate screen renders, in one call.
/// </summary>
/// <remarks>
/// One request, deliberately: six rows that each fetched their own reading, override and last write
/// would be eighteen round trips for a screen the panel polls continuously, and the rows would drift
/// out of step with one another while it happened (CLIMATE_DATA_CONTRACT §3).
/// </remarks>
public record ClimatePanelDto(
    /// <summary>The whole-house pause. Survives a restart and never expires on its own.</summary>
    bool HousePaused,
    /// <summary>Rows in list order — an alarming cold-storage row sorts to the top.</summary>
    IReadOnlyList<ClimateZoneDto> Zones,
    /// <summary>The repeat-offer, when one has earned its way onto the screen. At most one at a time.</summary>
    RepeatOfferDto? Offer,
    /// <summary>When the server built this. The panel measures its own staleness against it.</summary>
    DateTime AtUtc);

/// <summary>
/// One row of the Climate list. Carries state and numbers; the panel composes the sentences.
/// </summary>
/// <remarks>
/// The split is on purpose. Every string on the row is locked design copy that has to change colour
/// with its clause and tick between polls ("STEADY 3H 20M" is a duration, not a caption), so the
/// wording belongs next to the tokens that colour it. What the server owes the panel is <em>which
/// state the room is in</em> and the numbers behind it — questions only the ledger can answer.
/// </remarks>
public record ClimateZoneDto(
    int Id,
    string Name,
    /// <summary>"Automated" · "Watched" · "ColdStorage".</summary>
    string Class,
    /// <summary>
    /// The probe, in °F — or null when it is silent. A reading older than fifteen minutes is
    /// <b>not</b> sent: a temperature without a fresh timestamp is a lie told confidently
    /// (CLIMATE_BEHAVIOURS §8).
    /// </summary>
    double? ReadingF,
    double? Humidity,
    DateTime? ReadingAtUtc,
    /// <summary>Minutes since the last reading, when the probe has gone quiet. Null while it is fine.</summary>
    int? ProbeSilentMinutes,
    /// <summary>The number a person owns. Null on watched and cold-storage rows.</summary>
    double? StandingTargetF,
    DateTime? StandingSetAtUtc,
    /// <summary>What the effective target actually is right now: the loan's, or the standing one.</summary>
    double? TargetF,
    double ToleranceF,
    /// <summary>"Gentle" · "Steady" · "Hard".</summary>
    string Correction,
    /// <summary>Local time-of-day, "22:00".</summary>
    string QuietFrom,
    string QuietTo,
    bool IsPaused,
    DateTime? PausedAtUtc,
    /// <summary>The live two-hour loan, or null.</summary>
    ZoneOverrideDto? Override,
    /// <summary>
    /// The previous standing target, present for as long as <c>UNDO</c> should be on the row.
    /// </summary>
    /// <remarks>
    /// Server-held rather than remembered by the panel: 3b hides a permanent change inside a gesture,
    /// and a way out that a page reload destroys is not a way out (CLIMATE_BEHAVIOURS §6).
    /// </remarks>
    double? PreviousStandingTargetF,
    /// <summary>
    /// The row's state, which decides both the sentence and its colour:
    /// <c>holding</c> · <c>correcting</c> · <c>cantHold</c> · <c>borrowed</c> · <c>backOn</c> ·
    /// <c>standing</c> · <c>probeLost</c> · <c>paused</c> · <c>quiet</c> · <c>unreachable</c> ·
    /// <c>unitOff</c> · <c>noProbe</c> · <c>inRange</c> · <c>outOfRange</c> · <c>watched</c>.
    /// </summary>
    string State,
    /// <summary>Since the last correcting write — the duration in "HOLDING · STEADY 3H 20M".</summary>
    DateTime? SteadySinceUtc,
    /// <summary>
    /// Local clock estimate of when the probe reaches the target, "5:24". Omitted rather than
    /// guessed when there is under twenty minutes of data to read a rate from.
    /// </summary>
    string? EtaLocal,
    /// <summary>Whether the room is above the target (cooling) or below it (warming).</summary>
    bool? Above,
    /// <summary>How far outside tolerance, rounded — the "4°" in "4° OVER FOR 40M".</summary>
    double? DeviationF,
    /// <summary>How long it has been outside tolerance — the "40M".</summary>
    int? OutsideMinutes,
    /// <summary>When the current run of failed writes began. Drives "RETRYING SINCE 4:58".</summary>
    DateTime? UnreachableSinceUtc,
    /// <summary>Thirty minutes of failed writes: the room is degraded and wants a person.</summary>
    bool Degraded,
    /// <summary>When a loan ended, for the hour the row reads "BACK ON 71° SINCE 7:04".</summary>
    DateTime? OverrideEndedAtUtc,
    /// <summary>SensorPush says the probe's battery is low. Appends a clause; nothing else.</summary>
    bool LowBattery,
    /// <summary>Cold storage: the in-range band, e.g. 34–40°.</summary>
    double? RangeLowF,
    double? RangeHighF,
    /// <summary>Cold storage: how long it has been out of range. Ten minutes is the alarm.</summary>
    int? OutOfRangeMinutes,
    /// <summary>°F per hour over the last half hour. Omitted under 0.4°/h — stable is a different problem.</summary>
    double? RatePerHour,
    /// <summary>The unit's own set point, for the drill-in only. Never rendered on a row.</summary>
    double? UnitSetPointF,
    /// <summary>"Cool" · "Heat" · "Fan" · "Auto" · "Off". Drill-in only.</summary>
    string? UnitMode,
    /// <summary>The probe's own id and the unit's HA entity id, for the drill-in sub-line.</summary>
    string? ProbeRef,
    string? UnitRef,
    /// <summary>The sensor zone behind the probe — where `24H ▸` and a watched row's tap go.</summary>
    int? SensorZoneId,
    /// <summary>The last thing the loop actually did here.</summary>
    LoopWriteDto? LastWrite);

/// <summary>A live two-hour loan.</summary>
public record ZoneOverrideDto(double TargetF, DateTime StartedAtUtc, DateTime ExpiresAtUtc);

/// <summary>One line of the ledger, as the drill-in shows it.</summary>
public record LoopWriteDto(
    long Id,
    DateTime AtUtc,
    double? ProbeF,
    double TargetF,
    double? SetPointFrom,
    double SetPointTo,
    string Reason,
    string Outcome,
    string? Error)
{
    public static LoopWriteDto From(LoopWrite w) => new(
        w.Id, w.AtUtc, w.ProbeF, w.TargetF, w.SetPointFrom, w.SetPointTo,
        w.Reason.ToString(), w.Outcome.ToString(), w.Error);
}

/// <summary>
/// "You've cooled the Master Bedroom to about 69° three evenings running. Make it standing?"
/// </summary>
/// <remarks>
/// A bordered block under the zone's row — never a modal, never a notification. This is how a
/// schedule earns its way in from evidence rather than being configured up front (DECISIONS §3).
/// </remarks>
public record RepeatOfferDto(int ZoneId, string ZoneName, double TargetF, int WindowHour);

/// <summary>The standing target, in °F. Written by the drill-in stepper and by promotion.</summary>
public record SetTargetInput(double TargetF);

/// <summary>Start a two-hour loan at this target.</summary>
public record OverrideInput(double TargetF);

/// <summary>
/// Keep it. Empty body for 3a (promote the loan that is running); a target for 3b, which lifts on
/// <c>KEEP</c> without ever having released one.
/// </summary>
public record PromoteInput(double? TargetF);

/// <summary>The four per-room knobs. Every field is optional; only what is sent is changed.</summary>
public record PatchZoneInput(
    double? ToleranceF,
    CorrectionStrength? Correction,
    string? QuietFrom,
    string? QuietTo,
    bool? IsPaused);

/// <summary>Pause or resume the whole house.</summary>
public record PauseHouseInput(bool Paused);

/// <summary>Accept or decline a repeat-offer. Declining suppresses that zone/window for 30 days.</summary>
public record OfferReplyInput(bool Accept);
