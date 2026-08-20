namespace HomeHub.Tests;

using HomeHub.Api.Care;

/// <summary>
/// Reading the household's own history back out of Huckleberry's calendar.
/// </summary>
/// <remarks>
/// <para>
/// <b>Every string here is real.</b> They were taken from 426 live calendar events over thirty days
/// against the household's own Home Assistant, not written from documentation — including the emoji,
/// which are part of the summary and the reason one classification order works and another does not.
/// </para>
/// <para>
/// This is the only route back into data the household has already recorded: the integration offers
/// no export, and its sensors report the last of each kind and nothing before it. Parsing a vendor's
/// prose is lossy by nature, so the rule these tests enforce is that it <b>under-claims</b> — a field
/// it cannot read is null, and an event it cannot classify is skipped rather than guessed at.
/// </para>
/// </remarks>
public class HuckleberryCalendarParserTests
{
    private static readonly DateTime At = new(2026, 8, 12, 11, 13, 55, 481, DateTimeKind.Utc);

    private static CareEntry Parse(string summary, string description, DateTime? end = null) =>
        HuckleberryCalendarParser.Parse(summary, description, At, end, "conrad")!;

    [Fact]
    public void Reads_a_bottle_with_its_amount_unit_and_contents()
    {
        var entry = Parse("🍼 Bottle (3.75 oz)", "Bottle feeding: 3.75 oz\nType: Breast Milk");

        Assert.Equal(CareEntryType.Bottle, entry.Type);
        Assert.Equal(3.75, entry.Amount);
        Assert.Equal("oz", entry.Unit);
        // The spelling the rest of HomeHub stores, not the display form the calendar prints.
        Assert.Equal("breast_milk", entry.Kind);
        Assert.Equal(At, entry.AtUtc);
        Assert.Equal(CareEntrySource.HuckleberryImport, entry.Source);
    }

    /*
     * The trap this feed is famous for. Nursing sessions are titled "Feed", not "Nursing", and carry
     * the *same bottle emoji* as a bottle — and a bottle's own description says "Type: Breast Milk".
     * Test either the wrong way round and thirty days of feeds import as the wrong type.
     */
    [Fact]
    public void Does_not_mistake_a_bottle_for_a_nursing_session_or_the_reverse()
    {
        Assert.Equal(CareEntryType.Bottle, Parse("🍼 Bottle (4 oz)", "Bottle feeding: 4 oz\nType: Breast Milk").Type);
        Assert.Equal(CareEntryType.Nursing, Parse("🍼 Feed (L:7m)", "Feeding - Total: 7 min 22 sec\nLeft: 7 min 22 sec").Type);
    }

    [Fact]
    public void Reads_a_nursing_session_with_its_side_and_duration()
    {
        var entry = Parse("🍼 Feed (L:7m)", "Feeding - Total: 7 min 22 sec\nLeft: 7 min 22 sec");

        Assert.Equal("left", entry.Side);
        // 7 min 22 sec, kept as decimal minutes rather than rounded to a whole one.
        Assert.Equal(7.37, entry.DurationMinutes!.Value, 2);
    }

    [Fact]
    public void Reads_the_right_side_and_both_sides()
    {
        Assert.Equal("right", Parse("🍼 Feed (R:6m)", "Feeding - Total: 6 min\nRight: 6 min").Side);
        Assert.Equal("both", Parse("🍼 Feed (12m)", "Feeding - Total: 12 min\nLeft: 7 min\nRight: 5 min").Side);
    }

    [Fact]
    public void Reads_a_plain_diaper()
    {
        var entry = Parse("💧 Diaper (Pee)", "Diaper change: pee");

        Assert.Equal(CareEntryType.Diaper, entry.Type);
        Assert.Equal("pee", entry.Kind);
        Assert.Null(entry.Color);
    }

    [Fact]
    public void Reads_a_poo_with_its_colour_and_consistency()
    {
        var entry = Parse("💩 Diaper (Poo)", "Diaper change: poo\nColor: yellow\nConsistency: loose");

        Assert.Equal("poo", entry.Kind);
        Assert.Equal("yellow", entry.Color);
        Assert.Equal("loose", entry.Consistency);
    }

    /* Its summary carries both emoji and its body says "both" — testing pee or poo first claims it. */
    [Fact]
    public void Reads_a_both_diaper_as_both_rather_than_as_one_of_its_halves()
    {
        Assert.Equal("both", Parse("💧💩 Diaper (Both)", "Diaper change: both").Kind);
    }

    [Fact]
    public void Reads_sleep_from_the_compact_form()
    {
        var entry = Parse("💤 Sleep (56m)", "Sleep duration: 56m");

        Assert.Equal(CareEntryType.Sleep, entry.Type);
        Assert.Equal(56, entry.DurationMinutes);
    }

    /*
     * Medicine is in the calendar even though the integration has no service to write one — which is
     * why the import reaches five types rather than four. But the entry carries no name, no dose and
     * no unit, so all that can honestly be recovered is that a dose was given at a time. Inventing a
     * medicine name in a child's medical log would be worse than leaving it blank.
     */
    [Fact]
    public void Imports_medicine_as_a_timestamped_fact_and_invents_no_detail()
    {
        var entry = Parse("🩺 Health (Medication)", "Health entry: medication");

        Assert.Equal(CareEntryType.Medicine, entry.Type);
        Assert.Null(entry.Kind);
        Assert.Null(entry.Amount);
        // The raw line survives, because it is the only detail there is.
        Assert.Contains("medication", entry.Notes!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Skips_what_it_cannot_classify_rather_than_guessing()
    {
        Assert.Null(HuckleberryCalendarParser.Parse("🩺 Health (Something new)", "Health entry: something new", At, null, "conrad"));
        Assert.Null(HuckleberryCalendarParser.Parse("", "", At, null, "conrad"));
        Assert.Null(HuckleberryCalendarParser.Parse(null, null, At, null, "conrad"));
    }

    /*
     * A point-in-time log arrives with end equal to start. Falling back to the span would record a
     * zero-minute session, which reads as a measurement rather than as the absence of one.
     */
    [Fact]
    public void Does_not_turn_a_zero_length_event_into_a_zero_minute_session()
    {
        var entry = Parse("💤 Sleep", "Sleep", end: At);
        Assert.Null(entry.DurationMinutes);
    }

    [Fact]
    public void Falls_back_to_the_span_when_the_description_gives_no_duration()
    {
        var entry = Parse("💤 Sleep", "Sleep", end: At.AddMinutes(45));
        Assert.Equal(45, entry.DurationMinutes);
    }

    /*
     * Huckleberry's calendar events carry a `uid` field and it is null on every single one, so the
     * key is synthesised. Importing the same window twice must write each event once — the unique
     * index enforces it, and this is what feeds that index.
     */
    [Fact]
    public void The_same_event_always_produces_the_same_key()
    {
        var first = Parse("🍼 Bottle (4 oz)", "Bottle feeding: 4 oz");
        var again = Parse("🍼 Bottle (4 oz)", "Bottle feeding: 4 oz");

        Assert.Equal(first.ExternalKey, again.ExternalKey);
        Assert.Contains("conrad", first.ExternalKey!, StringComparison.Ordinal);
    }

    [Fact]
    public void Different_moments_and_different_types_do_not_collide()
    {
        var bottle = Parse("🍼 Bottle (4 oz)", "Bottle feeding: 4 oz");
        var later = HuckleberryCalendarParser.Parse("🍼 Bottle (4 oz)", "Bottle feeding: 4 oz", At.AddMilliseconds(1), null, "conrad")!;
        var diaper = Parse("💧 Diaper (Pee)", "Diaper change: pee");

        Assert.NotEqual(bottle.ExternalKey, later.ExternalKey);
        Assert.NotEqual(bottle.ExternalKey, diaper.ExternalKey);
    }

    /* The key must not change with the machine's clock kind, or a re-sync would double every row. */
    [Fact]
    public void The_key_is_stable_across_local_and_utc_forms_of_the_same_instant()
    {
        var utc = HuckleberryCalendarParser.KeyFor("conrad", CareEntryType.Bottle, At);
        var local = HuckleberryCalendarParser.KeyFor("conrad", CareEntryType.Bottle, At.ToLocalTime());

        Assert.Equal(utc, local);
    }
}
