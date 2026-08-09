namespace HomeHub.Api.Climate;

/// <summary>
/// The ledger: one row per attempt the loop made, including the ones that failed and the ones that
/// deliberately did nothing.
/// </summary>
/// <remarks>
/// <b>Not optional.</b> "Last write" in the drill-in, "STEADY 3H 20M" on the row, "RETRYING SINCE
/// 4:58" and every other sentence the loop speaks are reads of this table. It is also the only way
/// to answer <em>"why was the bedroom cold last night"</em> after the fact, which is the question
/// this whole section exists to make answerable (CLIMATE_DATA_CONTRACT §1).
/// </remarks>
public class LoopWrite
{
    public long Id { get; set; }

    public int ZoneId { get; set; }
    public ClimateZone? Zone { get; set; }

    public DateTime AtUtc { get; set; }

    /// <summary>The probe reading that caused it. Null when the probe is the thing that went missing.</summary>
    public double? ProbeF { get; set; }

    /// <summary>The effective target at the time: the live override's, or the standing one.</summary>
    public double TargetF { get; set; }

    /// <summary>What the unit was reporting before the call. Null when the unit could not be read.</summary>
    public double? SetPointFrom { get; set; }

    public double SetPointTo { get; set; }

    public LoopWriteReason Reason { get; set; }

    public LoopWriteOutcome Outcome { get; set; }

    /// <summary>The failure, in the provider's words. Null on success.</summary>
    public string? Error { get; set; }
}
