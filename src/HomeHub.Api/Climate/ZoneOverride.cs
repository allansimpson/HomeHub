namespace HomeHub.Api.Climate;

/// <summary>
/// The two-hour loan: a target borrowed from the row, which expires on its own.
/// </summary>
/// <remarks>
/// This is the rule that makes one-tap adjustment safe. Because everything done from the list
/// expires <em>and says when</em>, a passing adjustment can never quietly redefine what a room is
/// for — which is why the control can sit right on the row with no confirmation step in front of it
/// (DECISIONS §4).
/// <para>
/// At most one live override per zone; a new one supersedes the old. <see cref="PromotedAtUtc"/> is
/// what distinguishes "they borrowed it and kept it" from "it expired", and the repeat-offer
/// heuristic reads that column and nothing else.
/// </para>
/// </remarks>
public class ZoneOverride
{
    public int Id { get; set; }

    public int ZoneId { get; set; }
    public ClimateZone? Zone { get; set; }

    public double TargetF { get; set; }

    public DateTime StartedAtUtc { get; set; }

    /// <summary><see cref="StartedAtUtc"/> + 2h.</summary>
    public DateTime ExpiresAtUtc { get; set; }

    /// <summary>Who borrowed it. Null when nobody was signed in at the panel.</summary>
    public int? ByProfileId { get; set; }

    /// <summary>Set when 3a's <c>KEEP</c> or 3b's lift-on-keep promoted this loan to standing.</summary>
    public DateTime? PromotedAtUtc { get; set; }

    /// <summary>Set when a later loan superseded this one, or when <c>UNDO</c> cancelled it.</summary>
    public DateTime? CancelledAtUtc { get; set; }

    /// <summary>
    /// Set once the loop has written the standing target back after this loan expired.
    /// </summary>
    /// <remarks>
    /// Expiry is a time, but putting the room back is an <em>act</em>, and the two are not the same
    /// moment — the panel can be offline when the clock passes <see cref="ExpiresAtUtc"/>. This is
    /// what stops the loop re-writing the same ending over and over on every tick afterwards.
    /// </remarks>
    public DateTime? ClosedAtUtc { get; set; }

    /// <summary>Live means started, not yet expired, not promoted and not cancelled.</summary>
    public bool IsLiveAt(DateTime nowUtc) =>
        PromotedAtUtc is null && CancelledAtUtc is null && StartedAtUtc <= nowUtc && ExpiresAtUtc > nowUtc;
}
