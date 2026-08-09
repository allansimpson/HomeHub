namespace HomeHub.Api.Controllers;

using System.Text.Json;
using HomeHub.Api.Data;
using HomeHub.Api.Weather;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// Serves the cached weather snapshot (current + hourly + daily) written by the weather poller.
/// Weather <em>alerts</em> are not here — they flow through the shared alert engine and the
/// existing <c>/api/alerts</c> endpoint, so the banner logic stays single-sourced (Stage 2).
/// </summary>
[ApiController]
[Route("api/[controller]")]
public class WeatherController : ControllerBase
{
    private readonly HomeHubDbContext _db;

    public WeatherController(HomeHubDbContext db) => _db = db;

    /// <summary>Last-known current conditions + hourly + daily forecast. Empty until the first poll.</summary>
    [HttpGet]
    public async Task<WeatherSnapshotDto> Get()
    {
        var cache = await _db.WeatherCache.AsNoTracking().FirstOrDefaultAsync(c => c.Id == 1);
        if (cache is null) return WeatherSnapshotDto.Empty;
        return JsonSerializer.Deserialize<WeatherSnapshotDto>(cache.PayloadJson) ?? WeatherSnapshotDto.Empty;
    }
}
