namespace HomeHub.Api.Controllers;

using HomeHub.Api.Alerts;
using HomeHub.Api.Data;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// Active alerts for the banner, and the threshold editors that drive the engine. Editing a
/// threshold re-evaluates immediately so the banner reflects the new rule without waiting for
/// the next poll.
/// </summary>
[ApiController]
[Route("api/[controller]")]
public class AlertsController : ControllerBase
{
    private readonly HomeHubDbContext _db;
    private readonly AlertEngine _engine;

    public AlertsController(HomeHubDbContext db, AlertEngine engine)
    {
        _db = db;
        _engine = engine;
    }

    /// <summary>Currently-open alerts, most severe (then most recent) first.</summary>
    [HttpGet]
    public async Task<IReadOnlyList<ActiveAlertDto>> Active()
    {
        var alerts = await _db.ActiveAlerts
            .Where(a => a.ClearedAtUtc == null)
            .OrderByDescending(a => a.Severity)
            .ThenByDescending(a => a.StartedAtUtc)
            .ToListAsync();
        return alerts.Select(ActiveAlertDto.From).ToList();
    }

    /// <summary>All configurable thresholds, with their zone names.</summary>
    [HttpGet("thresholds")]
    public async Task<IReadOnlyList<ThresholdDto>> Thresholds()
    {
        var thresholds = await _db.AlertThresholds
            .Include(t => t.Zone)
            .OrderBy(t => t.ZoneId)
            .ToListAsync();
        return thresholds.Select(ThresholdDto.From).ToList();
    }

    [HttpPut("thresholds/{id:int}")]
    public async Task<ActionResult<ThresholdDto>> UpdateThreshold(int id, UpdateThresholdRequest req)
    {
        var threshold = await _db.AlertThresholds.Include(t => t.Zone).FirstOrDefaultAsync(t => t.Id == id);
        if (threshold is null) return NotFound();

        threshold.Value = req.Value;
        threshold.DurationMinutes = Math.Clamp(req.DurationMinutes, 0, 240);
        threshold.Enabled = req.Enabled;
        await _db.SaveChangesAsync();

        // Reflect the new rule immediately (raise/clear) rather than waiting for the next poll.
        await _engine.EvaluateAsync(_db, DateTime.UtcNow);

        return ThresholdDto.From(threshold);
    }
}
