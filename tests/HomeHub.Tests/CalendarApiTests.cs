namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Calendar;

/// <summary>
/// Stage 4 calendar CRUD + range/upcoming queries over HTTP against the local SQL provider
/// (the default when Google isn't configured), backed by an isolated in-memory database.
/// </summary>
public class CalendarApiTests
{
    private static CalendarEventInput Sample(DateTime startUtc, string title = "Dinner", int hours = 2, int[]? owners = null) =>
        new(title, startUtc, startUtc.AddHours(hours), "Verdi's", "Bring wine", owners);

    [Fact]
    public async Task Create_then_read_in_range()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var start = new DateTime(2026, 7, 20, 18, 0, 0, DateTimeKind.Utc);

        var created = await (await client.PostAsJsonAsync("/api/calendar/events", Sample(start, owners: [1, 2])))
            .Content.ReadFromJsonAsync<CalendarEventDto>();
        Assert.NotNull(created);
        Assert.Equal("Dinner", created!.Title);
        Assert.Equal(new[] { 1, 2 }, created.OwnerIds);
        Assert.Equal("local", created.Source);

        var inRange = await client.GetFromJsonAsync<List<CalendarEventDto>>(
            "/api/calendar/events?from=2026-07-01T00:00:00Z&to=2026-08-01T00:00:00Z");
        Assert.Single(inRange!);

        var outOfRange = await client.GetFromJsonAsync<List<CalendarEventDto>>(
            "/api/calendar/events?from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z");
        Assert.Empty(outOfRange!);
    }

    [Fact]
    public async Task Update_and_delete_round_trip()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var start = new DateTime(2026, 7, 21, 9, 0, 0, DateTimeKind.Utc);
        var created = await (await client.PostAsJsonAsync("/api/calendar/events", Sample(start, "Grocery")))
            .Content.ReadFromJsonAsync<CalendarEventDto>();

        var updated = await (await client.PutAsJsonAsync(
            $"/api/calendar/events/{created!.Id}",
            Sample(start.AddHours(1), "Grocery Delivery", owners: [3])))
            .Content.ReadFromJsonAsync<CalendarEventDto>();
        Assert.Equal("Grocery Delivery", updated!.Title);
        Assert.Equal(new[] { 3 }, updated.OwnerIds);

        var del = await client.DeleteAsync($"/api/calendar/events/{created.Id}");
        Assert.Equal(HttpStatusCode.NoContent, del.StatusCode);

        var afterDelete = await client.GetAsync($"/api/calendar/events/{created.Id}");
        Assert.Equal(HttpStatusCode.NotFound, afterDelete.StatusCode);
    }

    [Fact]
    public async Task Upcoming_returns_future_events_sorted()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var now = DateTime.UtcNow;
        await client.PostAsJsonAsync("/api/calendar/events", Sample(now.AddDays(2), "Later"));
        await client.PostAsJsonAsync("/api/calendar/events", Sample(now.AddHours(3), "Sooner"));
        await client.PostAsJsonAsync("/api/calendar/events", Sample(now.AddDays(30), "WayOut"));

        var upcoming = await client.GetFromJsonAsync<List<CalendarEventDto>>("/api/calendar/upcoming?days=7");

        Assert.Equal(2, upcoming!.Count);
        Assert.Equal("Sooner", upcoming[0].Title); // sorted by start
        Assert.Equal("Later", upcoming[1].Title);
    }

    [Fact]
    public async Task Rejects_invalid_events()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var start = new DateTime(2026, 7, 22, 10, 0, 0, DateTimeKind.Utc);

        var noTitle = await client.PostAsJsonAsync("/api/calendar/events", new CalendarEventInput("", start, start.AddHours(1), null, null, null));
        Assert.Equal(HttpStatusCode.BadRequest, noTitle.StatusCode);

        var badTimes = await client.PostAsJsonAsync("/api/calendar/events", new CalendarEventInput("X", start, start.AddHours(-1), null, null, null));
        Assert.Equal(HttpStatusCode.BadRequest, badTimes.StatusCode);
    }
}
