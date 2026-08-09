namespace HomeHub.Api.Weather;

/// <summary>
/// Single-row cache (id 1) of the last successful weather fetch, serialized as JSON. Lets the
/// panel keep showing last-known conditions when NWS is briefly unreachable (full offline
/// handling is Stage 9, but the cache is the foundation).
/// </summary>
public class WeatherCache
{
    public int Id { get; set; } = 1;

    /// <summary>Serialized <see cref="WeatherSnapshotDto"/>.</summary>
    public required string PayloadJson { get; set; }

    public DateTime FetchedAtUtc { get; set; }
}
