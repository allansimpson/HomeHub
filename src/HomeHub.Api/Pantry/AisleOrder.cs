namespace HomeHub.Api.Pantry;

/// <summary>
/// One aisle's position in the order the household walks a particular shop
/// (SETTINGS_AND_IMPORT §2, KITCHEN_LOOP_ADDENDUM §6).
/// </summary>
/// <remarks>
/// <para>
/// <b>Per shop, deliberately.</b> The addendum first described a single household-wide
/// <c>aisleOrder</c>; the locked settings spec supersedes it with store chips on S2, because a
/// butcher is not a supermarket and one order cannot serve both. Modelled as rows rather than an
/// array on the settings row so an aisle can be reordered without rewriting the list, and so the
/// unique index below can do the work of keeping one aisle in one place per shop.
/// </para>
/// <para>
/// <b>The order is a guess and dragging always wins</b> (S2, <c>HOW IT WAS LEARNED</c>). The seed
/// comes from what got ticked off first, across whatever shops the household has used; every row
/// here is overwritable and none of it is inferred again once a person has moved it.
/// </para>
/// <para>
/// Aisles the order does not name are not an error — they sort last under <c>ELSEWHERE</c>, and
/// an aisle with nothing in it stays listed reading <c>empty</c> rather than vanishing. An order you
/// can only half see is one you cannot correct.
/// </para>
/// </remarks>
public class AisleOrderEntry
{
    public int Id { get; set; }

    /// <summary>The shop this ordering belongs to — "Tesco", "Butcher".</summary>
    public string Store { get; set; } = string.Empty;

    /// <summary>The aisle as the household names it — "Produce", "Chilled".</summary>
    public string Aisle { get; set; } = string.Empty;

    /// <summary>Position in the walk, from the door. Contiguous from zero after any reorder.</summary>
    public int Position { get; set; }

    public DateTime UpdatedUtc { get; set; }
}

/// <summary>The walk order for one shop, first aisle to last.</summary>
public record AisleOrderDto(string Store, IReadOnlyList<AisleOrderLineDto> Aisles);

/// <summary>
/// One aisle and how many open list lines currently fall in it — the count S2 shows beside each
/// row, so a reorder can be judged against what is actually in the basket.
/// </summary>
public record AisleOrderLineDto(string Aisle, int Position, int LineCount);

/// <summary>Replace a shop's walk order. Array order is the new order; positions are not sent.</summary>
/// <remarks>
/// Sent whole rather than as a move-this-one delta: a drag reorders the list, and replaying a
/// sequence of deltas is how two people dragging at once produce an order neither chose.
/// </remarks>
public record AisleOrderInput(IReadOnlyList<string> Aisles);
