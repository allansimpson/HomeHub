namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Care;
using HomeHub.Api.Controllers;

/// <summary>
/// The care log HomeHub owns — and specifically the things the retired Huckleberry path never could.
/// </summary>
/// <remarks>
/// Editing, deleting, logging after the fact, and the six types that exist nowhere else. Each of
/// those was a hard limit of the integration rather than of the domain, so each gets a test that
/// would fail if the limit crept back.
/// </remarks>
public class CareLogTests
{
    private static CareEntryInput Bottle(double oz = 3.5, DateTime? at = null) =>
        new(CareEntryType.Bottle, at, Amount: oz, Unit: "oz", Kind: "breast_milk");

    private static async Task<CareEntryDto> AddAsync(HttpClient client, CareEntryInput input)
    {
        var res = await client.PostAsJsonAsync("/api/care/conrad/entries", input);
        res.EnsureSuccessStatusCode();
        return (await res.Content.ReadFromJsonAsync<CareEntryDto>())!;
    }

    /*
     * A bottle keeps both ends of the sum it was worked out from.
     *
     * The sheet asks what was poured and what came back, and writes the difference — the figure the
     * totals and the log row read. Only that difference used to be stored, so reopening a feed to
     * correct it showed the *consumed* amount in OFFERED with REMAINING empty: a bottle nobody
     * drank from, and the size of the one that was actually poured gone. These two columns exist so
     * a correction opens on what was entered.
     */
    [Fact]
    public async Task Bottle_keeps_what_was_offered_and_what_came_back()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        // Four ounces poured, half an ounce back, three and a half taken.
        var written = await AddAsync(client, new CareEntryInput(
            CareEntryType.Bottle, Amount: 3.5, Unit: "oz", Kind: "breast_milk", Offered: 4.0, Left: 0.5));

        Assert.Equal(4.0, written.Offered);
        Assert.Equal(0.5, written.Left);
        // Unchanged, and the point: everything else on the panel still reads what was taken.
        Assert.Equal(3.5, written.Amount);

        var read = await client.GetFromJsonAsync<List<CareEntryDto>>("/api/care/conrad/entries");
        var round = Assert.Single(read!, e => e.Id == written.Id);
        Assert.Equal(4.0, round.Offered);
        Assert.Equal(0.5, round.Left);
    }

    /* A correction rewrites both ends, or the sheet would reopen on the figures before it. */
    [Fact]
    public async Task Correcting_a_bottle_rewrites_both_ends()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var written = await AddAsync(client, new CareEntryInput(
            CareEntryType.Bottle, Amount: 3.5, Unit: "oz", Offered: 4.0, Left: 0.5));

        // The baby came back for the rest of it.
        var res = await client.PutAsJsonAsync($"/api/care/entries/{written.Id}", new CareEntryInput(
            CareEntryType.Bottle, Amount: 4.0, Unit: "oz", Offered: 4.0, Left: 0));
        res.EnsureSuccessStatusCode();

        var updated = (await res.Content.ReadFromJsonAsync<CareEntryDto>())!;
        Assert.Equal(4.0, updated.Offered);
        Assert.Equal(0, updated.Left);
        Assert.Equal(4.0, updated.Amount);
    }

    /*
     * Nothing but a bottle is poured and handed back.
     *
     * The import path knows nothing about either column and the other sheets never ask, but a
     * client is free to send anything — and a stray pair here would be two figures the bottle sheet
     * would happily reopen on for a type that has no bottle.
     */
    [Fact]
    public async Task Only_a_bottle_keeps_the_pair()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var nursing = await AddAsync(client, new CareEntryInput(
            CareEntryType.Nursing, DurationMinutes: 14, Side: "left", Offered: 4.0, Left: 0.5));

        Assert.Null(nursing.Offered);
        Assert.Null(nursing.Left);
    }

    /*
     * The six types the integration has no service and no sensor for. Being able to write one at all
     * is the entire reason this table exists.
     */
    [Theory]
    [InlineData(CareEntryType.Pump)]
    [InlineData(CareEntryType.Solids)]
    [InlineData(CareEntryType.Medicine)]
    [InlineData(CareEntryType.Bath)]
    [InlineData(CareEntryType.TummyTime)]
    [InlineData(CareEntryType.Temperature)]
    public async Task A_type_the_old_integration_could_not_store_is_logged_here(CareEntryType type)
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var entry = await AddAsync(client, new CareEntryInput(type, Notes: "logged on the panel"));

        Assert.Equal(type.ToString(), entry.Type);
        Assert.Equal("Panel", entry.Source);
    }

    /*
     * No write in the integration takes a timestamp, so a 2am feed entered at 6am was recorded as
     * 6am and there was no way to say otherwise. The design's whole When picker rests on this.
     */
    [Fact]
    public async Task An_entry_can_be_logged_for_when_it_actually_happened()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var earlier = DateTime.UtcNow.AddHours(-4);

        var entry = await AddAsync(client, Bottle(at: earlier));

        Assert.Equal(earlier, entry.AtUtc, TimeSpan.FromSeconds(1));
    }

    [Fact]
    public async Task An_entry_can_be_corrected_and_says_that_it_was()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var entry = await AddAsync(client, Bottle(3.5));

        var res = await client.PutAsJsonAsync($"/api/care/entries/{entry.Id}", Bottle(4.0));
        res.EnsureSuccessStatusCode();
        var updated = (await res.Content.ReadFromJsonAsync<CareEntryDto>())!;

        Assert.Equal(4.0, updated.Amount);
        // The log marks a corrected row rather than quietly showing the new number.
        Assert.True(updated.Edited);
    }

    [Fact]
    public async Task An_entry_can_be_deleted()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var entry = await AddAsync(client, Bottle());

        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync($"/api/care/entries/{entry.Id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.DeleteAsync($"/api/care/entries/{entry.Id}")).StatusCode);
    }

    /*
     * Huckleberry took a missing pump amount and wrote `0 oz`, then reported `0 oz` back as though
     * somebody had weighed it. Five of the household's last six sessions had no amount. Null and
     * zero must not be the same thing here.
     */
    [Fact]
    public async Task An_unmeasured_pump_session_is_not_recorded_as_zero()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var none = await AddAsync(client, new CareEntryInput(CareEntryType.Pump, Amount: null));
        var zeroed = await AddAsync(client, new CareEntryInput(CareEntryType.Pump, Amount: 0, Unit: "oz"));

        Assert.Null(none.Amount);
        // A sheet that sent zero for "I did not measure" would recreate exactly the upstream bug.
        Assert.Null(zeroed.Amount);
        Assert.Null(zeroed.Unit);
    }

    [Fact]
    public async Task The_summary_carries_the_newest_of_each_type_for_the_tiles()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        await AddAsync(client, Bottle(3.0, DateTime.UtcNow.AddHours(-3)));
        await AddAsync(client, Bottle(4.0, DateTime.UtcNow.AddMinutes(-10)));
        await AddAsync(client, new CareEntryInput(CareEntryType.Diaper, Kind: "poo"));

        var summary = await client.GetFromJsonAsync<CareSummaryDto>("/api/care/conrad/summary");

        var bottle = Assert.Single(summary!.LastByType, e => e.Type == "Bottle");
        Assert.Equal(4.0, bottle.Amount);
        Assert.Contains(summary.LastByType, e => e.Type == "Diaper");
        // A type nobody has logged is simply absent — that is what drives the NO RECORD caption.
        Assert.DoesNotContain(summary.LastByType, e => e.Type == "Bath");
    }

    // ---- timers ----

    [Fact]
    public async Task Cancel_writes_nothing_and_complete_writes_the_session()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        // Cancel — the half that must leave no trace.
        (await client.PostAsync("/api/care/conrad/timer/Nursing/start?side=left", null)).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.NoContent, (await client.PostAsync("/api/care/conrad/timer/Nursing/cancel", null)).StatusCode);
        var afterCancel = await client.GetFromJsonAsync<CareSummaryDto>("/api/care/conrad/summary");
        Assert.DoesNotContain(afterCancel!.LastByType, e => e.Type == "Nursing");
        Assert.Empty(afterCancel.Timers);

        // Complete — the half that writes.
        (await client.PostAsync("/api/care/conrad/timer/Nursing/start?side=right", null)).EnsureSuccessStatusCode();
        var done = await client.PostAsync("/api/care/conrad/timer/Nursing/complete", null);
        done.EnsureSuccessStatusCode();
        var entry = (await done.Content.ReadFromJsonAsync<CareEntryDto>())!;

        Assert.Equal("Nursing", entry.Type);
        Assert.Equal("right", entry.Side);
    }

    /* Two nursing timers is not a state the domain has an answer for. A double tap must not make one. */
    [Fact]
    public async Task Starting_a_timer_twice_does_not_start_a_second()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        (await client.PostAsync("/api/care/conrad/timer/Nursing/start?side=left", null)).EnsureSuccessStatusCode();
        (await client.PostAsync("/api/care/conrad/timer/Nursing/start?side=right", null)).EnsureSuccessStatusCode();

        var summary = await client.GetFromJsonAsync<CareSummaryDto>("/api/care/conrad/summary");
        var timer = Assert.Single(summary!.Timers);
        // The first session stands — the second tap did not restart it or change its side.
        Assert.Equal("left", timer.Side);
    }

    /*
     * Three and seventeen, not the design's five and twenty.
     *
     * The household's own observed pattern, and the client's `PUMP_PHASES` carries the same pair for
     * the same reason — a panel that opened on one default while the server assumed another would
     * have the two quietly disagreeing about when a session switches. This test named the old figures
     * for longer than the code did.
     */
    [Fact]
    public async Task A_pump_session_opens_on_the_household_pattern_and_can_advance_a_phase()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var started = await client.PostAsync("/api/care/conrad/timer/Pump/start", null);
        var timer = (await started.Content.ReadFromJsonAsync<CareTimerDto>())!;
        Assert.Equal(3, timer.PhaseOneMinutes);
        Assert.Equal(17, timer.PhaseTwoMinutes);
        Assert.Equal(1, timer.Phase);

        var switched = await client.PostAsync("/api/care/conrad/timer/pump/phase", null);
        Assert.Equal(2, (await switched.Content.ReadFromJsonAsync<CareTimerDto>())!.Phase);
    }

    /*
     * Expression is seventeen minutes of expression, whenever the switch happens.
     *
     * Nothing advances a pump session on anybody's behalf, so stimulation runs over whenever nobody
     * is looking — and both phases used to be measured from the start of the session, which took the
     * overrun off the second one. The phase that came up short was the one that produces the milk.
     * The mark stamped here is what lets the panel count expression from the switch instead.
     */
    [Fact]
    public async Task Switching_a_pump_marks_where_expression_began()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        (await client.PostAsync("/api/care/conrad/timer/Pump/start", null)).EnsureSuccessStatusCode();
        var switched = await client.PostAsync("/api/care/conrad/timer/pump/phase", null);
        var timer = (await switched.Content.ReadFromJsonAsync<CareTimerDto>())!;

        Assert.NotNull(timer.PhaseTwoAtMinutes);
        // A session switched the instant it started has run no time at all, and says so.
        Assert.Equal(timer.ElapsedMinutes, timer.PhaseTwoAtMinutes!.Value, 1);
    }

    /* A second tap is the first switch. Restarting the mark would restart the seventeen minutes
       somebody is already eight minutes into — the exact fault this mark exists to fix. */
    [Fact]
    public async Task Switching_a_pump_twice_keeps_the_first_mark()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        (await client.PostAsync("/api/care/conrad/timer/Pump/start", null)).EnsureSuccessStatusCode();
        var first = (await (await client.PostAsync("/api/care/conrad/timer/pump/phase", null))
            .Content.ReadFromJsonAsync<CareTimerDto>())!;
        var again = (await (await client.PostAsync("/api/care/conrad/timer/pump/phase", null))
            .Content.ReadFromJsonAsync<CareTimerDto>())!;

        Assert.Equal(first.PhaseTwoAtMinutes, again.PhaseTwoAtMinutes);
    }

    /*
     * FINISH is the pump's third stop, and it is neither of the other two.
     *
     * COMPLETE writes, CANCEL discards, and this measures: how much was expressed is knowable only
     * once the session is over, so the clock stops, the row stands, and the panel asks. The hold
     * being a row is what lets it survive the panel closing, the app restarting, and the household
     * picking the phone up in another room.
     */
    [Fact]
    public async Task Finishing_a_pump_holds_the_session_without_writing_it()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        (await client.PostAsync("/api/care/conrad/timer/Pump/start", null)).EnsureSuccessStatusCode();
        var finished = await client.PostAsync("/api/care/conrad/timer/Pump/finish", null);
        var timer = (await finished.Content.ReadFromJsonAsync<CareTimerDto>())!;

        Assert.NotNull(timer.EndedUtc);
        // Still there, and still not an entry: nothing is written until SAVE sends the amount.
        var summary = await client.GetFromJsonAsync<CareSummaryDto>("/api/care/conrad/summary");
        Assert.NotNull(Assert.Single(summary!.Timers).EndedUtc);
        Assert.DoesNotContain(summary.LastByType, e => e.Type == "Pump" && e.Source == "Panel");
    }

    /* The measurement was taken when the clock stopped. A held session's length does not keep
       running while somebody works out how much they got. */
    [Fact]
    public async Task A_held_session_holds_its_measured_length()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        (await client.PostAsync("/api/care/conrad/timer/Pump/start", null)).EnsureSuccessStatusCode();
        var first = (await (await client.PostAsync("/api/care/conrad/timer/Pump/finish", null))
            .Content.ReadFromJsonAsync<CareTimerDto>())!;
        var again = (await (await client.PostAsync("/api/care/conrad/timer/Pump/finish", null))
            .Content.ReadFromJsonAsync<CareTimerDto>())!;

        // A second FINISH is the first one — a stale panel must not restamp a held session.
        Assert.Equal(first.EndedUtc, again.EndedUtc);
        Assert.Equal(first.ElapsedMinutes, again.ElapsedMinutes);
    }

    /* The one write, with the amount in hand, and the start the panel corrected. */
    [Fact]
    public async Task Completing_a_held_session_writes_it_once_with_its_amount()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var startedAt = new DateTime(2026, 8, 17, 6, 8, 0, DateTimeKind.Utc);

        (await client.PostAsync("/api/care/conrad/timer/Pump/start", null)).EnsureSuccessStatusCode();
        (await client.PostAsync("/api/care/conrad/timer/Pump/finish", null)).EnsureSuccessStatusCode();

        var saved = await client.PostAsync(
            $"/api/care/conrad/timer/Pump/complete?amount=4&unit=oz&atUtc={startedAt:o}", null);
        var entry = (await saved.Content.ReadFromJsonAsync<CareEntryDto>())!;

        Assert.Equal(4, entry.Amount);
        Assert.Equal("oz", entry.Unit);
        Assert.Equal(startedAt, entry.AtUtc);
        // The session is gone from the timers: written exactly once, never written and updated.
        var summary = await client.GetFromJsonAsync<CareSummaryDto>("/api/care/conrad/summary");
        Assert.Empty(summary!.Timers);
    }

    /*
     * A session written from a pause began when it began.
     *
     * The entry is back-dated to the clock's mark less what it banked, and pausing banked the run
     * without moving the mark — so a session started at 10:00 and paused at 10:20 wrote itself as
     * having begun at 9:40. An hour of the night the household did not spend feeding, on the one
     * screen that exists to say when things happened.
     */
    [Fact]
    public async Task A_paused_session_is_not_back_dated_twice()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var before = DateTime.UtcNow;

        (await client.PostAsync("/api/care/conrad/timer/Sleep/start", null)).EnsureSuccessStatusCode();
        (await client.PostAsync("/api/care/conrad/timer/Sleep/pause", null)).EnsureSuccessStatusCode();
        var saved = await client.PostAsync("/api/care/conrad/timer/Sleep/complete", null);
        var entry = (await saved.Content.ReadFromJsonAsync<CareEntryDto>())!;

        // Started when the test started it, give or take the moments the requests took.
        Assert.InRange(entry.AtUtc, before.AddMinutes(-1), DateTime.UtcNow);
    }

    /* A pause is not a reset: the minutes already run stay banked. */
    [Fact]
    public async Task Pausing_holds_the_clock_rather_than_restarting_it()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        (await client.PostAsync("/api/care/conrad/timer/Sleep/start", null)).EnsureSuccessStatusCode();
        var paused = await client.PostAsync("/api/care/conrad/timer/Sleep/pause", null);
        var timer = (await paused.Content.ReadFromJsonAsync<CareTimerDto>())!;

        Assert.True(timer.Paused);
        Assert.True(timer.ElapsedMinutes >= 0);
    }

    // ---- what makes an offline entry safe to send twice ----

    /*
     * The failure a queue cannot tell apart from a dropped request: the row landed and the response
     * did not. Retrying logs the feed twice, not retrying loses it, and on a child's record neither
     * is a choice worth making — so the key decides instead of the client guessing.
     */
    [Fact]
    public async Task Replaying_an_entry_under_the_same_client_key_records_it_once()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var input = Bottle() with { ClientKey = "0f8c-replay" };

        var first = await AddAsync(client, input);
        var second = await AddAsync(client, input);

        // The same row, handed back — not a second one, and not an error the panel would have to
        // interpret.
        Assert.Equal(first.Id, second.Id);
        var entries = await client.GetFromJsonAsync<List<CareEntryDto>>("/api/care/conrad/entries");
        Assert.Single(entries!, e => e.ClientKey == "0f8c-replay");
    }

    /* Two genuinely separate feeds at the same moment are two feeds. Only the key may fold rows. */
    [Fact]
    public async Task Two_identical_entries_with_different_keys_are_both_kept()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var at = DateTime.UtcNow.AddMinutes(-10);

        await AddAsync(client, Bottle(at: at) with { ClientKey = "aaa" });
        await AddAsync(client, Bottle(at: at) with { ClientKey = "bbb" });

        var entries = await client.GetFromJsonAsync<List<CareEntryDto>>("/api/care/conrad/entries");
        Assert.Equal(2, entries!.Count(e => e.Type == nameof(CareEntryType.Bottle)));
    }

    /*
     * The panel matches its own unsent rows against what comes back by this key, so it has to come
     * back — and it has to come back as the panel spelled it, without the storage prefix.
     */
    [Fact]
    public async Task The_client_key_is_reported_back_unprefixed()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var entry = await AddAsync(client, Bottle() with { ClientKey = "abc-123" });

        Assert.Equal("abc-123", entry.ClientKey);
    }

    /* An entry written before any of this, or pulled in by the old import, has no key to report. */
    [Fact]
    public async Task An_entry_written_without_a_key_reports_none()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        Assert.Null((await AddAsync(client, Bottle())).ClientKey);
    }

    // ---- a correction that was queued for hours ----

    /*
     * The case the queue creates and a live panel does not: an edit typed on a phone with no signal
     * sits until there is one, and in that time the same entry may have been corrected on the wall
     * panel. Applying both in arrival order means the older silently wins.
     */
    [Fact]
    public async Task A_correction_against_a_stale_version_is_refused_rather_than_applied()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var entry = await AddAsync(client, Bottle(3.5));

        // Somebody corrects it on the panel first, which moves the version on.
        var onPanel = await client.PutAsJsonAsync($"/api/care/entries/{entry.Id}", Bottle(4.0));
        onPanel.EnsureSuccessStatusCode();

        var queued = await client.PutAsJsonAsync(
            $"/api/care/entries/{entry.Id}?baseVersion={entry.Version}", Bottle(2.0));

        Assert.Equal(HttpStatusCode.Conflict, queued.StatusCode);
        // The current row rides along, so the household is shown what it is choosing between.
        var current = await queued.Content.ReadFromJsonAsync<CareEntryDto>();
        Assert.Equal(4.0, current!.Amount);
    }

    [Fact]
    public async Task A_correction_against_the_current_version_is_applied()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var entry = await AddAsync(client, Bottle(3.5));

        var res = await client.PutAsJsonAsync(
            $"/api/care/entries/{entry.Id}?baseVersion={entry.Version}", Bottle(4.0));

        res.EnsureSuccessStatusCode();
        var updated = (await res.Content.ReadFromJsonAsync<CareEntryDto>())!;
        Assert.Equal(4.0, updated.Amount);
        // Moved on, so the next queued edit made against the old one is caught too.
        Assert.True(updated.Version > entry.Version);
    }

    /* A delete queued offline may be aimed at a row corrected since — removing it would take the
       correction with it. */
    [Fact]
    public async Task A_delete_against_a_stale_version_is_refused()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var entry = await AddAsync(client, Bottle());
        (await client.PutAsJsonAsync($"/api/care/entries/{entry.Id}", Bottle(4.0))).EnsureSuccessStatusCode();

        var res = await client.DeleteAsync($"/api/care/entries/{entry.Id}?baseVersion={entry.Version}");

        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        Assert.NotNull(await client.GetFromJsonAsync<List<CareEntryDto>>("/api/care/conrad/entries"));
    }

    /* Nothing sends a version for an entry it never read one for; those writes stay last-write-wins. */
    [Fact]
    public async Task A_write_that_names_no_version_is_unconditional()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var entry = await AddAsync(client, Bottle());
        (await client.PutAsJsonAsync($"/api/care/entries/{entry.Id}", Bottle(4.0))).EnsureSuccessStatusCode();

        var res = await client.DeleteAsync($"/api/care/entries/{entry.Id}");

        Assert.Equal(HttpStatusCode.NoContent, res.StatusCode);
    }

    /* A correction must not cost the entry its identity, or the replay guard stops guarding it. */
    [Fact]
    public async Task Correcting_an_entry_keeps_its_client_key()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var entry = await AddAsync(client, Bottle() with { ClientKey = "keep-me" });

        var res = await client.PutAsJsonAsync($"/api/care/entries/{entry.Id}", Bottle(4.0));
        var updated = (await res.Content.ReadFromJsonAsync<CareEntryDto>())!;

        Assert.Equal("keep-me", updated.ClientKey);
        // And it still stands in the way of a replay of the original create.
        var replayed = await AddAsync(client, Bottle() with { ClientKey = "keep-me" });
        Assert.Equal(entry.Id, replayed.Id);
    }
}
