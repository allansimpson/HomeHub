namespace HomeHub.Api.Pantry;

/// <summary>
/// The ledger. One row per thing that ever happened to a <see cref="PantryItem"/>.
/// </summary>
/// <remarks>
/// <b>Not optional</b> (PANTRY_DATA_CONTRACT §1). Four separate surfaces are reads of this table and
/// nothing else: the <c>SEEN 6 D</c> column on 9a, the run-list undo on 9c, the receipt undo on 9f,
/// and the evidence sentences on 9b ("the pantry last saw 2, six days ago"). Deriving any of them
/// from the item row alone is exactly what would make the panel sound certain when it isn't — the
/// one failure mode DECISIONS P9 rules out.
/// <para>
/// Undo writes a <see cref="PantryEventKind.Undone"/> event and stamps
/// <see cref="UndoneByEventId"/> on the original; it never deletes or rewrites a row. That is what
/// lets <c>lastSeenAt</c> fall back to the previous event's timestamp instead of jumping to "now" —
/// PANTRY_BEHAVIOURS §3 is explicit that an undo must leave the age honest.
/// </para>
/// </remarks>
public class PantryEvent
{
    public int Id { get; set; }

    public int PantryItemId { get; set; }
    public PantryItem? Item { get; set; }

    public PantryEventKind Kind { get; set; }

    /// <summary>How much moved, signed. Null for events that changed an estimate rather than a count.</summary>
    public decimal? Delta { get; set; }

    /// <summary>The item's count immediately after this event — so a receipt can render `6 → none`
    /// without replaying the whole ledger.</summary>
    public decimal? ResultingQuantity { get; set; }

    /// <summary>
    /// Whether this event <i>set</i> the count rather than moved it — "we've got three" as opposed
    /// to "three came out". <see cref="ResultingQuantity"/> is the target when true.
    /// </summary>
    /// <remarks>
    /// The distinction only matters under undo, and there it matters completely. Reversing an event
    /// is a replay of everything that survives it (<c>PantryLedger.Replay</c>), and a replay of pure
    /// deltas cannot express "someone counted the shelf and it was three" — undoing an earlier
    /// delivery would silently drag that count down with it, rewriting an observation somebody
    /// actually made.
    /// </remarks>
    public bool SetsAbsolute { get; set; }

    /// <summary>The item's estimate immediately after this event.</summary>
    public EstimateState? ResultingState { get; set; }

    public DateTime AtUtc { get; set; }

    /// <summary>Who did it. An id, not a relationship — a removed profile must not take the ledger
    /// with it, and the read path treats an unresolvable id as "someone".</summary>
    public int? ByProfileId { get; set; }

    /// <summary>What caused it, so a whole import or a whole night can be reversed as a unit.</summary>
    public PantryEventSource? SourceKind { get; set; }
    public int? SourceId { get; set; }

    /// <summary>
    /// Set on the *original* event when it has been reversed. A non-null value means this event no
    /// longer counts towards the item's state or its last-seen age.
    /// </summary>
    public int? UndoneByEventId { get; set; }

    /// <summary>
    /// Idempotency key for scanning (§2, <c>POST /api/pantry/scan</c>). Two phones unpacking the
    /// same delivery both add; the same phone retrying a request does not (DECISIONS PG7).
    /// </summary>
    public Guid? ScanRunId { get; set; }

    /// <summary>Position within a scan run, unique with <see cref="ScanRunId"/>.</summary>
    public int? ScanSequence { get; set; }
}
