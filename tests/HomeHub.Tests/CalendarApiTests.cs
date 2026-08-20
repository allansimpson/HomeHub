namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Calendar;
using HomeHub.Api.Data;
using Microsoft.Extensions.DependencyInjection;

/// <summary>
/// Stage 4 calendar CRUD + range/upcoming queries over HTTP against the local SQL provider
/// (the default when Google isn't configured), backed by an isolated in-memory database.
/// </summary>
public class CalendarApiTests
{
    private static CalendarEventInput Sample(DateTime startUtc, string title = "Dinner", int hours = 2, int[]? owners = null) =>
        new(title, startUtc, startUtc.AddHours(hours), "Verdi's", "Bring wine", owners);

    private static int AddProfileOwnedEvent(HubAppFactory app, int profileId = 1, string? photoFile = null)
    {
        _ = app.CreateSeededClient(); // Start the host and seed profiles before direct setup.
        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
        var owned = new CalendarEvent
        {
            Source = "google",
            ProfileId = profileId,
            Title = "Private appointment",
            StartUtc = new DateTime(2026, 7, 22, 10, 0, 0, DateTimeKind.Utc),
            EndUtc = new DateTime(2026, 7, 22, 11, 0, 0, DateTimeKind.Utc),
            PhotoFile = photoFile,
            CreatedUtc = DateTime.UtcNow,
            UpdatedUtc = DateTime.UtcNow,
        };
        db.CalendarEvents.Add(owned);
        db.SaveChanges();
        return owned.Id;
    }

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
    public async Task Event_mark_round_trips_and_clears()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var start = new DateTime(2026, 7, 23, 17, 0, 0, DateTimeKind.Utc);

        var created = await (await client.PostAsJsonAsync(
            "/api/calendar/events",
            Sample(start, "Theo — Swim Lesson") with { Mark = "swim" }))
            .Content.ReadFromJsonAsync<CalendarEventDto>();
        Assert.Equal("swim", created!.Mark);

        // Blank is "inherit", not an empty mark — it must come back as null rather than "".
        var cleared = await (await client.PutAsJsonAsync(
            $"/api/calendar/events/{created.Id}",
            Sample(start, "Theo — Swim Lesson") with { Mark = "  " }))
            .Content.ReadFromJsonAsync<CalendarEventDto>();
        Assert.Null(cleared!.Mark);
    }

    [Fact]
    public async Task Another_member_cannot_create_for_a_profile_they_do_not_control()
    {
        using var app = new HubAppFactory();
        var otherMember = app.CreateSeededClient(profileId: 2);
        var start = new DateTime(2026, 7, 22, 10, 0, 0, DateTimeKind.Utc);

        var response = await otherMember.PostAsJsonAsync(
            "/api/calendar/events", Sample(start, "Private appointment") with { ProfileId = 1 });

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task Another_member_cannot_read_a_profile_owned_event()
    {
        using var app = new HubAppFactory();
        var eventId = AddProfileOwnedEvent(app);
        var otherMember = app.CreateSeededClient(profileId: 2);

        Assert.Equal(HttpStatusCode.Forbidden,
            (await otherMember.GetAsync($"/api/calendar/events/{eventId}")).StatusCode);
    }

    [Fact]
    public async Task Another_member_cannot_update_a_profile_owned_event()
    {
        using var app = new HubAppFactory();
        var eventId = AddProfileOwnedEvent(app);
        var otherMember = app.CreateSeededClient(profileId: 2);
        var start = new DateTime(2026, 7, 23, 10, 0, 0, DateTimeKind.Utc);

        var response = await otherMember.PutAsJsonAsync(
            $"/api/calendar/events/{eventId}", Sample(start, "Changed by another member"));

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task Another_member_cannot_delete_a_profile_owned_event()
    {
        using var app = new HubAppFactory();
        var eventId = AddProfileOwnedEvent(app);
        var otherMember = app.CreateSeededClient(profileId: 2);

        var response = await otherMember.DeleteAsync($"/api/calendar/events/{eventId}");

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
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
