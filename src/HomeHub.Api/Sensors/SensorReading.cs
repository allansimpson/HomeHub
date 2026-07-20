namespace HomeHub.Api.Sensors;

/// <summary>
/// One stored reading. The poller writes every sample here so we own unlimited history,
/// independent of any provider's retention. Indexed by (ZoneId, TimestampUtc) for range queries.
/// </summary>
public class SensorReading
{
    public long Id { get; set; }

    public int ZoneId { get; set; }
    public SensorZone? Zone { get; set; }

    public DateTime TimestampUtc { get; set; }

    /// <summary>Temperature in Fahrenheit.</summary>
    public double TempF { get; set; }

    /// <summary>Relative humidity, percent.</summary>
    public double Humidity { get; set; }
}
