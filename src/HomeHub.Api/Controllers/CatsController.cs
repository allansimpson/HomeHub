namespace HomeHub.Api.Controllers;

using HomeHub.Api.Cats;
using HomeHub.Api.Data;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

/// <summary>
/// Litter box reads and the manual recovery control, for the Cat section. No Home Assistant or Whisker
/// specifics leak here — only <see cref="ILitterRobotProvider"/> and
/// <see cref="LitterRobotRecoveryRunner"/>, and the SPA never calls Home Assistant itself.
/// </summary>
[ApiController]
[Route("api/cats")]
public class CatsController : ControllerBase
{
    private const int MaxHistoryDays = 90;

    private readonly ILitterRobotProvider _provider;
    private readonly LitterRobotRecoveryRunner _runner;
    private readonly RecoveryTracker _tracker;
    private readonly CatOptions _options;
    private readonly IServiceProvider _services;

    public CatsController(
        ILitterRobotProvider provider,
        LitterRobotRecoveryRunner runner,
        RecoveryTracker tracker,
        IOptions<CatOptions> options,
        IServiceProvider services)
    {
        _provider = provider;
        _runner = runner;
        _tracker = tracker;
        _options = options.Value;
        _services = services;
    }

    /// <summary>Whether the litter-box integration is connected, and how it's failing when it isn't.</summary>
    [HttpGet("health")]
    public async Task<CatHealthDto> Health(CancellationToken ct)
    {
        var health = await _provider.GetHealthAsync(ct);
        return new CatHealthDto(
            health.Status.ToString(), health.Detail, health.LastGoodUtc, _provider.IsConfigured);
    }

    /// <summary>Every robot with its current status and live recovery state — the Cat tab's main read.</summary>
    [HttpGet]
    public async Task<IReadOnlyList<LitterRobotDto>> List(CancellationToken ct)
    {
        var robots = await _provider.GetRobotsAsync(ct);
        var result = new List<LitterRobotDto>(robots.Count);
        foreach (var robot in robots)
        {
            var snapshot = await _provider.GetSnapshotAsync(robot.Slug, ct);
            if (snapshot is null) continue;
            result.Add(await ToDtoAsync(snapshot, ct));
        }
        return result;
    }

    /// <summary>One robot's snapshot.</summary>
    [HttpGet("{slug}")]
    public async Task<ActionResult<LitterRobotDto>> Get(string slug, CancellationToken ct)
    {
        var snapshot = await _provider.GetSnapshotAsync(slug, ct);
        return snapshot is null ? NotFound() : await ToDtoAsync(snapshot, ct);
    }

    /// <summary>
    /// Recovery attempt history — the record that distinguishes an occasionally-flaky robot from one
    /// that has started failing and needs a service call.
    /// </summary>
    [HttpGet("{slug}/recoveries")]
    public async Task<ActionResult<IReadOnlyList<RecoveryAttemptDto>>> Recoveries(
        string slug, [FromQuery] int days = 7, CancellationToken ct = default)
    {
        if (days is < 1 or > MaxHistoryDays) return BadRequest($"'days' must be between 1 and {MaxHistoryDays}.");

        var db = _services.GetService<HomeHubDbContext>();
        if (db is null) return Ok(Array.Empty<RecoveryAttemptDto>());

        var since = DateTime.UtcNow.AddDays(-days);
        var rows = await db.LitterRobotRecoveries
            .Where(r => r.Slug == slug && r.StartedAtUtc >= since)
            .OrderByDescending(r => r.StartedAtUtc)
            .ToListAsync(ct);

        return rows.Select(RecoveryAttemptDto.From).ToList();
    }

    /// <summary>
    /// Force a reset + clean cycle now.
    /// </summary>
    /// <remarks>
    /// Returns 409 with a machine-readable reason when the robot declines — which is the whole point of
    /// this endpoint existing rather than the SPA calling Home Assistant directly. The robot accepts
    /// commands it silently drops (a cycle requested with a cat detected does nothing and reports
    /// success), so a 200 here means the status was observed to change, not merely that a call was made.
    /// The cat interlock is enforced in the runner and this endpoint cannot override it.
    /// </remarks>
    [HttpPost("{slug}/cycle")]
    public async Task<ActionResult<CycleResultDto>> Cycle(string slug, CancellationToken ct)
    {
        var snapshot = await _provider.GetSnapshotAsync(slug, ct);
        if (snapshot is null) return NotFound();

        var result = await _runner.AttemptAsync(slug, attemptNumber: 1, manual: true, ct);
        var dto = new CycleResultDto(
            result.Recovered,
            result.Outcome.ToString(),
            result.Step.ToString(),
            result.ResultingCode,
            result.Detail);

        return result.Recovered ? Ok(dto) : Conflict(dto);
    }

    private async Task<LitterRobotDto> ToDtoAsync(LitterRobotSnapshot snapshot, CancellationToken ct)
    {
        var db = _services.GetService<HomeHubDbContext>();
        var attemptsToday = 0;
        if (db is not null)
        {
            var since = DateTime.UtcNow.AddDays(-1);
            attemptsToday = await db.LitterRobotRecoveries
                .CountAsync(r => r.Slug == snapshot.Slug && !r.Manual && r.StartedAtUtc >= since, ct);
        }

        var recovery = _tracker.Snapshot(snapshot.Slug, _options.Recovery.Enabled, attemptsToday);
        return LitterRobotDto.From(snapshot, recovery);
    }
}

public sealed record CatHealthDto(string Status, string? Detail, DateTimeOffset? LastGoodUtc, bool Configured);

/// <summary>
/// A litter box for the panel. <c>FaultClass</c> is what the UI should branch on — it collapses 25
/// status codes into the six outcomes that change what a person should do, so the Cat tab doesn't have
/// to know the vocabulary.
/// </summary>
public sealed record LitterRobotDto(
    string Slug,
    string Name,
    string StatusCode,
    string StatusText,
    string FaultClass,
    bool Usable,
    double? WasteDrawerPercent,
    double? LitterPercent,
    double? PetWeightLbs,
    int? TotalCycles,
    DateTimeOffset? LastSeenUtc,
    DateTimeOffset FetchedUtc,
    bool Stale,
    RecoveryStateDto Recovery)
{
    public static LitterRobotDto From(LitterRobotSnapshot s, RecoveryState r) => new(
        s.Slug,
        s.Name,
        s.Fault.Code,
        s.Fault.Text,
        s.Fault.Class.ToString(),
        s.IsUsable,
        s.WasteDrawerPercent,
        s.LitterPercent,
        s.PetWeightLbs,
        s.TotalCycles,
        s.LastSeenUtc,
        s.FetchedUtc,
        s.Stale,
        RecoveryStateDto.From(r));
}

public sealed record RecoveryStateDto(
    bool Enabled,
    string? ActiveFaultCode,
    DateTimeOffset? FaultSinceUtc,
    int AttemptsThisEpisode,
    int AttemptsToday,
    DateTimeOffset? LastAttemptUtc,
    DateTimeOffset? NextAttemptDueUtc,
    string? HoldReason)
{
    public static RecoveryStateDto From(RecoveryState r) => new(
        r.Enabled,
        r.ActiveFaultCode,
        r.FaultSinceUtc,
        r.AttemptsThisEpisode,
        r.AttemptsToday,
        r.LastAttemptUtc,
        r.NextAttemptDueUtc,
        r.HoldReason);
}

public sealed record RecoveryAttemptDto(
    int Id,
    string FaultCode,
    int AttemptNumber,
    string Step,
    string Outcome,
    string? ResultingCode,
    string? Detail,
    bool Manual,
    DateTime StartedAtUtc,
    DateTime? CompletedAtUtc)
{
    public static RecoveryAttemptDto From(LitterRobotRecovery r) => new(
        r.Id,
        r.FaultCode,
        r.AttemptNumber,
        r.Step.ToString(),
        r.Outcome.ToString(),
        r.ResultingCode,
        r.Detail,
        r.Manual,
        r.StartedAtUtc,
        r.CompletedAtUtc);
}

/// <summary>Outcome of a manual cycle request. <c>Reason</c> carries the robot's own refusal when it declines.</summary>
public sealed record CycleResultDto(
    bool Started, string Outcome, string Step, string? ResultingCode, string? Reason);
