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

    /// <summary>
    /// An administrator has deliberately accepted an unclean lineage.
    /// </summary>
    /// <remarks>
    /// <b>Manual deletion only.</b> Background retention stays paused: somebody accepting a named
    /// risk for a conversation they are deleting is a decision, and a timer quietly acting on that
    /// acceptance for every conversation in the household for ever is not the same decision. The
    /// distinction is the whole reason this is a separate state rather than an alias for Clean.
    /// </remarks>
    RiskAccepted = 3,
}
