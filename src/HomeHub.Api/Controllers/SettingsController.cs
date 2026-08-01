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
        s.DaylightBoost = req.DaylightBoost is "auto" or "on" or "off" ? req.DaylightBoost : "auto";
        await _db.SaveChangesAsync();
        return SettingsDto.From(s);
    }

    /// <summary>
    /// The cat's name — the one litter setting the panel owns rather than Home Assistant.
    /// </summary>
    /// <remarks>
    /// Blank or whitespace clears it, and every sentence that uses the name falls back to the literal
    /// word "cat". Length is capped because the name lands inside letterspaced caps on a fixed-width
    /// band (<c>MIKA'S BOX · LR4</c>), where an unbounded string would push the model off the screen.
    /// </remarks>
    [HttpPut("cat-name")]
    public async Task<SettingsDto> SetCatName(SetCatNameRequest req)
    {
        var s = await GetOrCreate();
        var name = req.Name?.Trim();
        s.CatName = string.IsNullOrEmpty(name) ? null : name[..Math.Min(name.Length, 24)];
        await _db.SaveChangesAsync();
        return SettingsDto.From(s);
    }

    /// <summary>Light endpoint for the frequent profile-switch action.</summary>
    /// <summary>
    /// Set the drawer fullness at which the panel asks for a litter change.
    /// </summary>
    /// <remarks>
    /// Clamped to 10–100 rather than validated with a 400. The value arrives from a stepper that
    /// cannot produce anything outside that range, so a rejection would only ever be reachable by a
    /// hand-crafted request — and the useful behaviour there is still "the nearest sane threshold",
    /// not an error the panel would have to render. The floor exists because a threshold below about
    /// ten percent fires on a drawer that was just emptied, which trains people to ignore it.
    /// </remarks>
    [HttpPut("litter-full-percent")]
    public async Task<SettingsDto> SetLitterFullPercent(SetLitterFullPercentRequest req)
    {
        var s = await GetOrCreate();
        s.LitterFullPercent = Math.Clamp(req.Percent, 10, 100);
        await _db.SaveChangesAsync();
        return SettingsDto.From(s);
    }

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
