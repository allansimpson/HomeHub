namespace HomeHub.Api.Sensors;

/// <summary>
/// A named place we track (a room or an appliance). Vendor-neutral: <see cref="Source"/> +
/// <see cref="ProviderRef"/> tie it to whichever provider supplies its readings, so a zone can
/// migrate providers (e.g. SensorPush → Home Assistant in Stage 6) without losing its history.
/// </summary>
public class SensorZone
{
    public int Id { get; set; }

    /// <summary>Display name, e.g. "Living Room" or "Freezer".</summary>
    public required string Name { get; set; }

    /// <summary>Providing source key, e.g. "simulated" or "sensorpush".</summary>
    public required string Source { get; set; }

    /// <summary>Opaque id used by the source to identify this zone's sensor.</summary>
    public required string ProviderRef { get; set; }

    /// <summary>Food-safety vs ambient — drives default thresholds and alert severity.</summary>
    public SensorCategory Category { get; set; }

    public int DisplayOrder { get; set; }

    public List<SensorReading> Readings { get; } = [];
}
