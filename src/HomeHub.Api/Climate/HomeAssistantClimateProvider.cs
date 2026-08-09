namespace HomeHub.Api.Climate;

using HomeHub.Api.Data;
using HomeHub.Api.HomeAssistant;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

/// <summary>
/// Home Assistant climate provider: read all <c>climate.*</c> entities and call services to set
/// temperature / mode / scenes. The local <see cref="ClimateUnit"/> table is the offline cache.
/// Only used behind <see cref="IClimateProvider"/> and only when HA is configured. (Live push via
/// HA's WebSocket is Stage H4; reads are poll-based, matching the sensor/weather pattern.) No HA
/// specifics leak past this class.
/// </summary>
/// <remarks>
/// Stage H2: the HTTP plumbing that used to live here (base URL, bearer header, <c>api/states</c>
/// and <c>api/services/*</c> calls) moved to the shared <see cref="HomeAssistantClient"/> so
/// Huckleberry rides the same client. Behaviour is unchanged.
/// </remarks>
public sealed class HomeAssistantClimateProvider : IClimateProvider
{
    private readonly HomeAssistantClient _ha;
    private readonly HomeHubDbContext _db;
    private readonly HomeAssistantOptions _options;
    private readonly ILogger<HomeAssistantClimateProvider> _logger;

    public HomeAssistantClimateProvider(
        HomeAssistantClient ha, HomeHubDbContext db, IOptions<HomeAssistantOptions> options, ILogger<HomeAssistantClimateProvider> logger)
    {
        _ha = ha;
        _db = db;
        _options = options.Value;
        _logger = logger;
    }

    public string Source => "homeassistant";

    public async Task<IReadOnlyList<ClimateUnit>> GetUnitsAsync(CancellationToken ct)
    {
        try
        {
            var states = await _ha.GetStatesAsync("climate.", ct);
            var order = 0;
            foreach (var s in states)
            {
                await UpsertAsync(s, order++, ct);
            }
            await _db.SaveChangesAsync(ct);
        }
        // A caller that went away is not a failed fetch. Without this, every abandoned request —
        // a page reload, a poll overtaking its predecessor — logs "Home Assistant states fetch
        // failed", which sends anyone reading the logs after an incident looking at HA.
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Home Assistant states fetch failed; serving cached climate.");
        }

        return await _db.ClimateUnits
            .Where(z => z.Source == Source)
            .OrderBy(z => z.DisplayOrder)
            .ToListAsync(ct);
    }

    public async Task<ClimateUnit?> SetSetPointAsync(int id, double setPointF, CancellationToken ct)
    {
        var z = await _db.ClimateUnits.FindAsync([id], ct);
        if (z is null) return null;
        await _ha.CallServiceAsync("climate", "set_temperature", new { entity_id = z.ProviderRef, temperature = Math.Round(setPointF) }, ct);
        z.SetPointF = setPointF;
        z.UpdatedUtc = DateTime.UtcNow;
        await _db.SaveChangesAsync(ct);
        return z;
    }

    public async Task<ClimateUnit?> SetModeAsync(int id, ClimateMode mode, CancellationToken ct)
    {
        var z = await _db.ClimateUnits.FindAsync([id], ct);
        if (z is null) return null;
        await _ha.CallServiceAsync("climate", "set_hvac_mode", new { entity_id = z.ProviderRef, hvac_mode = ToHaMode(mode) }, ct);
        z.Mode = mode;
        z.UpdatedUtc = DateTime.UtcNow;
        await _db.SaveChangesAsync(ct);
        return z;
    }

    public async Task ApplySceneAsync(string scene, CancellationToken ct)
    {
        if (scene.Equals("all-off", StringComparison.OrdinalIgnoreCase))
        {
            var zones = await _db.ClimateUnits.Where(z => z.Source == Source).ToListAsync(ct);
            foreach (var z in zones)
            {
                await _ha.CallServiceAsync("climate", "set_hvac_mode", new { entity_id = z.ProviderRef, hvac_mode = "off" }, ct);
                z.Mode = ClimateMode.Off;
                z.UpdatedUtc = DateTime.UtcNow;
            }
            await _db.SaveChangesAsync(ct);
        }
        else if (scene.Equals("evening", StringComparison.OrdinalIgnoreCase))
        {
            await _ha.CallServiceAsync("scene", "turn_on", new { entity_id = _options.EveningScene }, ct);
        }
    }

    private async Task UpsertAsync(HaState s, int order, CancellationToken ct)
    {
        var mode = FromHaMode(s.State);
        var name = _options.ZoneNames.GetValueOrDefault(s.EntityId!)
            ?? s.FriendlyName ?? s.EntityId!;
        var existing = await _db.ClimateUnits.FirstOrDefaultAsync(z => z.Source == Source && z.ProviderRef == s.EntityId, ct);
        if (existing is null)
        {
            _db.ClimateUnits.Add(new ClimateUnit
            {
                Name = name,
                Source = Source,
                ProviderRef = s.EntityId!,
                CurrentTempF = s.GetDouble("current_temperature") ?? 0,
                SetPointF = s.GetDouble("temperature") ?? 72,
                Mode = mode,
                FanMode = s.GetString("fan_mode"),
                DisplayOrder = order,
                UpdatedUtc = DateTime.UtcNow,
            });
        }
        else
        {
            existing.Name = name;
            existing.CurrentTempF = s.GetDouble("current_temperature") ?? existing.CurrentTempF;
            existing.SetPointF = s.GetDouble("temperature") ?? existing.SetPointF;
            existing.Mode = mode;
            existing.FanMode = s.GetString("fan_mode");
            existing.DisplayOrder = order;
            existing.UpdatedUtc = DateTime.UtcNow;
        }
    }

    private static string ToHaMode(ClimateMode mode) => mode switch
    {
        ClimateMode.Cool => "cool",
        ClimateMode.Heat => "heat",
        ClimateMode.Fan => "fan_only",
        ClimateMode.Auto => "auto",
        _ => "off",
    };

    private static ClimateMode FromHaMode(string? state) => state switch
    {
        "cool" => ClimateMode.Cool,
        "heat" => ClimateMode.Heat,
        "fan_only" => ClimateMode.Fan,
        "auto" or "heat_cool" => ClimateMode.Auto,
        _ => ClimateMode.Off,
    };
}
