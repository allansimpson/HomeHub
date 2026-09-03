namespace HomeHub.Api.Settings;

/// <summary>
/// How much is known about this database's historical Hermes lineage, and what that permits.
/// </summary>
/// <remarks>
/// Four states rather than a flag, because "has somebody looked" and "is it safe to delete" are
/// different questions and an earlier version answered the second with the first. Deleting a
/// conversation destroys the only local anchor by which an unenumerated intermediate transcript could
/// be found, so the permission has to follow the knowledge rather than the acknowledgement.
/// </remarks>
public enum LineageState
{
    /// <summary>Nobody has reconciled this database. Retention paused, deletion refused.</summary>
    NotAudited = 0,

    /// <summary>
    /// Reconciled and unclean. Retention paused, deletion refused — and it stays that way.
    /// </summary>
    /// <remarks>
    /// A dead end until a backfill exists, and deliberately so. If HomeHub cannot prove that all
    /// historical lineage is known, the local rows are the recovery anchors and must be retained.
    /// </remarks>
    Blocked = 1,

    /// <summary>Reconciled and clean. Retention and deletion proceed normally.</summary>
    Clean = 2,

    /*
     * `RiskAccepted` was a fourth state here and it was the wrong shape.
     *
     * A state is durable and household-wide, which is exactly what an acceptance must not be: it
     * authorised every later deletion from one reading of one report. Acceptance is a scoped,
     * expiring, single-use row instead — `LineageRiskAcceptance` — so the household's *state* stays
     * `Blocked` and each destructive act is separately authorised against the evidence current at the
     * time. Retention reads this enum and therefore can never be released by an acceptance at all.
     */
}
