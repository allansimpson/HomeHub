namespace HomeHub.Tests;

using HomeHub.Api.Calendar.Capture;

/// <summary>
/// The inferences a flyer forces (E2) — made in code, not inside a generation.
/// </summary>
/// <remarks>
/// Every one of these is a guess the reading has to make because the paper did not say: which year
/// "14 September" belongs to, when an engagement with a start and no finish ends, and whether a date
/// with no hour on it is an all-day event or a 9 AM somebody invented. They live in
/// <c>DraftEventRules</c> rather than in the prompt precisely so they can be pinned here.
/// </remarks>
public class EventExtractionRulesTests
{
    private static readonly DateOnly Today = new(2026, 8, 12);

    private static RawDraft Raw(
        string? title = "Summer Camp Open House",
        int? year = null,
        int? month = 9,
        int? day = 14,
        string? begins = null,
        string? ends = null,
        string? where = null,
        string? note = null,
        IReadOnlyList<string>? lowConfidence = null) =>
        new(title, year, month, day, begins, ends, where, note, lowConfidence);

    private static DraftEvent One(RawDraft raw, DateOnly? today = null)
    {
        var result = DraftEventRules.Assemble([raw], today ?? Today);
        return Assert.Single(result.Events);
    }

    [Fact]
    public void An_unstated_year_becomes_the_next_time_that_date_comes_round()
    {
        // Read in August; 14 September has not happened yet, so it is this year's.
        var soon = One(Raw(month: 9, day: 14));
        Assert.Equal(new DateOnly(2026, 9, 14), soon.Date);
        Assert.Contains("year", soon.Assumed);

        // Read in August; 7 January has already gone, so it is next year's. This is the case that
        // makes a naive "use the current year" rule put a school event eleven months in the past.
        var next = One(Raw(month: 1, day: 7));
        Assert.Equal(new DateOnly(2027, 1, 7), next.Date);
        Assert.Contains("year", next.Assumed);
    }

    [Fact]
    public void Today_counts_as_still_to_come()
    {
        // A flyer read on the morning of the thing it advertises is ordinary, not stale.
        var draft = One(Raw(month: 8, day: 12));
        Assert.Equal(Today, draft.Date);
    }

    [Fact]
    public void A_printed_year_is_taken_as_printed_and_not_marked_assumed()
    {
        var draft = One(Raw(year: 2028, month: 3, day: 2));
        Assert.Equal(new DateOnly(2028, 3, 2), draft.Date);
        Assert.DoesNotContain("year", draft.Assumed);
    }

    [Fact]
    public void A_date_with_no_hour_is_all_day_rather_than_an_invented_time()
    {
        var draft = One(Raw(begins: null));
        Assert.True(draft.AllDay);
        Assert.Null(draft.Begins);
        Assert.Null(draft.Ends);
        // Nothing was invented, so nothing is claimed as assumed either.
        Assert.DoesNotContain("ends", draft.Assumed);
    }

    [Fact]
    public void A_start_with_no_finish_gets_an_hour_and_says_so()
    {
        var draft = One(Raw(begins: "10:00 AM"));
        Assert.False(draft.AllDay);
        Assert.Equal(new TimeOnly(10, 0), draft.Begins);
        Assert.Equal(new TimeOnly(11, 0), draft.Ends);
        Assert.Contains("ends", draft.Assumed);
    }

    [Fact]
    public void A_late_start_does_not_wrap_its_finish_past_midnight()
    {
        // 23:30 + an hour is 00:30 the next day, and a draft carries one date. Clamping keeps the
        // proposal inside the day rather than writing an engagement that ends before it begins.
        var draft = One(Raw(begins: "11:30 PM"));
        Assert.Equal(new TimeOnly(23, 59), draft.Ends);
        Assert.Contains("ends", draft.Assumed);
    }

    [Fact]
    public void A_finish_before_the_start_is_treated_as_a_misread()
    {
        var draft = One(Raw(begins: "7:00 PM", ends: "3:00 PM"));
        Assert.Equal(new TimeOnly(20, 0), draft.Ends);
        Assert.Contains("ends", draft.Assumed);
    }

    [Theory]
    [InlineData("7:30 PM", 19, 30)]
    [InlineData("7:30PM", 19, 30)]
    [InlineData("7.30 pm", 19, 30)]
    [InlineData("19:30", 19, 30)]
    [InlineData("7 PM", 19, 0)]
    [InlineData("10:00 AM", 10, 0)]
    public void Times_are_read_the_way_flyers_print_them(string printed, int hour, int minute)
    {
        Assert.Equal(new TimeOnly(hour, minute), DraftEventRules.ParseTime(printed));
    }

    [Fact]
    public void Something_that_is_not_a_time_is_not_guessed_at()
    {
        Assert.Null(DraftEventRules.ParseTime("tea time"));
        Assert.Null(DraftEventRules.ParseTime(""));
        Assert.Null(DraftEventRules.ParseTime(null));
    }

    [Fact]
    public void A_reading_with_no_date_is_not_an_engagement()
    {
        var result = DraftEventRules.Assemble([Raw(month: null, day: null)], Today);
        Assert.Equal(ExtractionConfidence.Empty, result.Confidence);
        Assert.Empty(result.Events);
        Assert.False(result.OffersAnEvent);
        Assert.NotNull(result.Reason);
    }

    [Fact]
    public void An_impossible_date_is_dropped_rather_than_rolled_to_a_real_one()
    {
        // 31 September would silently become 1 October, which is a different day on a flyer.
        var result = DraftEventRules.Assemble([Raw(year: 2026, month: 9, day: 31)], Today);
        Assert.Empty(result.Events);
    }

    [Fact]
    public void A_clean_read_is_complete_and_a_filled_gap_is_partial()
    {
        var clean = DraftEventRules.Assemble([Raw(year: 2026, month: 9, day: 14)], Today);
        Assert.Equal(ExtractionConfidence.Complete, clean.Confidence);

        // The unstated year alone is enough to make it partial — the household should look at it.
        var assumedYear = DraftEventRules.Assemble([Raw(month: 9, day: 14)], Today);
        Assert.Equal(ExtractionConfidence.Partial, assumedYear.Confidence);

        var strained = DraftEventRules.Assemble([Raw(year: 2026, lowConfidence: ["where"])], Today);
        Assert.Equal(ExtractionConfidence.Partial, strained.Confidence);
    }

    [Fact]
    public void An_engagement_with_no_name_never_offers_itself()
    {
        // The gate on Barnaby speaking: a date alone is as likely to be a price as an engagement.
        var result = DraftEventRules.Assemble([Raw(title: null, year: 2026)], Today);
        var draft = Assert.Single(result.Events);
        Assert.Equal("", draft.Title);
        Assert.False(result.OffersAnEvent);
        Assert.Equal(ExtractionConfidence.Partial, result.Confidence);
    }

    [Fact]
    public void Field_names_the_sheet_cannot_draw_are_discarded()
    {
        var draft = One(Raw(lowConfidence: ["where", "colour", "TITLE", "where"]));
        Assert.Equal(["where", "title"], draft.LowConfidence.OrderByDescending(f => f).ToList());
    }

    [Fact]
    public void Overlong_text_is_trimmed_to_what_the_columns_hold()
    {
        var draft = One(Raw(title: new string('x', 500), where: new string('y', 400)));
        Assert.Equal(200, draft.Title.Length);
        Assert.Equal(300, draft.Where!.Length);
    }

    [Fact]
    public void Several_engagements_keep_the_order_they_were_read_in_and_get_their_own_ids()
    {
        var result = DraftEventRules.Assemble(
            [Raw(title: "First", month: 9, day: 14), Raw(title: "Second", month: 9, day: 20)],
            Today);

        Assert.Equal(["First", "Second"], result.Events.Select(e => e.Title).ToList());
        Assert.Equal(2, result.Events.Select(e => e.Id).Distinct().Count());
    }
    /*
     * The wire shape the real vision provider has to read back.
     *
     * `VisionEventExtractor` asks for a strict JSON schema whose properties are camelCase, then
     * deserialises the model's answer with `JsonSerializer.Deserialize<T>(content)` — *default*
     * options, not the web defaults `ReadFromJsonAsync` applies to the envelope around it. Whether
     * "title" reaches `Title` therefore depends on how System.Text.Json matches constructor
     * parameters, which is not something to find out from a household's first flyer: every field
     * would come back null, every reading would produce nothing, and the panel would report "I can't
     * find a date on that one" about a photograph it had read perfectly.
     *
     * Every other test of this seam runs on the simulated extractor, so this is the only place the
     * real one's parsing is exercised at all.
     */
    [Fact]
    public void The_models_camel_case_answer_binds_to_the_raw_draft()
    {
        const string json = """
        {
          "title": "Summer Camp Open House",
          "year": 2026,
          "month": 9,
          "day": 14,
          "begins": "10:00 AM",
          "ends": null,
          "where": "The school hall",
          "note": "Bring a packed lunch",
          "lowConfidence": ["ends"]
        }
        """;

        // The readers' own options, deliberately — a test that brought its own would pass while
        // production kept the case-sensitive defaults that caused this.
        var draft = System.Text.Json.JsonSerializer.Deserialize<RawDraft>(json, ExtractionJson.Options);

        Assert.NotNull(draft);
        Assert.Equal("Summer Camp Open House", draft!.Title);
        Assert.Equal(2026, draft.Year);
        Assert.Equal(9, draft.Month);
        Assert.Equal(14, draft.Day);
        Assert.Equal("10:00 AM", draft.Begins);
        Assert.Null(draft.Ends);
        Assert.Equal("The school hall", draft.Where);
        Assert.Equal("Bring a packed lunch", draft.Note);
        Assert.Equal(["ends"], draft.LowConfidence);
    }
    /*
     * Sanitising what a stranger printed.
     *
     * Every reader funnels through `DraftEventRules`, so this is where the cleaning has to be — a
     * title read by the house agent and one read by a vision vendor are equally untrusted.
     *
     * The limit is stated honestly in the code and repeated here: this removes the tricks that work
     * on machines, not sentences that ask a model to do something. No character filter closes prompt
     * injection; the tool-less reading and the confirm sheet are what answer that.
     */
    [Fact]
    public void A_title_that_renders_as_something_other_than_it_contains_is_cleaned()
    {
        // A right-to-left override: the sheet would show one sentence while the stored value is
        // another, which makes a person's confirmation meaningless. Trojan Source, on a flyer.
        var draft = DraftEventRules.Normalize(
            Raw(title: "Book club\u202E gniteem lecnac", begins: "10:00 AM"), new DateOnly(2026, 8, 13), 0);

        Assert.NotNull(draft);
        Assert.DoesNotContain('\u202E', draft!.Title);
        Assert.Equal("Book club gniteem lecnac", draft.Title);
    }

    [Fact]
    public void Invisible_characters_are_stripped_from_free_text()
    {
        var draft = DraftEventRules.Normalize(
            Raw(title: "Sports\u200B\u200B day", where: "The\uFEFF field", begins: "10:00 AM"), new DateOnly(2026, 8, 13), 0);

        Assert.Equal("Sports day", draft!.Title);
        Assert.Equal("The field", draft.Where);
    }

    [Fact]
    public void Control_characters_and_stray_whitespace_do_not_reach_a_calendar_row()
    {
        var draft = DraftEventRules.Normalize(
            Raw(title: "  Camp\tOpen\r\nHouse  ", where: "Hall\u0000", begins: "10:00 AM"), new DateOnly(2026, 8, 13), 0);

        // A newline in a title is a rendering fault wherever that row is drawn, so it collapses.
        Assert.Equal("Camp Open House", draft!.Title);
        Assert.Equal("Hall", draft.Where);
    }

    /* A note is the one field that keeps its shape — "bring a lunch / cost $5" is two lines. */
    [Fact]
    public void A_note_keeps_its_line_breaks_but_not_its_control_characters()
    {
        var draft = DraftEventRules.Normalize(
            Raw(note: "Bring a packed lunch\n\n\nCost: $5\u0007", begins: "10:00 AM"), new DateOnly(2026, 8, 13), 0);

        Assert.Equal("Bring a packed lunch\nCost: $5", draft!.Note);
    }

    [Fact]
    public void Text_that_is_nothing_but_invisibles_becomes_nothing()
    {
        var draft = DraftEventRules.Normalize(
            Raw(title: "\u200B\u200B", where: "   ", begins: "10:00 AM"), new DateOnly(2026, 8, 13), 0);

        Assert.Equal("", draft!.Title);
        Assert.Null(draft.Where);
    }

}
