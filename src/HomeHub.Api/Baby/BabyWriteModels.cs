namespace HomeHub.Api.Baby;

/// <summary>Which timer an action applies to.</summary>
public enum BabyTimerKind
{
    Sleep,
    Nursing,
}

/// <summary>
/// What to do to a timer. <see cref="Cancel"/> and <see cref="Complete"/> are genuinely different
/// upstream: cancel saves no interval, complete writes it to history. The panel must not conflate
/// them — and note that toggling the HA <c>switch</c> entity performs a <em>complete</em>, which is
/// why timer control goes through these services instead.
/// </summary>
public enum BabyTimerAction
{
    Start,
    Pause,
    Resume,
    Cancel,
    Complete,
    /// <summary>Nursing only.</summary>
    SwitchSide,
}

public enum NursingSide
{
    Left,
    Right,
}

public enum DiaperKind
{
    Pee,
    Poo,
    Both,
    Dry,
}

public enum DiaperAmount
{
    Little,
    Medium,
    Big,
}

public enum PooColor
{
    Yellow,
    Brown,
    Black,
    Green,
    Red,
    Gray,
}

public enum PooConsistency
{
    Solid,
    Loose,
    Runny,
    Mucousy,
    Hard,
    Pebbles,
    Diarrhea,
}

public enum BottleType
{
    Formula,
    BreastMilk,
    TubeFeeding,
    CowMilk,
    GoatMilk,
    SoyMilk,
    Other,
}

public enum BottleUnits
{
    Ml,
    Oz,
}

/// <summary>
/// Unit *system* for growth measurements. Upstream takes a system rather than per-field units:
/// metric means kg/cm, imperial means pounds/inches — and imperial pounds are **decimal**, never a
/// pound/ounce pair.
/// </summary>
public enum MeasurementUnits
{
    Metric,
    Imperial,
}

/// <summary>
/// A diaper change. Only <see cref="Kind"/> is required; the detail fields are optional and were
/// verified to exist at Gate H0.2 (the design doc had listed them as unconfirmed).
/// </summary>
/// <remarks>
/// Amounts/colour/consistency are ignored by upstream for kinds that can't carry them — a
/// <see cref="DiaperKind.Dry"/> entry takes only rash and notes.
/// </remarks>
public sealed record DiaperEntry(
    DiaperKind Kind,
    DiaperAmount? PeeAmount = null,
    DiaperAmount? PooAmount = null,
    PooColor? Color = null,
    PooConsistency? Consistency = null,
    bool? DiaperRash = null,
    string? Notes = null);

/// <summary>A bottle feed. Amount and type are both required upstream.</summary>
public sealed record BottleEntry(double Amount, BottleType Type, BottleUnits Units = BottleUnits.Oz);

/// <summary>
/// Growth measurements. Every measurement is optional — logging weight alone is valid — but at
/// least one must be present for the entry to mean anything.
/// </summary>
/// <remarks>
/// <b>Irreversible.</b> The integration exposes no delete or edit service, so a wrong value here is
/// permanent from HomeHub's side and removable only in the Huckleberry app. It also feeds percentile
/// charts. Treat <see cref="Units"/> as safety-critical: sending pounds while claiming metric
/// records a wildly wrong weight that cannot be retracted.
/// </remarks>
public sealed record GrowthEntry(
    double? Weight = null,
    double? Height = null,
    double? Head = null,
    MeasurementUnits Units = MeasurementUnits.Metric)
{
    public bool HasAnyMeasurement => Weight is not null || Height is not null || Head is not null;

    /// <summary>
    /// Builds an imperial entry from pounds and ounces, which is how the household reads weight.
    /// Upstream wants decimal pounds, so ounces fold in as <c>oz / 16</c>.
    /// </summary>
    public static GrowthEntry FromPoundsOunces(int pounds, double ounces, double? heightInches = null, double? headInches = null) =>
        new(pounds + (ounces / 16d), heightInches, headInches, MeasurementUnits.Imperial);
}

/// <summary>
/// Outcome of a write. Writes deliberately do not queue (see the provider), so a failure is
/// surfaced rather than retried — a silently delayed "fell asleep" timestamp is worse than a visible
/// failure.
/// </summary>
public sealed record BabyWriteResult(bool Success, string? Error = null)
{
    public static readonly BabyWriteResult Ok = new(true);
    public static BabyWriteResult Fail(string error) => new(false, error);
}

/// <summary>Maps domain enums onto the exact strings the Huckleberry services accept.</summary>
/// <remarks>
/// Explicit rather than derived from enum names: upstream uses snake_case values
/// (<c>breast_milk</c>, <c>tube_feeding</c>) that don't round-trip from .NET casing. Verified against
/// the live service schema at Gate H0.2.
/// </remarks>
public static class HuckleberryServiceValues
{
    public static string Service(BabyTimerKind timer, BabyTimerAction action) => (timer, action) switch
    {
        (BabyTimerKind.Sleep, BabyTimerAction.Start) => "start_sleep",
        (BabyTimerKind.Sleep, BabyTimerAction.Pause) => "pause_sleep",
        (BabyTimerKind.Sleep, BabyTimerAction.Resume) => "resume_sleep",
        (BabyTimerKind.Sleep, BabyTimerAction.Cancel) => "cancel_sleep",
        (BabyTimerKind.Sleep, BabyTimerAction.Complete) => "complete_sleep",
        (BabyTimerKind.Nursing, BabyTimerAction.Start) => "start_nursing",
        (BabyTimerKind.Nursing, BabyTimerAction.Pause) => "pause_nursing",
        (BabyTimerKind.Nursing, BabyTimerAction.Resume) => "resume_nursing",
        (BabyTimerKind.Nursing, BabyTimerAction.Cancel) => "cancel_nursing",
        (BabyTimerKind.Nursing, BabyTimerAction.Complete) => "complete_nursing",
        (BabyTimerKind.Nursing, BabyTimerAction.SwitchSide) => "switch_nursing_side",
        // Sleep has no side to switch.
        _ => throw new ArgumentOutOfRangeException(nameof(action), $"{action} is not valid for {timer}."),
    };

    /// <summary>Whether this service accepts an optional <c>side</c> field.</summary>
    public static bool AcceptsSide(BabyTimerKind timer, BabyTimerAction action) =>
        timer == BabyTimerKind.Nursing && action is BabyTimerAction.Start or BabyTimerAction.Resume;

    public static string DiaperService(DiaperKind kind) => kind switch
    {
        DiaperKind.Pee => "log_diaper_pee",
        DiaperKind.Poo => "log_diaper_poo",
        DiaperKind.Both => "log_diaper_both",
        DiaperKind.Dry => "log_diaper_dry",
        _ => throw new ArgumentOutOfRangeException(nameof(kind)),
    };

    public static string Side(NursingSide side) => side == NursingSide.Left ? "left" : "right";

    public static string Amount(DiaperAmount amount) => amount switch
    {
        DiaperAmount.Little => "little",
        DiaperAmount.Medium => "medium",
        _ => "big",
    };

    public static string Color(PooColor color) => color.ToString().ToLowerInvariant();

    public static string Consistency(PooConsistency consistency) => consistency.ToString().ToLowerInvariant();

    public static string Bottle(BottleType type) => type switch
    {
        BottleType.Formula => "formula",
        BottleType.BreastMilk => "breast_milk",
        BottleType.TubeFeeding => "tube_feeding",
        BottleType.CowMilk => "cow_milk",
        BottleType.GoatMilk => "goat_milk",
        BottleType.SoyMilk => "soy_milk",
        _ => "other",
    };

    public static string Units(BottleUnits units) => units == BottleUnits.Ml ? "ml" : "oz";

    public static string Units(MeasurementUnits units) => units == MeasurementUnits.Metric ? "metric" : "imperial";

    /// <summary>
    /// Reverse mapping for the read side, which reports the display form (<c>"Breast Milk"</c>) while
    /// writes take the enum (<c>breast_milk</c>). Returns null when unrecognised rather than guessing.
    /// </summary>
    public static BottleType? ParseBottleType(string? display) => display?.Replace(" ", "").ToLowerInvariant() switch
    {
        "formula" => BottleType.Formula,
        "breastmilk" => BottleType.BreastMilk,
        "tubefeeding" => BottleType.TubeFeeding,
        "cowmilk" => BottleType.CowMilk,
        "goatmilk" => BottleType.GoatMilk,
        "soymilk" => BottleType.SoyMilk,
        "other" => BottleType.Other,
        _ => null,
    };
}
