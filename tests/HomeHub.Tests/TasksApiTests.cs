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

    [Fact]
    public async Task Create_lists_under_owner_and_everyone()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await CreateAsync(client, 1, "Astrid task");
        await CreateAsync(client, 2, "Ragnar task");

        var everyone = await client.GetFromJsonAsync<List<TaskItemDto>>("/api/tasks");
        Assert.Equal(2, everyone!.Count);

        var astrid = await client.GetFromJsonAsync<List<TaskItemDto>>("/api/tasks?profileId=1");
        Assert.Single(astrid!);
        Assert.Equal("Astrid task", astrid![0].Title);
        Assert.Equal("local", astrid[0].Source);
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
