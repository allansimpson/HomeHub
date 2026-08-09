namespace HomeHub.Api.Sensors;

/// <summary>
/// The sensor seam (mandatory per architecture): all live sensor acquisition goes through this
/// interface, never a vendor SDK. Implementations acquire zones + latest readings; owned
/// history lives in SQL and is served from there, not re-fetched from the provider. Stage 6 may
/// add a Home Assistant-backed provider alongside SensorPush, coexisting per zone.
/// </summary>
public interface ISensorProvider
{
    /// <summary>Stable source key stored on each zone/reading, e.g. "simulated" or "sensorpush".</summary>
    string Source { get; }

    /// <summary>Enumerate the zones this provider can supply.</summary>
    Task<IReadOnlyList<ProviderZone>> GetZonesAsync(CancellationToken ct);

    /// <summary>Latest reading for each provider ref supplied. Missing sensors are simply omitted.</summary>
    Task<IReadOnlyList<ProviderReading>> GetLatestReadingsAsync(
        IReadOnlyList<string> providerRefs,
        CancellationToken ct);
}
