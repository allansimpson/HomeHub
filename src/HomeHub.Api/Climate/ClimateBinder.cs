namespace HomeHub.Api.Climate;

using HomeHub.Api.Data;
using HomeHub.Api.Sensors;
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
/// <para>
/// Name matching alone is not enough, though, because it can only ever reach the rooms the seed
/// already named. A real SensorPush account is a set of sensors the vendor named — "Basement",
/// "Nursery", a bare sensor id — and a probe that matches none of the six seeded rooms used to have
/// nowhere to appear: the poller wrote its readings to SQL every minute and the Climate panel, which
/// lists rooms rather than probes, never drew a row for it. So a probe no room has claimed is
/// adopted as a <see cref="ZoneClass.Watched"/> room of its own. Watched and not
/// <see cref="ZoneClass.ColdStorage"/> because a band has to be a decision — inventing 34–40° for
/// something called "Garage" would be a guess the panel then alarms on.
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

        // Every room, not only the unbound ones: adoption below has to know which probes are already
        // spoken for, and that answer lives on the rooms that need no work themselves.
        var zones = await _db.ClimateZones.ToListAsync(ct);
        var probes = await _db.SensorZones.OrderBy(p => p.DisplayOrder).ThenBy(p => p.Id).ToListAsync(ct);
        var units = await _db.ClimateUnits.ToListAsync(ct);

        var claimedProbes = zones.Where(z => z.SensorZoneId is not null).Select(z => z.SensorZoneId!.Value).ToHashSet();
        var claimedUnits = zones.Where(z => z.ClimateUnitId is not null).Select(z => z.ClimateUnitId!.Value).ToHashSet();

        foreach (var zone in zones)
        {
            if (zone.SensorZoneId is null)
            {
                // One probe to one room, for the same reason as the units below: two rooms reading
                // the same sensor are one room wearing two names, and the second would silently
                // steer a mini-split by a temperature taken somewhere else.
                var probe = probes.FirstOrDefault(p => Same(p.Name, zone.Name) && !claimedProbes.Contains(p.Id));
                if (probe is not null)
                {
                    zone.SensorZoneId = probe.Id;
                    claimedProbes.Add(probe.Id);
                    _logger.LogInformation("Climate: bound {Zone} to probe {Probe}.", zone.Name, probe.ProviderRef);
                }
            }

            if (zone.Class != ZoneClass.Automated || zone.ClimateUnitId is not null) continue;
            // One unit to one room. Two rooms sharing a mini-split would have them fighting over its
            // set point with no way for either to win.
            var unit = units.FirstOrDefault(u => Same(u.Name, zone.Name) && !claimedUnits.Contains(u.Id));
            if (unit is null) continue;
            zone.ClimateUnitId = unit.Id;
            claimedUnits.Add(unit.Id);
            _logger.LogInformation("Climate: bound {Zone} to unit {Unit}.", zone.Name, unit.ProviderRef);
        }

        AdoptUnclaimedProbes(zones, probes, claimedProbes);

        if (_db.ChangeTracker.HasChanges()) await _db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// Give every probe no room has claimed a watched room of its own, named as the sensor is named.
    /// </summary>
    /// <remarks>
    /// This is what puts real SensorPush hardware on the Climate panel. The poller discovers sensors
    /// and stores their readings, but the panel lists rooms, so until a room points at a sensor the
    /// data exists in SQL and nowhere a person can see it.
    /// <para>
    /// Idempotent by construction: the new room claims the probe, so the next tick finds nothing to
    /// adopt. Sorted below the rooms that are already there, in the order the sensor list gives them,
    /// so an adoption never reshuffles a panel someone has learned the shape of.
    /// </para>
    /// </remarks>
    private void AdoptUnclaimedProbes(List<ClimateZone> zones, List<SensorZone> probes, HashSet<int> claimed)
    {
        var order = zones.Count == 0 ? 0 : zones.Max(z => z.SortOrder) + 1;
        foreach (var probe in probes)
        {
            if (claimed.Contains(probe.Id)) continue;
            _db.ClimateZones.Add(new ClimateZone
            {
                Name = probe.Name,
                Class = ZoneClass.Watched,
                SensorZoneId = probe.Id,
                SortOrder = order++,
            });
            claimed.Add(probe.Id);
            _logger.LogInformation(
                "Climate: added watched room '{Name}' for unclaimed probe {Probe}.", probe.Name, probe.ProviderRef);
        }
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
