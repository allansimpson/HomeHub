namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Calendar;
using HomeHub.Api.Tasks;

/// <summary>
/// Stage 9b optimistic-concurrency: conditional writes carry the version the client last saw
/// (<c>?baseVersion=</c>). A stale version → 409 (so the offline write-queue surfaces the conflict
/// rather than overwriting); a matching version bumps and succeeds; a missing target → 404.
/// </summary>
public class ConcurrencyTests
{
    // ---- Calendar ----
    [Fact]
    public async Task Calendar_update_bumps_version_and_stale_update_conflicts()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var start = new DateTime(2026, 7, 20, 18, 0, 0, DateTimeKind.Utc);
        var created = await (await client.PostAsJsonAsync("/api/calendar/events",
            new CalendarEventInput("Dinner", start, start.AddHours(2), null, null, null)))
            .Content.ReadFromJsonAsync<CalendarEventDto>();
        Assert.Equal(1, created!.Version);

        // Correct base version → succeeds and bumps to 2.
        var ok = await client.PutAsJsonAsync($"/api/calendar/events/{created.Id}?baseVersion=1",
            new CalendarEventInput("Dinner (moved)", start, start.AddHours(2), null, null, null));
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        var updated = await ok.Content.ReadFromJsonAsync<CalendarEventDto>();
        Assert.Equal(2, updated!.Version);

        // Replaying a stale edit (still thinks it's v1) → 409 with current server state.
        var stale = await client.PutAsJsonAsync($"/api/calendar/events/{created.Id}?baseVersion=1",
            new CalendarEventInput("Dinner (stale)", start, start.AddHours(2), null, null, null));
        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
        var current = await stale.Content.ReadFromJsonAsync<CalendarEventDto>();
        Assert.Equal("Dinner (moved)", current!.Title);
        Assert.Equal(2, current.Version);
    }

    [Fact]
    public async Task Calendar_update_without_base_version_is_last_write_wins()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var start = new DateTime(2026, 7, 20, 18, 0, 0, DateTimeKind.Utc);
        var created = await (await client.PostAsJsonAsync("/api/calendar/events",
            new CalendarEventInput("A", start, start.AddHours(1), null, null, null)))
            .Content.ReadFromJsonAsync<CalendarEventDto>();

        // No baseVersion → no check.
        var ok = await client.PutAsJsonAsync($"/api/calendar/events/{created!.Id}",
            new CalendarEventInput("B", start, start.AddHours(1), null, null, null));
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
    }

    [Fact]
    public async Task Calendar_stale_delete_conflicts_and_missing_delete_404s()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var start = new DateTime(2026, 7, 20, 18, 0, 0, DateTimeKind.Utc);
        var created = await (await client.PostAsJsonAsync("/api/calendar/events",
            new CalendarEventInput("X", start, start.AddHours(1), null, null, null)))
            .Content.ReadFromJsonAsync<CalendarEventDto>();
        // Bump to v2.
        await client.PutAsJsonAsync($"/api/calendar/events/{created!.Id}?baseVersion=1",
            new CalendarEventInput("X2", start, start.AddHours(1), null, null, null));

        var staleDelete = await client.DeleteAsync($"/api/calendar/events/{created.Id}?baseVersion=1");
        Assert.Equal(HttpStatusCode.Conflict, staleDelete.StatusCode);

        var missing = await client.DeleteAsync("/api/calendar/events/9999?baseVersion=1");
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
    }

    // ---- Tasks ----
    [Fact]
    public async Task Task_complete_bumps_version_and_stale_complete_conflicts()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var created = await (await client.PostAsJsonAsync("/api/tasks",
            new TaskCreateInput(1, "Water plants", null, null)))
            .Content.ReadFromJsonAsync<TaskItemDto>();
        Assert.Equal(1, created!.Version);

        var ok = await client.PatchAsJsonAsync($"/api/tasks/{created.Id}/complete?baseVersion=1", new TaskCompleteInput(true));
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        var done = await ok.Content.ReadFromJsonAsync<TaskItemDto>();
        Assert.Equal(2, done!.Version);
        Assert.True(done.Completed);

        var stale = await client.PatchAsJsonAsync($"/api/tasks/{created.Id}/complete?baseVersion=1", new TaskCompleteInput(false));
        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
    }

    [Fact]
    public async Task Task_missing_delete_404s()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var missing = await client.DeleteAsync("/api/tasks/9999?baseVersion=1");
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
    }
}
