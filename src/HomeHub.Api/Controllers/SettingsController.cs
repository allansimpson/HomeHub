namespace HomeHub.Api.Controllers;

using HomeHub.Api.Data;
using HomeHub.Api.Settings;
using HomeHub.Api.Weather;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

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
    /// <summary>The deployment's configured location — the fallback when the household has named none.</summary>
    private readonly IOptions<WeatherOptions> _weather;

    public SettingsController(HomeHubDbContext db, IOptions<WeatherOptions> weather)
    {
        _db = db;
        _weather = weather;
    }

    [HttpGet]
    public async Task<SettingsDto> Get() => SettingsDto.From(await GetOrCreate());

    [HttpPut]
    public async Task<SettingsDto> Update(UpdateSettingsRequest req)
    {
        var s = await GetOrCreate();
        s.IdleTimeoutMinutes = Math.Clamp(req.IdleTimeoutMinutes, 1, 120);
        s.IdleDimmingEnabled = req.IdleDimmingEnabled;
        s.DaylightBoost = req.DaylightBoost is "auto" or "on" or "off" ? req.DaylightBoost : "auto";
        // Absent means leave it alone, so a screen showing the idle controls without the window
        // cannot blank the schedule by omission.
        if (Clock.Read(req.NightDimStart) is { } start) s.NightDimStart = start;
        if (Clock.Read(req.NightDimEnd) is { } end) s.NightDimEnd = end;
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

    /// <summary>
    /// Assist's conversation policy: whether chats are kept, and for how long.
    /// </summary>
    /// <remarks>
    /// Household state rather than panel state, because the transcripts are: they moved from the
    /// panel's <c>localStorage</c> to <see cref="Assist.Conversation"/> when Assist became a chat
    /// system the phone can also read. A window held on the panel would now govern nothing, and the
    /// two devices would disagree about how long the household keeps its own conversations.
    /// <para>
    /// The window is clamped rather than rejected, matching the litter threshold above: the value
    /// comes from a row of chips that cannot produce anything else. Turning storing <b>off does not
    /// delete anything</b> — it stops new writes. Deleting is an explicit act with a modal in front
    /// of it, and quietly emptying the ledger from a settings toggle would be exactly the surprise
    /// that modal exists to prevent.
    /// </para>
    /// <para>
    /// <b>Zero is NEVER</b> — kept until somebody deletes them — and is deliberately not the same
    /// answer as switching storing off. Off means the chat in front of you is all there is; zero means
    /// keep everything, forever. A household that wanted the second and was only offered the first
    /// would have to choose between losing its history on a schedule and not having one at all.
    /// </para>
    /// </remarks>
    [HttpPut("conversation-policy")]
    public async Task<SettingsDto> SetConversationPolicy(SetConversationPolicyRequest req)
    {
        var s = await GetOrCreate();
        s.StoreConversations = req.StoreConversations;
        s.ConversationRetentionDays = req.RetentionDays <= 0 ? 0 : Math.Clamp(req.RetentionDays, 1, 365);
        await _db.SaveChangesAsync();
        return SettingsDto.From(s);
    }

    /// <summary>
    /// Where the weather is for — what is in force now, and whether the household chose it.
    /// </summary>
    /// <remarks>
    /// Its own read as well as its own write, because the interesting part of the answer is not in
    /// <see cref="SettingsDto"/> and cannot be: the effective coordinates depend on the deployment's
    /// configuration, and the place name comes from the last forecast NWS returned. The panel needs
    /// all three to draw a page that means anything.
    /// </remarks>
    [HttpGet("weather-location")]
    public async Task<WeatherLocationDto> GetWeatherLocation()
    {
        var s = await GetOrCreate();
        var (lat, lon) = WeatherRefresher.LocationFor(s, _weather.Value);
        return new WeatherLocationDto(
            lat, lon,
            FromHousehold: s.WeatherLatitude is not null && s.WeatherLongitude is not null,
            Place: await LastKnownPlace());
    }

    /// <summary>
    /// Move the weather.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>The cache is dropped, not updated.</b> Everything stored under it — current conditions,
    /// the hourly strip, the week ahead, and the place name — is about the old location, and leaving
    /// it there means the panel shows the previous town's forecast under the new town's name until the
    /// next poll. That window is up to <c>Weather:PollMinutes</c> long, and it is the exact window in
    /// which somebody is standing at the screen checking whether their change worked.
    /// </para>
    /// <para>
    /// So the household briefly sees "Loading weather…" instead, which is true. The poller fills it in
    /// on its next tick; a refresh is not forced from here because a wrong coordinate would then cost
    /// a synchronous round trip to NWS on a settings save, and the failure is invisible either way.
    /// </para>
    /// <para>
    /// <b>400, not a clamp.</b> Every other setting here clamps, because every other one arrives from
    /// a stepper or a row of chips that cannot produce a bad value. This one is two typed numbers, so
    /// wrong input is not merely reachable but likely — and there is no "nearest sane latitude" to fall
    /// back to. A silently corrected coordinate is a forecast for somewhere nobody asked about.
    /// </para>
    /// </remarks>
    [HttpPut("weather-location")]
    public async Task<ActionResult<WeatherLocationDto>> SetWeatherLocation(SetWeatherLocationRequest req)
    {
        // Half a coordinate is not a location. Clearing means clearing both.
        if (req.Latitude is null != req.Longitude is null) return BadRequest();
        if (req.Latitude is { } lat && (double.IsNaN(lat) || lat is < -90 or > 90)) return BadRequest();
        if (req.Longitude is { } lon && (double.IsNaN(lon) || lon is < -180 or > 180)) return BadRequest();

        var s = await GetOrCreate();
        var moved = s.WeatherLatitude != req.Latitude || s.WeatherLongitude != req.Longitude;
        s.WeatherLatitude = req.Latitude;
        s.WeatherLongitude = req.Longitude;

        if (moved)
        {
            var cache = await _db.WeatherCache.FirstOrDefaultAsync(c => c.Id == 1);
            if (cache is not null) _db.WeatherCache.Remove(cache);
        }

        await _db.SaveChangesAsync();

        var (effLat, effLon) = WeatherRefresher.LocationFor(s, _weather.Value);
        return new WeatherLocationDto(
            effLat, effLon,
            FromHousehold: s.WeatherLatitude is not null && s.WeatherLongitude is not null,
            // Nothing yet, by construction, when the location just changed — and saying so is more
            // honest than handing back the old town's name beside the new town's coordinates.
            Place: moved ? null : await LastKnownPlace());
    }

    /// <summary>What NWS called this location on the last successful refresh, if there has been one.</summary>
    private async Task<string?> LastKnownPlace()
    {
        var cache = await _db.WeatherCache.AsNoTracking().FirstOrDefaultAsync(c => c.Id == 1);
        if (cache is null) return null;
        try
        {
            return System.Text.Json.JsonSerializer.Deserialize<WeatherSnapshotDto>(cache.PayloadJson)?.Place?.Label;
        }
        catch (System.Text.Json.JsonException)
        {
            // A payload written by an older build, before snapshots carried a place. Not an error —
            // the next refresh rewrites it — and certainly not one worth failing a settings page over.
            return null;
        }
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
