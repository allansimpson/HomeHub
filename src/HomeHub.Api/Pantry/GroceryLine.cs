namespace HomeHub.Api.Pantry;

/// <summary>
/// One line on the household's grocery list (PANTRY_DATA_CONTRACT §1).
/// </summary>
/// <remarks>
/// <b>HomeHub owns this list; Microsoft To Do is a projection of it</b> (DECISIONS P8). Meals and the
/// pantry belong to the household, but To Do lists belong to a signed-in profile, and owning the
/// list locally is the only arrangement that survives that mismatch. It also buys two things a
/// mirrored list cannot carry: provenance ("Chicken Piccata · Wed") and the return trip, where
/// ticking a line puts stock back.
/// </remarks>
public class GroceryLine
{
    public int Id { get; set; }

    /// <summary>What the row reads. For a pantry-linked line this is the item's name at the time it
    /// was added — renaming the item later does not rewrite the shopping list in someone's hand.</summary>
    public string Text { get; set; } = string.Empty;

    public decimal? Quantity { get; set; }
    public string? Unit { get; set; }

    /// <summary>Set when the line came from a shortfall or a low item — the hook for the return trip.</summary>
    public int? PantryItemId { get; set; }
    public PantryItem? Item { get; set; }

    public GroceryLineSource SourceKind { get; set; } = GroceryLineSource.Hand;

    public DateTime CreatedUtc { get; set; }
    public int? AddedByProfileId { get; set; }

    public DateTime? CheckedAtUtc { get; set; }
    public int? CheckedByProfileId { get; set; }

    /// <summary>
    /// Graph task id, for the mirror. The dedupe key in both directions — PANTRY_BEHAVIOURS §8 is
    /// explicit that the mirror may never drop a line nor silently duplicate one.
    /// </summary>
    public string? TodoTaskId { get; set; }

    /// <summary>
    /// Set when the line has local changes the mirror has not yet pushed. Survives a restart, which
    /// is what makes "3 changes will go up when it's back" a fact rather than a hope.
    /// </summary>
    public bool MirrorPending { get; set; }

    public int Version { get; set; } = 1;

    /// <summary>
    /// Every night that wants this line. Two nights needing lemons is <b>one row with two
    /// provenances</b>, not two rows (§1, the lemons row on 9e).
    /// </summary>
    public List<GroceryLineSourceRef> Sources { get; } = [];
}

/// <summary>
/// One night's claim on a grocery line. Several of these hang off a merged row and render as
/// `Chicken Piccata · Wed  ·  Sheet-pan salmon · Fri`.
/// </summary>
public class GroceryLineSourceRef
{
    public int Id { get; set; }

    public int GroceryLineId { get; set; }
    public GroceryLine? Line { get; set; }

    /// <summary>The recipe that needs it. Null for a hand-added line, which names a person instead.</summary>
    public int? RecipeId { get; set; }

    /// <summary>Kept as text so a deleted recipe leaves the shopping list readable — the same
    /// degradation the meal plan uses when a planned recipe is removed.</summary>
    public string? RecipeTitle { get; set; }

    /// <summary>The night that needs it. Date-ascending is the render order (§3).</summary>
    public DateOnly? ForDate { get; set; }

    /// <summary>Who added it, for a hand-added line's `Eleanor · Tuesday`.</summary>
    public int? ByProfileId { get; set; }

    public DateTime CreatedUtc { get; set; }
}

/// <summary>
/// Which To Do list the household mirrors into, and who owns the token that does it
/// (PANTRY_DATA_CONTRACT §4). A single row, id 1.
/// </summary>
/// <remarks>
/// Stored per <b>household</b>, not per profile, because the list is the household's — but the Graph
/// call has to be made by *somebody*, so <see cref="OwnerProfileId"/> names whose link does the
/// syncing. If that profile is removed the strip goes amber and asks for a new owner rather than the
/// mirror silently stopping.
/// </remarks>
public class GroceryMirrorSettings
{
    public int Id { get; set; } = 1;

    /// <summary>Null = mirroring off, which is a supported state (PANTRY_BEHAVIOURS §8).</summary>
    public string? TodoListId { get; set; }
    public string? TodoListName { get; set; }
    public int? OwnerProfileId { get; set; }

    /// <summary>When the mirror last completed a round trip. Drives "2 minutes ago" on the strip.</summary>
    public DateTime? LastSyncedUtc { get; set; }

    /// <summary>When it last tried, successfully or not. Drives "Last tried 4 minutes ago".</summary>
    public DateTime? LastAttemptUtc { get; set; }

    /// <summary>Null when healthy. A short sentence when not — shown verbatim on the amber strip.</summary>
    public string? LastError { get; set; }

    /// <summary>Consecutive failures, for the exponential backoff to a 30-minute ceiling (§8).</summary>
    public int ConsecutiveFailures { get; set; }
}
