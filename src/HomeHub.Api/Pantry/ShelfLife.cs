namespace HomeHub.Api.Pantry;

/// <summary>
/// What state food is in, which is what actually decides how long it lasts
/// (SETTINGS_AND_IMPORT §1).
/// </summary>
/// <remarks>
/// Grouped by state rather than by aisle, deliberately: how long a jar lasts depends on whether it
/// has been opened, not on where it was sold. An aisle-shaped list would put the opened jar next to
/// the unopened one and imply they are the same question.
/// </remarks>
public enum FoodState
{
    /// <summary>Leafy greens, soft fruit, cut herbs — things that turn on their own.</summary>
    Fresh = 0,

    /// <summary>Milk, raw meat, hard cheese — things the fridge is holding back.</summary>
    Chilled = 1,

    /// <summary>Decanted tins, jars in the fridge, cooked leftovers. The clock starts at opening.</summary>
    Opened = 2,
}

/// <summary>
/// How long the household reckons one kind of food lasts (SETTINGS_AND_IMPORT §1).
/// </summary>
/// <remarks>
/// <para>
/// <b>These decide what floats to the top of <i>worth using soon</i> and nothing else.</b> Never a
/// use-by date, never a notification. The panel says so twice — at the top and above the reset —
/// because a settings screen that does not state its blast radius is one nobody will risk changing.
/// </para>
/// <para>
/// This is the mechanism that lets the section rank freshness while refusing to store expiry dates:
/// an assumption the household can see and correct is honest in a way an inferred date is not.
/// </para>
/// </remarks>
public class ShelfLifeAssumption
{
    public int Id { get; set; }

    /// <summary>The kind of food, in the household's own words — "leafy greens", "hard cheese".</summary>
    public string FoodKind { get; set; } = string.Empty;

    public FoodState State { get; set; }

    /// <summary>How many days it is reckoned to last. Always days; the UI says weeks where it reads better.</summary>
    public int Days { get; set; }

    /// <summary>False once somebody has moved it — what `PUT THEM BACK` restores.</summary>
    public bool IsSeeded { get; set; } = true;

    public DateTime UpdatedUtc { get; set; }
}

/// <summary>One row of S1.</summary>
public record ShelfLifeDto(int Id, string FoodKind, string State, int Days, bool IsSeeded);

/// <summary>Change how long one kind of food is reckoned to last.</summary>
public record ShelfLifeInput(int Days);

/// <summary>
/// The defaults the section ships with.
/// </summary>
/// <remarks>
/// Seeded rather than left empty because an empty settings screen teaches nothing: the household
/// needs to see what the panel currently believes before it can disagree usefully. The numbers are
/// deliberately unremarkable — they are a starting point to be corrected, not a claim to authority.
/// </remarks>
public static class ShelfLifeSeed
{
    public static IReadOnlyList<(string Kind, FoodState State, int Days)> Defaults =>
    [
        ("Leafy greens", FoodState.Fresh, 5),
        ("Soft fruit", FoodState.Fresh, 5),
        ("Root vegetables", FoodState.Fresh, 21),
        ("Tomatoes", FoodState.Fresh, 7),
        ("Cut herbs", FoodState.Fresh, 4),
        ("Apples", FoodState.Fresh, 30),
        ("Bagged salad", FoodState.Fresh, 4),

        ("Milk and cream", FoodState.Chilled, 7),
        ("Raw meat and fish", FoodState.Chilled, 3),
        ("Cooked meat", FoodState.Chilled, 4),
        ("Hard cheese", FoodState.Chilled, 28),
        ("Eggs", FoodState.Chilled, 28),

        ("Decanted tins", FoodState.Opened, 3),
        ("Jars in the fridge", FoodState.Opened, 28),
        ("Cooking wine", FoodState.Opened, 21),
        ("Cooked leftovers", FoodState.Opened, 4),
    ];
}
