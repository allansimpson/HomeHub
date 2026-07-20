namespace HomeHub.Api.Controllers;

using HomeHub.Api.Tasks;
using Microsoft.AspNetCore.Mvc;

/// <summary>
/// Per-profile tasks via the task seam. A null <c>profileId</c> lists everyone (aggregate);
/// writes belong to the profile they target (normally the active profile). With Microsoft
/// configured these round-trip to To Do; otherwise they persist locally.
/// </summary>
[ApiController]
[Route("api/[controller]")]
public class TasksController : ControllerBase
{
    private readonly ITaskProvider _tasks;

    public TasksController(ITaskProvider tasks) => _tasks = tasks;

    /// <summary>Tasks for one profile, or all profiles when <paramref name="profileId"/> is omitted.</summary>
    [HttpGet]
    public async Task<IReadOnlyList<TaskItemDto>> List([FromQuery] int? profileId, CancellationToken ct)
    {
        var tasks = await _tasks.ListAsync(profileId, ct);
        return tasks.Select(TaskItemDto.From).ToList();
    }

    [HttpPost]
    public async Task<ActionResult<TaskItemDto>> Create(TaskCreateInput input, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(input.Title)) return BadRequest("Title is required.");
        if (input.ProfileId <= 0) return BadRequest("A profile is required.");
        var created = await _tasks.CreateAsync(input, ct);
        return CreatedAtAction(nameof(List), new { id = created.Id }, TaskItemDto.From(created));
    }

    [HttpPatch("{id:int}/complete")]
    public async Task<ActionResult<TaskItemDto>> Complete(int id, TaskCompleteInput input, CancellationToken ct)
    {
        var updated = await _tasks.SetCompletedAsync(id, input.Completed, ct);
        return updated is null ? NotFound() : TaskItemDto.From(updated);
    }

    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id, CancellationToken ct)
    {
        var ok = await _tasks.DeleteAsync(id, ct);
        return ok ? NoContent() : NotFound();
    }
}
