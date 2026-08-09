namespace HomeHub.Api.Pantry;

using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// The only thing that changes a <see cref="PantryItem"/>. Every mutation writes a
/// <see cref="PantryEvent"/> in the same breath, because the ledger is not an audit trail bolted on
/// beside the state — it <i>is</i> the state, and four screens read nothing else
/// (PANTRY_DATA_CONTRACT §1).
/// </summary>
/// <remarks>
/// Controllers never set <see cref="PantryItem.Quantity"/> or
/// <see cref="PantryItem.EstimateState"/> directly. If they did, the item and its history would
/// drift apart and the panel would go on saying "the pantry last saw 2, six days ago" about a
/// number nobody ever saw.
/// </remarks>
public sealed class PantryLedger
{
    private readonly HomeHubDbContext _db;
    private readonly TimeProvider _clock;

    public PantryLedger(HomeHubDbContext db, TimeProvider clock)
    {
        _db = db;
        _clock = clock;
    }

    /// <summary>
    /// Record something that happened to an item and apply it. The item is mutated in the tracked
    /// graph; the caller still owns <c>SaveChangesAsync</c> so a batch (an import, a deduction)
    /// commits as one unit.
    /// </summary>
    /// <param name="delta">Signed movement, for a counted item. Ignored when <paramref name="setQuantity"/> is given.</param>
    /// <param name="setQuantity">An absolute count somebody observed, rather than a movement.</param>
    /// <param name="setState">An absolute estimate, for an estimated item.</param>
    public PantryEvent Record(
        PantryItem item,
        PantryEventKind kind,
        int? byProfileId,
        decimal? delta = null,
        decimal? setQuantity = null,
        EstimateState? setState = null,
        PantryEventSource? sourceKind = null,
        int? sourceId = null,
        Guid? scanRunId = null,
        int? scanSequence = null)
    {
        var now = _clock.GetUtcNow().UtcDateTime;

        // NotCounted items are never deducted and never move (README, the three tracking classes).
        // A caller asking for one is a bug upstream, but the ledger refuses rather than inventing a
        // number for a thing whose whole definition is that nobody counts it.
        if (item.Tracking == TrackingClass.NotCounted)
        {
            delta = null;
            setQuantity = null;
            setState = null;
        }

        var evt = new PantryEvent
        {
            Item = item,
            PantryItemId = item.Id,
            Kind = kind,
            AtUtc = now,
            ByProfileId = byProfileId,
            SourceKind = sourceKind,
            SourceId = sourceId,
            ScanRunId = scanRunId,
            ScanSequence = scanSequence,
        };

        if (item.Tracking == TrackingClass.Counted)
        {
            if (setQuantity is { } target)
            {
                evt.SetsAbsolute = true;
                evt.ResultingQuantity = Floor(target);
                evt.Delta = evt.ResultingQuantity - (item.Quantity ?? 0);
            }
            else
            {
                evt.Delta = delta ?? 0;
                evt.ResultingQuantity = Floor((item.Quantity ?? 0) + evt.Delta.Value);
            }
            item.Quantity = evt.ResultingQuantity;
        }
        else if (item.Tracking == TrackingClass.Estimated)
        {
            // An estimate is an observation, not arithmetic — each event carries the whole answer.
            evt.ResultingState = setState ?? item.EstimateState ?? Pantry.EstimateState.Plenty;
            item.EstimateState = evt.ResultingState;
        }

        item.UpdatedUtc = now;
        _db.PantryEvents.Add(evt);
        item.Events.Add(evt);
        return evt;
    }

    /// <summary>
    /// Reverse one event by writing a compensating <see cref="PantryEventKind.Undone"/> event and
    /// replaying what survives.
    /// </summary>
    /// <remarks>
    /// History is never rewritten or deleted (PANTRY_BEHAVIOURS §3). That is not tidiness: it is the
    /// only way <c>lastSeenAt</c> can revert to the previous event's timestamp instead of jumping to
    /// "now", which the spec calls out explicitly — an undo that made the panel claim it had just
    /// seen the shelf would be the panel lying about the one thing it is supposed to hedge.
    /// </remarks>
    /// <returns>False when the event does not exist or was already undone.</returns>
    public async Task<bool> UndoAsync(int eventId, int? byProfileId, CancellationToken ct)
    {
        var target = await _db.PantryEvents
            .Include(e => e.Item)
            .FirstOrDefaultAsync(e => e.Id == eventId, ct);
        if (target?.Item is null) return false;
        if (target.UndoneByEventId is not null || target.Kind == PantryEventKind.Undone) return false;

        var now = _clock.GetUtcNow().UtcDateTime;
        var compensating = new PantryEvent
        {
            PantryItemId = target.PantryItemId,
            Item = target.Item,
            Kind = PantryEventKind.Undone,
            AtUtc = now,
            ByProfileId = byProfileId,
            SourceKind = target.SourceKind,
            SourceId = target.SourceId,
        };
        _db.PantryEvents.Add(compensating);
        await _db.SaveChangesAsync(ct);

        // Saved *before* the replay, deliberately. `ReplayAsync` runs a LINQ query, which is
        // answered by the store rather than by the change tracker — so an unsaved
        // `UndoneByEventId` is invisible to it and the replay counts the very event it is meant to
        // be reversing. The symptom is an undo that silently does nothing.
        target.UndoneByEventId = compensating.Id;
        await _db.SaveChangesAsync(ct);

        await ReplayAsync(target.Item, ct);
        await _db.SaveChangesAsync(ct);
        return true;
    }

    /// <summary>
    /// Recompute an item's state from the events that still stand.
    /// </summary>
    /// <remarks>
    /// Cheap enough to be the simple answer: a household item accumulates a few hundred events over
    /// years, and this runs only on undo. The alternative — subtracting the undone event's delta
    /// from the current value — silently disagrees with the ledger the moment an absolute count sits
    /// after the event being reversed.
    /// </remarks>
    private async Task ReplayAsync(PantryItem item, CancellationToken ct)
    {
        var events = await _db.PantryEvents
            .Where(e => e.PantryItemId == item.Id && e.UndoneByEventId == null && e.Kind != PantryEventKind.Undone)
            .OrderBy(e => e.AtUtc).ThenBy(e => e.Id)
            .ToListAsync(ct);

        if (item.Tracking == TrackingClass.Counted)
        {
            decimal quantity = 0;
            foreach (var e in events)
            {
                if (e.SetsAbsolute) quantity = e.ResultingQuantity ?? quantity;
                else quantity = Floor(quantity + (e.Delta ?? 0));
            }
            item.Quantity = quantity;
        }
        else if (item.Tracking == TrackingClass.Estimated)
        {
            item.EstimateState = events.LastOrDefault(e => e.ResultingState is not null)?.ResultingState
                ?? Pantry.EstimateState.Plenty;
        }
    }

    /// <summary>
    /// When each item was last actually seen — <b>derived, never stored</b>.
    /// </summary>
    /// <remarks>
    /// Undone events do not count, which is what makes the age honest after an undo. An item with no
    /// surviving event has never been seen, and the row says exactly that (<c>NEVER SEEN</c>) rather
    /// than falling back to when the row was created.
    /// </remarks>
    public async Task<Dictionary<int, DateTime>> LastSeenAsync(IReadOnlyList<int> itemIds, CancellationToken ct)
    {
        if (itemIds.Count == 0) return [];
        return await _db.PantryEvents
            .Where(e => itemIds.Contains(e.PantryItemId)
                && e.UndoneByEventId == null
                && e.Kind != PantryEventKind.Undone)
            .GroupBy(e => e.PantryItemId)
            .Select(g => new { ItemId = g.Key, At = g.Max(e => e.AtUtc) })
            .ToDictionaryAsync(x => x.ItemId, x => x.At, ct);
    }

    /// <summary>
    /// Move an estimated item one step down: plenty → low → none. <b>Never two</b> (§2, deduction
    /// rules) — the whole point of an estimate is that the panel does not know how much a recipe
    /// took out of it, so taking two steps would be inventing precision in the one class defined by
    /// its absence.
    /// </summary>
    public static EstimateState StepDown(EstimateState? from) => from switch
    {
        Pantry.EstimateState.None => Pantry.EstimateState.None,
        Pantry.EstimateState.Low => Pantry.EstimateState.None,
        _ => Pantry.EstimateState.Low,
    };

    /// <summary>Counts floor at zero — a shelf cannot hold minus one tin.</summary>
    private static decimal Floor(decimal value) => value < 0 ? 0 : decimal.Round(value, 3);
}
