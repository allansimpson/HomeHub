namespace HomeHub.Api.Sensors;

/// <summary>
/// Deterministic stand-in used until real SensorPush credentials are configured. Readings are a
/// pure function of (zone, timestamp) — a gentle diurnal curve plus reproducible pseudo-noise —
/// so backfilled history and live polls form one continuous, realistic series. Selected
/// automatically when no SensorPush config is present (see Program.cs).
/// </summary>
public sealed class SimulatedSensorProvider : ISensorProvider, ISensorHistoryBackfill
{
    public string Source => "simulated";

    private sealed record Spec(string Name, SensorCategory Category, double BaseTemp, double TempSwing, double BaseHumidity, double HumiditySwing);

    // Provider refs here match the DB seed's ProviderRef so seeded zones receive readings.
    private static readonly IReadOnlyDictionary<string, Spec> Zones = new Dictionary<string, Spec>
    {
        ["sim-freezer"] = new("Freezer", SensorCategory.FoodSafety, BaseTemp: 2, TempSwing: 3, BaseHumidity: 30, HumiditySwing: 4),
        ["sim-fridge"] = new("Fridge", SensorCategory.FoodSafety, BaseTemp: 38, TempSwing: 2, BaseHumidity: 42, HumiditySwing: 4),
        ["sim-living"] = new("Living Room", SensorCategory.Ambient, BaseTemp: 72, TempSwing: 4, BaseHumidity: 44, HumiditySwing: 6),
        ["sim-kitchen"] = new("Kitchen", SensorCategory.Ambient, BaseTemp: 74, TempSwing: 5, BaseHumidity: 51, HumiditySwing: 7),
        ["sim-bedroom"] = new("Bedroom", SensorCategory.Ambient, BaseTemp: 70, TempSwing: 3, BaseHumidity: 46, HumiditySwing: 5),
    };

    public Task<IReadOnlyList<ProviderZone>> GetZonesAsync(CancellationToken ct) =>
        Task.FromResult<IReadOnlyList<ProviderZone>>(
            Zones.Select(kv => new ProviderZone(kv.Key, kv.Value.Name)).ToList());

    public Task<IReadOnlyList<ProviderReading>> GetLatestReadingsAsync(
        IReadOnlyList<string> providerRefs, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var readings = providerRefs
            .Where(Zones.ContainsKey)
            .Select(r => ReadingAt(r, now))
            .ToList();
        return Task.FromResult<IReadOnlyList<ProviderReading>>(readings);
    }

    public IReadOnlyList<ProviderReading> BackfillHistory(
        string providerRef, DateTime fromUtc, DateTime toUtc, TimeSpan step)
    {
        if (!Zones.ContainsKey(providerRef)) return [];
        var readings = new List<ProviderReading>();
        for (var t = fromUtc; t <= toUtc; t += step)
            readings.Add(ReadingAt(providerRef, t));
        return readings;
    }

    private static ProviderReading ReadingAt(string providerRef, DateTime ts)
    {
        var spec = Zones[providerRef];

        // Diurnal factor peaks mid-afternoon (~3 PM), troughs pre-dawn (~3 AM).
        var hour = ts.TimeOfDay.TotalHours;
        var diurnal = Math.Sin((hour - 9) / 24.0 * 2 * Math.PI);

        // Reproducible sub-degree noise from the timestamp — not Random, so history is stable.
        var noise = Math.Sin(ts.Ticks % 100_000 / 100_000.0 * 2 * Math.PI);

        var temp = spec.BaseTemp + spec.TempSwing * diurnal + noise * 0.6;
        var humidity = spec.BaseHumidity - spec.HumiditySwing * diurnal + noise * 1.5;

        return new ProviderReading(
            providerRef,
            Math.Round(temp, 1),
            Math.Round(Math.Clamp(humidity, 0, 100), 1),
            ts);
    }
}
