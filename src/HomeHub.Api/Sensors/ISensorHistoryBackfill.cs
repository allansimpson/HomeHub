namespace HomeHub.Api.Sensors;

/// <summary>
/// Optional capability: a provider that can supply past readings for a zone. The poller uses it
/// once to seed history for an empty zone so charts are meaningful immediately. Providers that
/// can't (or shouldn't) backfill simply don't implement it.
/// </summary>
public interface ISensorHistoryBackfill
{
    IReadOnlyList<ProviderReading> BackfillHistory(
        string providerRef, DateTime fromUtc, DateTime toUtc, TimeSpan step);
}
