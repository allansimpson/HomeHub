namespace HomeHub.Api.Controllers;

using HomeHub.Api.Data;
using HomeHub.Api.Tasks;
using HomeHub.Api.Auth;
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

    /// <summary>The caller's tasks (AUDIT A1.2 — this took <c>?profileId=</c>).</summary>
    [HttpGet]
    public async Task<IReadOnlyList<TaskItemDto>> List(CancellationToken ct)
    {
        var tasks = await _tasks.ListAsync(this.CallerId(), ct);
        return tasks.Select(TaskItemDto.From).ToList();
    }

    [HttpPost]
    public async Task<ActionResult<TaskItemDto>> Create(TaskCreateInput input, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(input.Title)) return BadRequest("Title is required.");
        // Filing a task onto another member's list is a settings-screen action, not a composer one,
        // so the same self-or-admin rule applies here as to the list configuration below.
        if (!this.MayActFor(input.ProfileId)) return Forbid();
        if (input.ProfileId <= 0) return BadRequest("A profile is required.");
        var created = await _tasks.CreateAsync(input, ct);
        return CreatedAtAction(nameof(List), new { id = created.Id }, TaskItemDto.From(created));
    }

    [HttpPatch("{id:int}/complete")]
    public async Task<ActionResult<TaskItemDto>> Complete(int id, TaskCompleteInput input, [FromQuery] int? baseVersion, CancellationToken ct)
    {
        var existing = await _tasks.GetAsync(id, ct);
        if (existing is null) return NotFound();
        if (!this.MayActFor(existing.ProfileId)) return Forbid();
        try
        {
            var updated = await _tasks.SetCompletedAsync(id, input.Completed, baseVersion, ct);
            return updated is null ? NotFound() : TaskItemDto.From(updated);
        }
        catch (ConcurrencyConflictException ex)
        {
            return Conflict(ex.Current);
        }
    }

    [HttpPatch("{id:int}/importance")]
    public async Task<ActionResult<TaskItemDto>> Importance(int id, TaskImportanceInput input, [FromQuery] int? baseVersion, CancellationToken ct)
    {
        var existing = await _tasks.GetAsync(id, ct);
        if (existing is null) return NotFound();
        if (!this.MayActFor(existing.ProfileId)) return Forbid();
        try
        {
            var updated = await _tasks.SetImportantAsync(id, input.Important, baseVersion, ct);
            return updated is null ? NotFound() : TaskItemDto.From(updated);
        }
        catch (ConcurrencyConflictException ex)
        {
            return Conflict(ex.Current);
        }
    }

    [HttpPatch("{id:int}/title")]
    public async Task<ActionResult<TaskItemDto>> Title(int id, TaskTitleInput input, [FromQuery] int? baseVersion, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(input.Title)) return BadRequest("Title is required.");
        var existing = await _tasks.GetAsync(id, ct);
        if (existing is null) return NotFound();
        if (!this.MayActFor(existing.ProfileId)) return Forbid();
        try
        {
            var updated = await _tasks.SetTitleAsync(id, input.Title, baseVersion, ct);
            return updated is null ? NotFound() : TaskItemDto.From(updated);
        }
        catch (ConcurrencyConflictException ex)
        {
            return Conflict(ex.Current);
        }
    }

    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id, [FromQuery] int? baseVersion, CancellationToken ct)
    {
        var existing = await _tasks.GetAsync(id, ct);
        if (existing is null) return NotFound();
        if (!this.MayActFor(existing.ProfileId)) return Forbid();
        try
        {
            var ok = await _tasks.DeleteAsync(id, baseVersion, ct);
            return ok ? NoContent() : NotFound();
        }
        catch (ConcurrencyConflictException ex)
        {
            return Conflict(ex.Current);
        }
    }

    /// <summary>The profile's Microsoft To Do lists with their sync selection (501 unless Graph is configured).</summary>
    [HttpGet("lists")]
    public async Task<ActionResult<IReadOnlyList<SyncListDto>>> Lists([FromQuery] int profileId, CancellationToken ct)
    {
        // Self-or-admin: configures a named member's Microsoft account from a settings screen.
        if (!this.MayActFor(profileId)) return Forbid();
        if (_tasks is not IListSyncProvider lister)
            return StatusCode(501, "List selection needs Microsoft To Do configured.");
        return Ok(await lister.GetListsAsync(profileId, ct));
    }

    /// <summary>Replace which lists a profile syncs (empty = sync none).</summary>
    [HttpPut("lists")]
    public async Task<IActionResult> SetLists(SetSyncedListsInput input, CancellationToken ct)
    {
        if (!this.MayActFor(input.ProfileId)) return Forbid();
        if (_tasks is not IListSyncProvider lister)
            return StatusCode(501, "List selection needs Microsoft To Do configured.");
        await lister.SetSelectedListsAsync(input.ProfileId, input.SelectedGraphListIds ?? [], ct);
        return NoContent();
    }
}
