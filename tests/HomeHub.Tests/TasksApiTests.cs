namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Tasks;

/// <summary>
/// Stage 5 per-profile tasks over HTTP against the local SQL provider (default when Microsoft
/// isn't configured), backed by an isolated in-memory database seeded with the three profiles.
/// </summary>
public class TasksApiTests
{
    private static async Task<TaskItemDto> CreateAsync(HttpClient client, int profileId, string title) =>
        (await (await client.PostAsJsonAsync("/api/tasks", new TaskCreateInput(profileId, title, null, null)))
            .Content.ReadFromJsonAsync<TaskItemDto>())!;

    /// <summary>
    /// The list is the caller's, and naming somebody else in the URL does not change that.
    /// </summary>
    /// <remarks>
    /// This used to assert that <c>/api/tasks</c> with no parameter returned *everyone's* tasks and
    /// that <c>?profileId=</c> narrowed it. Both halves are gone (AUDIT A1.2): there is no
    /// household-wide task read any more, because the endpoint answers "my tasks" and the query
    /// parameter that used to choose whose is ignored.
    /// </remarks>
    [Fact]
    public async Task The_task_list_is_the_signed_in_members_own()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient(profileId: 1);

        await CreateAsync(client, 1, "Astrid task");
        await CreateAsync(app.CreateSeededClient(profileId: 2), 2, "Ragnar task");

        var astrid = await client.GetFromJsonAsync<List<TaskItemDto>>("/api/tasks");
        Assert.Single(astrid!);
        Assert.Equal("Astrid task", astrid![0].Title);
        Assert.Equal("local", astrid[0].Source);

        // The old narrowing parameter, still sent, now doing nothing.
        var spoofed = await client.GetFromJsonAsync<List<TaskItemDto>>("/api/tasks?profileId=2");
        Assert.Single(spoofed!);
        Assert.Equal("Astrid task", spoofed![0].Title);
    }

    [Fact]
    public async Task Complete_and_uncomplete_toggle()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var task = await CreateAsync(client, 3, "Feed the goldfish");
        Assert.False(task.Completed);

        var completed = await (await client.PatchAsJsonAsync($"/api/tasks/{task.Id}/complete", new TaskCompleteInput(true)))
            .Content.ReadFromJsonAsync<TaskItemDto>();
        Assert.True(completed!.Completed);

        var reopened = await (await client.PatchAsJsonAsync($"/api/tasks/{task.Id}/complete", new TaskCompleteInput(false)))
            .Content.ReadFromJsonAsync<TaskItemDto>();
        Assert.False(reopened!.Completed);
    }

    [Fact]
    public async Task Completed_tasks_sort_after_open_ones()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var a = await CreateAsync(client, 1, "First open");
        var b = await CreateAsync(client, 1, "Will complete");
        await client.PatchAsJsonAsync($"/api/tasks/{a.Id}/complete", new TaskCompleteInput(true));

        var list = await client.GetFromJsonAsync<List<TaskItemDto>>("/api/tasks?profileId=1");

        Assert.Equal(2, list!.Count);
        Assert.Equal(b.Id, list[0].Id);   // open first
        Assert.True(list[1].Completed);   // completed last
    }

    [Fact]
    public async Task Delete_removes_the_task()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var task = await CreateAsync(client, 2, "Collect dry cleaning");

        var del = await client.DeleteAsync($"/api/tasks/{task.Id}");
        Assert.Equal(HttpStatusCode.NoContent, del.StatusCode);

        var list = await client.GetFromJsonAsync<List<TaskItemDto>>("/api/tasks");
        Assert.Empty(list!);
    }

    [Fact]
    public async Task Rejects_task_without_title_or_profile()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var noTitle = await client.PostAsJsonAsync("/api/tasks", new TaskCreateInput(1, "", null, null));
        Assert.Equal(HttpStatusCode.BadRequest, noTitle.StatusCode);

        var noProfile = await client.PostAsJsonAsync("/api/tasks", new TaskCreateInput(0, "Orphan", null, null));
        Assert.Equal(HttpStatusCode.BadRequest, noProfile.StatusCode);
    }
}
