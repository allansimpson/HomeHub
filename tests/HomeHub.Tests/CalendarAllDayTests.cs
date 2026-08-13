namespace HomeHub.Tests;

using System.Net.Http.Json;
using System.Text.Json;
using HomeHub.Api.Calendar;

/// <summary>
/// All-day events (E1): the stored flag, and the shape it takes on the way to Google.
/// </summary>
/// <remarks>
/// The flag exists because inference could not survive a write. The panel had always *read* all-day
/// from the boundaries — local midnight, a day or more — which works for events Google sent and is
/// useless for events the household declares, since Google distinguishes the two by which field is
/// present rather than by what the times say. These tests pin both halves: the flag round-trips
/// through the API, and <see cref="GoogleCalendarProvider.ToGoogle"/> emits a bare <c>date</c> for
/// an all-day event and a <c>dateTime</c> for a timed one.
/// </remarks>
public class CalendarAllDayTests
{
    /// <summary>Local midnight to the next local midnight — what the panel sends for one whole day.</summary>
    private static (DateTime StartUtc, DateTime EndUtc) WholeDay(int year, int month, int day)
    {
        var start = new DateTime(year, month, day, 0, 0, 0, DateTimeKind.Local).ToUniversalTime();
        return (start, start.AddDays(1));
    }

    [Fact]
    public async Task All_day_flag_round_trips_through_the_api()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var (start, end) = WholeDay(2026, 9, 14);

        var created = await (await client.PostAsJsonAsync("/api/calendar/events",
                new CalendarEventInput("Sports Day", start, end, null, null, null, IsAllDay: true)))
            .Content.ReadFromJsonAsync<CalendarEventDto>();

        Assert.NotNull(created);
        Assert.True(created!.IsAllDay);

        // And on the way back out of a range read, not just from the create's own response — the
        // agenda draws from this one.
        var listed = await client.GetFromJsonAsync<List<CalendarEventDto>>(
            "/api/calendar/events?from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z");
        Assert.True(Assert.Single(listed!).IsAllDay);
    }

    [Fact]
    public async Task An_ordinary_event_is_not_all_day()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var start = new DateTime(2026, 9, 14, 18, 0, 0, DateTimeKind.Utc);

        var created = await (await client.PostAsJsonAsync("/api/calendar/events",
                new CalendarEventInput("Dinner", start, start.AddHours(2), null, null, null)))
            .Content.ReadFromJsonAsync<CalendarEventDto>();

        Assert.False(created!.IsAllDay);
    }

    [Fact]
    public async Task Editing_can_turn_a_timed_event_into_an_all_day_one_and_back()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var timedStart = new DateTime(2026, 9, 14, 18, 0, 0, DateTimeKind.Utc);
        var created = await (await client.PostAsJsonAsync("/api/calendar/events",
                new CalendarEventInput("Fête", timedStart, timedStart.AddHours(2), null, null, null)))
            .Content.ReadFromJsonAsync<CalendarEventDto>();

        var (start, end) = WholeDay(2026, 9, 14);
        var toAllDay = await (await client.PutAsJsonAsync($"/api/calendar/events/{created!.Id}",
                new CalendarEventInput("Fête", start, end, null, null, null, IsAllDay: true)))
            .Content.ReadFromJsonAsync<CalendarEventDto>();
        Assert.True(toAllDay!.IsAllDay);

        // Back again: the flag must clear, or an event could only ever become all-day.
        var backToTimed = await (await client.PutAsJsonAsync($"/api/calendar/events/{created.Id}",
                new CalendarEventInput("Fête", timedStart, timedStart.AddHours(2), null, null, null)))
            .Content.ReadFromJsonAsync<CalendarEventDto>();
        Assert.False(backToTimed!.IsAllDay);
    }

    [Fact]
    public void Google_gets_a_bare_date_for_an_all_day_event()
    {
        var (start, end) = WholeDay(2026, 9, 14);
        var payload = Serialize(GoogleCalendarProvider.ToGoogle(
            new CalendarEventInput("Sports Day", start, end, null, null, null, IsAllDay: true)));

        // The date, and *only* the date: a dateTime alongside it is what made a whole day render at
        // midnight on every other device in the house.
        Assert.Equal("2026-09-14", payload.GetProperty("start").GetProperty("date").GetString());
        Assert.False(payload.GetProperty("start").TryGetProperty("dateTime", out _));

        // Google's end date is exclusive, and so is ours — one whole day ends on the 15th.
        Assert.Equal("2026-09-15", payload.GetProperty("end").GetProperty("date").GetString());
    }

    [Fact]
    public void Google_gets_a_dateTime_for_a_timed_event()
    {
        var start = new DateTime(2026, 9, 14, 18, 0, 0, DateTimeKind.Utc);
        var payload = Serialize(GoogleCalendarProvider.ToGoogle(
            new CalendarEventInput("Dinner", start, start.AddHours(2), null, null, null)));

        Assert.Equal("2026-09-14T18:00:00Z", payload.GetProperty("start").GetProperty("dateTime").GetString());
        Assert.Equal("UTC", payload.GetProperty("start").GetProperty("timeZone").GetString());
        Assert.False(payload.GetProperty("start").TryGetProperty("date", out _));
    }

    [Fact]
    public void A_multi_day_all_day_event_keeps_both_ends()
    {
        // A three-day festival: the 14th, 15th and 16th, so the exclusive end is the 17th.
        var start = new DateTime(2026, 9, 14, 0, 0, 0, DateTimeKind.Local).ToUniversalTime();
        var payload = Serialize(GoogleCalendarProvider.ToGoogle(
            new CalendarEventInput("Festival", start, start.AddDays(3), null, null, null, IsAllDay: true)));

        Assert.Equal("2026-09-14", payload.GetProperty("start").GetProperty("date").GetString());
        Assert.Equal("2026-09-17", payload.GetProperty("end").GetProperty("date").GetString());
    }

    private static JsonElement Serialize(object payload) =>
        JsonSerializer.SerializeToElement(payload);
}
