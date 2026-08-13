namespace HomeHub.Tests;

using HomeHub.Api.Calendar.Capture;

/// <summary>
/// Reading back an answer that was *asked* for a shape rather than bound to one.
/// </summary>
/// <remarks>
/// The price of reading flyers with the house agent. Hermes ignores <c>response_format</c> — it
/// accepts the parameter, answers 200 and returns prose — so the agent path asks for JSON in words,
/// and a model asked politely for JSON complies most of the time and occasionally dresses it up.
/// Every wrapping here is one a model actually produces; the point is that a readable flyer is not
/// reported as unreadable because of a code fence.
/// </remarks>
public class ExtractionJsonTests
{
    private const string Bare =
        """{"events":[{"title":"Open House","year":null,"month":9,"day":14,"begins":"10:00 AM","ends":null,"where":"The hall","note":null,"lowConfidence":[]}]}""";

    [Fact]
    public void Reads_a_bare_object()
    {
        var reply = ExtractionJson.Parse(Bare);
        Assert.Equal("Open House", reply!.Events![0].Title);
        Assert.Equal(9, reply.Events[0].Month);
    }

    [Fact]
    public void Reads_an_object_in_a_fenced_block()
    {
        var reply = ExtractionJson.Parse("```json\n" + Bare + "\n```");
        Assert.Equal("Open House", reply!.Events![0].Title);
    }

    [Fact]
    public void Reads_an_object_in_an_unlabelled_fence()
    {
        Assert.Equal("Open House", ExtractionJson.Parse("```\n" + Bare + "\n```")!.Events![0].Title);
    }

    [Fact]
    public void Reads_an_object_with_prose_either_side()
    {
        var reply = ExtractionJson.Parse("Here is what I found:\n" + Bare + "\nHope that helps!");
        Assert.Equal("Open House", reply!.Events![0].Title);
    }

    /*
     * The line this must not cross. Repairing malformed JSON, or hunting fields out of prose, would
     * mean inventing an engagement — the one thing this feature must never do. Nothing usable is
     * reported as nothing found, and the household is told the truth.
     */
    [Fact]
    public void Refuses_to_guess_at_prose()
    {
        Assert.Null(ExtractionJson.Parse("There's a camp open house on the 14th of September at 10am."));
        Assert.Null(ExtractionJson.Parse("{\"events\": [ this is not json"));
        Assert.Null(ExtractionJson.Parse(""));
        Assert.Null(ExtractionJson.Parse(null));
    }

    /// <summary>The bug that made every field null: camelCase on the wire, PascalCase in the record.</summary>
    [Fact]
    public void Binds_the_models_camel_case_field_names()
    {
        var reply = ExtractionJson.Parse(Bare);
        var draft = reply!.Events![0];
        Assert.Equal("10:00 AM", draft.Begins);
        Assert.Equal("The hall", draft.Where);
        Assert.Null(draft.Year);
    }
}
