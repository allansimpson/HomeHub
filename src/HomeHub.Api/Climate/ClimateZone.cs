namespace HomeHub.Api.Climate;

using HomeHub.Api.Sensors;

/// <summary>
/// A room (or an appliance) as the household names it: one probe, optionally one unit, and — for the
/// three rooms that have both — the standing target a person owns.
/// </summary>
/// <remarks>
/// <b>The probe is the truth; the set point is the machine's business.</b> A mini-split holds its own
/// return-air temperature, which is the air beside the unit rather than the temperature of the room,
/// so the number on the unit is not one anyone should be managing by hand. HomeHub reads this zone's
/// SensorPush probe and moves the Sensibo set point itself, as often as it needs to, to make the
/// <em>probe</em> read <see cref="StandingTargetF"/>.
/// <para>
/// That splits one number into two and the whole section follows from keeping them apart:
/// <see cref="StandingTargetF"/> is what the household wants and appears on the row in brass;
/// <see cref="ClimateUnit.SetPointF"/> is what the unit is currently told to do and appears only in
/// the drill-in, as a fact.
/// </para>
/// </remarks>
public class ClimateZone
{
    public int Id { get; set; }

    /// <summary>Display name, e.g. "Master Bedroom".</summary>
    public required string Name { get; set; }

    /// <summary>Automated, Watched or ColdStorage — what the UI branches on.</summary>
    public ZoneClass Class { get; set; }

    /// <summary>The SensorPush probe that reads this room. Null until one is bound.</summary>
    public int? SensorZoneId { get; set; }
    public SensorZone? SensorZone { get; set; }

    /// <summary>The mini-split that conditions it. <see cref="ZoneClass.Automated"/> only.</summary>
    public int? ClimateUnitId { get; set; }
    public ClimateUnit? ClimateUnit { get; set; }

    /// <summary>
    /// THE number a person owns: what the household wants this room to be, until someone changes it.
    /// </summary>
    /// <remarks>
    /// There is deliberately no schedule behind this — one standing target per room, and the two-hour
    /// loan (<see cref="ZoneOverride"/>) covers the real case, which is "it's too warm <em>now</em>"
    /// (DECISIONS §3).
    /// </remarks>
    public double? StandingTargetF { get; set; }

    /// <summary>When <see cref="StandingTargetF"/> last changed — the "SINCE 5:06" on a promoted row.</summary>
    public DateTime? StandingSetAtUtc { get; set; }

    /// <summary>
    /// What <see cref="StandingTargetF"/> was before the last promotion, so <c>UNDO</c> can restore
    /// the <em>exact</em> previous value rather than an approximation of it.
    /// </summary>
    /// <remarks>
    /// Stored rather than held in the client's session because 3b hides a permanent change inside a
    /// gesture, and the way out of that has to survive a reload of the panel
    /// (CLIMATE_BEHAVIOURS §6).
    /// </remarks>
    public double? PreviousStandingTargetF { get; set; }

    /// <summary>±°F the probe may sit from the target and still count as holding. 0.5 / 1 / 2.</summary>
    public double ToleranceF { get; set; } = 1;

    public CorrectionStrength Correction { get; set; } = CorrectionStrength.Steady;

    /// <summary>Start of the nightly window in which the loop reads but does not write.</summary>
    public TimeSpan QuietFrom { get; set; } = new(22, 0, 0);

    /// <summary>End of that window. The loop writes once here to re-establish the target.</summary>
    public TimeSpan QuietTo { get; set; } = new(6, 0, 0);

    /// <summary>Room pause. The loop stops writing and leaves the unit exactly as it is.</summary>
    public bool IsPaused { get; set; }

    /// <summary>When the pause began — the row reads "PAUSED 1H AGO · UNIT LEFT AT 68°".</summary>
    public DateTime? PausedAtUtc { get; set; }

    /// <summary>
    /// Set while the room is running on the unit's own sensor because its probe went quiet. Cleared
    /// on the first reading after recovery, subject to the flapping rule.
    /// </summary>
    public DateTime? HandedBackAtUtc { get; set; }

    /// <summary>
    /// When the current run of failed writes began, or null when the last attempt succeeded. Drives
    /// "SENSIBO UNREACHABLE · RETRYING SINCE 4:58" and, after 30 minutes, the degraded marking.
    /// </summary>
    public DateTime? UnreachableSinceUtc { get; set; }

    /// <summary>
    /// When the repeat-offer was last put in front of the household for this room. At most once per
    /// zone per week, so a heuristic that keeps being right does not become nagging.
    /// </summary>
    public DateTime? OfferShownAtUtc { get; set; }

    /// <summary>Suppressed until — 30 days out after <c>NO, KEEP ASKING</c>. Null when not suppressed.</summary>
    public DateTime? OfferSuppressedUntilUtc { get; set; }

    /// <summary>
    /// Which 3-hour clock window the suppression applies to (the window's first local hour).
    /// </summary>
    /// <remarks>
    /// Zone <em>and</em> window, per the heuristic: declining "make 69° standing in the evening" says
    /// nothing about the same room at eight in the morning, and treating it as a blanket refusal
    /// would throw away the one piece of evidence the offer is built on.
    /// </remarks>
    public int? OfferSuppressedWindowHour { get; set; }

    /// <summary>Cold-storage in-range floor, e.g. 34° for the fridge.</summary>
    public double? RangeLowF { get; set; }

    /// <summary>Cold-storage in-range ceiling, e.g. 40° for the fridge.</summary>
    public double? RangeHighF { get; set; }

    public int SortOrder { get; set; }
}
