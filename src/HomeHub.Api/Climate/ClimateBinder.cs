namespace HomeHub.Api.Climate;

using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// Ties each room to the probe that reads it and the unit that conditions it.
/// </summary>
/// <remarks>
/// A room is a thing the household names; a probe and a unit are things a vendor names. The seed can
/// only guess at how those line up, and the moment real hardware arrives its guess is wrong: Home
/// Assistant discovers <c>climate.*</c> entities as new rows, so a zone still pointing at a seeded
/// <c>sim-kitchen</c> would spend its life writing set points at a unit that does not exist and
/// recording the failures.
/// <para>
/// So the binding is re-established rather than assumed. The simulated stand-ins are dropped once a
/// real provider is live — the same move <c>SensorPollingService</c> makes for demo sensor zones —
/// and any room left unbound is matched to a probe or a unit <b>by name</b>. Name is the right key
/// here precisely because it is the household's word: someone who calls the room "Upstairs Office"
/// has almost certainly called the mini-split in it the same thing.
/// </para>
/// </remarks>
public sealed class ClimateBinder
{
    private const string SimulatedSource = "simulated";

    private readonly HomeHubDbContext _db;
    private readonly ILogger<ClimateBinder> _logger;

    public ClimateBinder(HomeHubDbContext db, ILogger<ClimateBinder> logger)
    {
        _db = db;
        _logger = logger;
    }

    /// <summary>
    /// Reconcile the bindings. Cheap and idempotent — with everything bound it is two queries and no
    /// writes, which is what lets the loop call it on every tick rather than only at startup.
    /// </summary>
    public async Task BindAsync(string activeSource, CancellationToken ct = default)
    {
        await DropSimulatedUnitsAsync(activeSource, ct);

        var zones = await _db.ClimateZones
            .Where(z => z.SensorZoneId == null || (z.Class == ZoneClass.Automated && z.ClimateUnitId == null))
            .ToListAsync(ct);
        if (zones.Count == 0) return;

        var probes = await _db.SensorZones.ToListAsync(ct);
        var units = await _db.ClimateUnits.ToListAsync(ct);
        var takenUnits = await _db.ClimateZones
            .Where(z => z.ClimateUnitId != null)
            .Select(z => z.ClimateUnitId!.Value)
            .ToListAsync(ct);
        var claimed = takenUnits.ToHashSet();

        foreach (var zone in zones)
        {
            zone.SensorZoneId ??= probes.FirstOrDefault(p => Same(p.Name, zone.Name))?.Id;

            if (zone.Class != ZoneClass.Automated || zone.ClimateUnitId is not null) continue;
            // One unit to one room. Two rooms sharing a mini-split would have them fighting over its
            // set point with no way for either to win.
            var unit = units.FirstOrDefault(u => Same(u.Name, zone.Name) && !claimed.Contains(u.Id));
            if (unit is null) continue;
            zone.ClimateUnitId = unit.Id;
            claimed.Add(unit.Id);
            _logger.LogInformation("Climate: bound {Zone} to unit {Unit}.", zone.Name, unit.ProviderRef);
        }

        if (_db.ChangeTracker.HasChanges()) await _db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// Remove the seeded stand-ins once a real provider is live, never the other way round.
    /// </summary>
    /// <remarks>
    /// Only the simulated source, and only while something else is active — so a temporary loss of
    /// Home Assistant credentials can never delete a real unit and take three rooms' bindings with it.
    /// </remarks>
    private async Task DropSimulatedUnitsAsync(string activeSource, CancellationToken ct)
    {
        if (activeSource == SimulatedSource) return;
        var stale = await _db.ClimateUnits.Where(u => u.Source == SimulatedSource).ToListAsync(ct);
        if (stale.Count == 0) return;

        var staleIds = stale.Select(u => u.Id).ToHashSet();
        var bound = await _db.ClimateZones.Where(z => z.ClimateUnitId != null).ToListAsync(ct);
        foreach (var zone in bound.Where(z => staleIds.Contains(z.ClimateUnitId!.Value)))
            zone.ClimateUnitId = null;

        _db.ClimateUnits.RemoveRange(stale);
        await _db.SaveChangesAsync(ct);
        _logger.LogInformation(
            "Climate: removed {Count} seeded simulated unit(s); '{Source}' is now live.", stale.Count, activeSource);
    }

    /// <summary>Names as the household writes them, compared as the household means them.</summary>
    private static bool Same(string a, string b) =>
        string.Equals(a.Trim(), b.Trim(), StringComparison.OrdinalIgnoreCase);
}
