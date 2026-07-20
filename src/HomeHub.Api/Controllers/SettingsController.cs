namespace HomeHub.Api.Controllers;

using HomeHub.Api.Data;
using HomeHub.Api.Settings;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// Household-level settings: idle timeout, idle dimming, alert-threshold defaults (stored now,
/// consumed in Stage 2), and the active profile. Always operates on the singleton row (id 1),
/// creating it on first access so the app is usable even against a freshly created database.
/// </summary>
[ApiController]
[Route("api/[controller]")]
public class SettingsController : ControllerBase
{
    private readonly HomeHubDbContext _db;

    public SettingsController(HomeHubDbContext db) => _db = db;

    [HttpGet]
    public async Task<SettingsDto> Get() => SettingsDto.From(await GetOrCreate());

    [HttpPut]
    public async Task<SettingsDto> Update(UpdateSettingsRequest req)
    {
        var s = await GetOrCreate();
        s.IdleTimeoutMinutes = Math.Clamp(req.IdleTimeoutMinutes, 1, 120);
        s.IdleDimmingEnabled = req.IdleDimmingEnabled;
        s.FreezerWarnAboveCelsius = req.FreezerWarnAboveCelsius;
        s.HumidityWarnAbovePercent = Math.Clamp(req.HumidityWarnAbovePercent, 0, 100);
        await _db.SaveChangesAsync();
        return SettingsDto.From(s);
    }

    /// <summary>Light endpoint for the frequent profile-switch action.</summary>
    [HttpPut("active-profile")]
    public async Task<SettingsDto> SetActiveProfile(SetActiveProfileRequest req)
    {
        var s = await GetOrCreate();
        // A null id clears the active profile (e.g. when locking); a non-null id must exist.
        if (req.ProfileId is { } pid && !await _db.Profiles.AnyAsync(p => p.Id == pid))
        {
            // Ignore a stale id rather than 400 — the panel may race a just-deleted profile.
            s.ActiveProfileId = null;
        }
        else
        {
            s.ActiveProfileId = req.ProfileId;
        }
        await _db.SaveChangesAsync();
        return SettingsDto.From(s);
    }

    private async Task<HouseholdSettings> GetOrCreate()
    {
        var s = await _db.Settings.FirstOrDefaultAsync(x => x.Id == 1);
        if (s is null)
        {
            s = new HouseholdSettings { Id = 1 };
            _db.Settings.Add(s);
            await _db.SaveChangesAsync();
        }
        return s;
    }
}
