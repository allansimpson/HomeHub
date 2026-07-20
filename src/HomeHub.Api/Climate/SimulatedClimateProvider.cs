namespace HomeHub.Api.Climate;

using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// Local, SQL-backed climate used until Home Assistant is configured. Running zones drift their
/// current temperature toward the set point on each read; off zones drift toward an ambient
/// baseline — so the panel behaves believably (adjust a set point and watch it approach) without
/// any hardware. When HA is wired in, <see cref="HomeAssistantClimateProvider"/> takes over.
/// </summary>
public sealed class SimulatedClimateProvider : IClimateProvider
{
    private const double MinSetPoint = 60;
    private const double MaxSetPoint = 85;
    private const double AmbientF = 75;
    private const double DriftStep = 0.4;

    private readonly HomeHubDbContext _db;

    public SimulatedClimateProvider(HomeHubDbContext db) => _db = db;

    public string Source => "simulated";

    public async Task<IReadOnlyList<ClimateZone>> GetZonesAsync(CancellationToken ct)
    {
        var zones = await _db.ClimateZones.OrderBy(z => z.DisplayOrder).ToListAsync(ct);
        var changed = false;
        foreach (var z in zones)
        {
            var target = z.Mode == ClimateMode.Off ? AmbientF : z.SetPointF;
            var delta = target - z.CurrentTempF;
            if (Math.Abs(delta) > 0.05)
            {
                z.CurrentTempF = Math.Abs(delta) <= DriftStep ? target : z.CurrentTempF + Math.Sign(delta) * DriftStep;
                changed = true;
            }
        }
        if (changed) await _db.SaveChangesAsync(ct);
        return zones;
    }

    public async Task<ClimateZone?> SetSetPointAsync(int id, double setPointF, CancellationToken ct)
    {
        var z = await _db.ClimateZones.FindAsync([id], ct);
        if (z is null) return null;
        z.SetPointF = Math.Clamp(setPointF, MinSetPoint, MaxSetPoint);
        z.UpdatedUtc = DateTime.UtcNow;
        await _db.SaveChangesAsync(ct);
        return z;
    }

    public async Task<ClimateZone?> SetModeAsync(int id, ClimateMode mode, CancellationToken ct)
    {
        var z = await _db.ClimateZones.FindAsync([id], ct);
        if (z is null) return null;
        z.Mode = mode;
        z.UpdatedUtc = DateTime.UtcNow;
        await _db.SaveChangesAsync(ct);
        return z;
    }

    public async Task ApplySceneAsync(string scene, CancellationToken ct)
    {
        var zones = await _db.ClimateZones.ToListAsync(ct);
        foreach (var z in zones)
        {
            if (scene.Equals("all-off", StringComparison.OrdinalIgnoreCase))
            {
                z.Mode = ClimateMode.Off;
            }
            else if (scene.Equals("evening", StringComparison.OrdinalIgnoreCase))
            {
                z.Mode = ClimateMode.Cool;
                z.SetPointF = 70;
                z.FanMode = "Quiet";
            }
            z.UpdatedUtc = DateTime.UtcNow;
        }
        await _db.SaveChangesAsync(ct);
    }
}
