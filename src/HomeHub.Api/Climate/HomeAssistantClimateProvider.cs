namespace HomeHub.Api.Climate;

using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

/// <summary>
/// Home Assistant climate provider over HA's REST API (long-lived token): read all
/// <c>climate.*</c> entities and call services to set temperature / mode / scenes. The local
/// <see cref="ClimateZone"/> table is the offline cache. Only used behind <see cref="IClimateProvider"/>
/// and only when HA is configured. (Live push via HA's WebSocket is a later enhancement; reads
/// are poll-based, matching the sensor/weather pattern.) No HA specifics leak past this class.
/// </summary>
public sealed class HomeAssistantClimateProvider : IClimateProvider
{
    private readonly HttpClient _http;
    private readonly HomeHubDbContext _db;
    private readonly HomeAssistantOptions _options;
    private readonly ILogger<HomeAssistantClimateProvider> _logger;

    public HomeAssistantClimateProvider(
        HttpClient http, HomeHubDbContext db, IOptions<HomeAssistantOptions> options, ILogger<HomeAssistantClimateProvider> logger)
    {
        _http = http;
        _db = db;
        _options = options.Value;
        _logger = logger;
        _http.BaseAddress = new Uri(_options.BaseUrl!.TrimEnd('/') + "/");
        _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _options.Token);
    }

    public string Source => "homeassistant";

    public async Task<IReadOnlyList<ClimateZone>> GetZonesAsync(CancellationToken ct)
    {
        try
        {
            var states = await _http.GetFromJsonAsync<List<HaState>>("api/states", ct) ?? [];
            var order = 0;
            foreach (var s in states.Where(s => s.EntityId?.StartsWith("climate.") == true))
            {
                await UpsertAsync(s, order++, ct);
            }
            await _db.SaveChangesAsync(ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Home Assistant states fetch failed; serving cached climate.");
        }

        return await _db.ClimateZones
            .Where(z => z.Source == Source)
            .OrderBy(z => z.DisplayOrder)
            .ToListAsync(ct);
    }

    public async Task<ClimateZone?> SetSetPointAsync(int id, double setPointF, CancellationToken ct)
    {
        var z = await _db.ClimateZones.FindAsync([id], ct);
        if (z is null) return null;
        await CallServiceAsync("climate/set_temperature", new { entity_id = z.ProviderRef, temperature = Math.Round(setPointF) }, ct);
        z.SetPointF = setPointF;
        z.UpdatedUtc = DateTime.UtcNow;
        await _db.SaveChangesAsync(ct);
        return z;
    }

    public async Task<ClimateZone?> SetModeAsync(int id, ClimateMode mode, CancellationToken ct)
    {
        var z = await _db.ClimateZones.FindAsync([id], ct);
        if (z is null) return null;
        await CallServiceAsync("climate/set_hvac_mode", new { entity_id = z.ProviderRef, hvac_mode = ToHaMode(mode) }, ct);
        z.Mode = mode;
        z.UpdatedUtc = DateTime.UtcNow;
        await _db.SaveChangesAsync(ct);
        return z;
    }

    public async Task ApplySceneAsync(string scene, CancellationToken ct)
    {
        if (scene.Equals("all-off", StringComparison.OrdinalIgnoreCase))
        {
            var zones = await _db.ClimateZones.Where(z => z.Source == Source).ToListAsync(ct);
            foreach (var z in zones)
            {
                await CallServiceAsync("climate/set_hvac_mode", new { entity_id = z.ProviderRef, hvac_mode = "off" }, ct);
                z.Mode = ClimateMode.Off;
                z.UpdatedUtc = DateTime.UtcNow;
            }
            await _db.SaveChangesAsync(ct);
        }
        else if (scene.Equals("evening", StringComparison.OrdinalIgnoreCase))
        {
            await CallServiceAsync("scene/turn_on", new { entity_id = _options.EveningScene }, ct);
        }
    }

    private async Task UpsertAsync(HaState s, int order, CancellationToken ct)
    {
        var mode = FromHaMode(s.State);
        var name = _options.ZoneNames.GetValueOrDefault(s.EntityId!)
            ?? s.Attributes?.FriendlyName ?? s.EntityId!;
        var existing = await _db.ClimateZones.FirstOrDefaultAsync(z => z.Source == Source && z.ProviderRef == s.EntityId, ct);
        if (existing is null)
        {
            _db.ClimateZones.Add(new ClimateZone
            {
                Name = name,
                Source = Source,
                ProviderRef = s.EntityId!,
                CurrentTempF = s.Attributes?.CurrentTemperature ?? 0,
                SetPointF = s.Attributes?.Temperature ?? 72,
                Mode = mode,
                FanMode = s.Attributes?.FanMode,
                DisplayOrder = order,
                UpdatedUtc = DateTime.UtcNow,
            });
        }
        else
        {
            existing.Name = name;
            existing.CurrentTempF = s.Attributes?.CurrentTemperature ?? existing.CurrentTempF;
            existing.SetPointF = s.Attributes?.Temperature ?? existing.SetPointF;
            existing.Mode = mode;
            existing.FanMode = s.Attributes?.FanMode;
            existing.DisplayOrder = order;
            existing.UpdatedUtc = DateTime.UtcNow;
        }
    }

    private async Task CallServiceAsync(string service, object payload, CancellationToken ct)
    {
        using var res = await _http.PostAsJsonAsync($"api/services/{service}", payload, ct);
        res.EnsureSuccessStatusCode();
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

    // ---- HA REST shapes (partial; HA uses snake_case) ----
    private sealed record HaState(
        [property: JsonPropertyName("entity_id")] string? EntityId,
        [property: JsonPropertyName("state")] string? State,
        [property: JsonPropertyName("attributes")] HaAttributes? Attributes);
    private sealed record HaAttributes(
        [property: JsonPropertyName("current_temperature")] double? CurrentTemperature,
        [property: JsonPropertyName("temperature")] double? Temperature,
        [property: JsonPropertyName("fan_mode")] string? FanMode,
        [property: JsonPropertyName("friendly_name")] string? FriendlyName);
}
