namespace HomeHub.Tests;

using HomeHub.Api.Ai;

/// <summary>
/// The assistant's list resolution: "add oat milk to the grocery list" has to land on whichever
/// Microsoft To Do list the household actually calls its grocery list.
/// </summary>
/// <remarks>
/// Fuzzy matching is exactly the kind of code that drifts silently — a tweak to the scoring makes one
/// phrasing better and another stop working, and nobody notices until an item lands on the wrong
/// list. Pinning it here is also much cheaper than exercising it end to end, where every assertion
/// would write a real task into someone's account.
/// </remarks>
public class AssistantListMatchingTests
{
    private static AssistantActions.ListCandidate List(string name) => new(name, name);

    /// <summary>The household's real lists, as Microsoft To Do reports them.</summary>
    private static readonly AssistantActions.ListCandidate[] Lists =
    [
        List("Grocery Shopping"),
        List("Household"),
        List("Theo's Swim Bag"),
        List("Work"),
    ];

    /// <summary>
    /// The stated requirement: any list whose name contains "grocery" wins, whatever else it is
    /// called. "Grocery Shopping", "Weekly Groceries" and "Grocery" must all be reachable by saying
    /// "the grocery list".
    /// </summary>
    [Theory]
    [InlineData("grocery")]
    [InlineData("Grocery")]
    [InlineData("grocery list")]
    [InlineData("the groceries")]
    [InlineData("groceries")]
    public void A_grocery_phrasing_finds_the_grocery_list(string spoken)
    {
        var target = AssistantActions.ResolveList(spoken, Lists);

        Assert.NotNull(target);
        Assert.Equal("Grocery Shopping", target.Name);
    }

    /// <summary>Whatever the list is called, "grocery" reaches it — the substring rule, both ways.</summary>
    [Theory]
    [InlineData("Grocery Shopping")]
    [InlineData("Weekly Grocery")]
    [InlineData("Grocery")]
    [InlineData("Groceries")]
    [InlineData("Food + Grocery")]
    public void Any_list_named_around_grocery_is_reachable(string listName)
    {
        var target = AssistantActions.ResolveList("grocery", [List(listName), List("Work")]);

        Assert.NotNull(target);
        Assert.Equal(listName, target.Name);
    }

    /// <summary>Spoken input is transcribed, so near-misses have to survive.</summary>
    [Theory]
    [InlineData("grocary")]
    [InlineData("grocerys")]
    public void A_misheard_grocery_still_lands(string spoken)
    {
        var target = AssistantActions.ResolveList(spoken, Lists);

        Assert.NotNull(target);
        Assert.Equal("Grocery Shopping", target.Name);
    }

    /// <summary>Other lists still resolve — grocery is not special-cased, just well-matched.</summary>
    [Theory]
    [InlineData("household", "Household")]
    [InlineData("the household list", "Household")]
    [InlineData("swim bag", "Theo's Swim Bag")]
    [InlineData("work", "Work")]
    public void Other_lists_resolve_too(string spoken, string expected)
    {
        var target = AssistantActions.ResolveList(spoken, Lists);

        Assert.NotNull(target);
        Assert.Equal(expected, target.Name);
    }

    /// <summary>
    /// A list that isn't there returns null rather than the nearest thing.
    /// </summary>
    /// <remarks>
    /// This is the one that matters most: the caller turns null into "I couldn't find a list matching
    /// X — your lists are …", which is recoverable. Silently guessing puts the item somewhere the
    /// household won't look for it, and nobody finds out until the shopping is done.
    /// </remarks>
    [Theory]
    [InlineData("pharmacy")]
    [InlineData("garden centre")]
    public void An_unmatched_list_returns_nothing_rather_than_guessing(string spoken)
    {
        Assert.Null(AssistantActions.ResolveList(spoken, Lists));
    }

    [Fact]
    public void No_lists_at_all_resolves_to_nothing()
    {
        Assert.Null(AssistantActions.ResolveList("grocery", []));
    }
}
