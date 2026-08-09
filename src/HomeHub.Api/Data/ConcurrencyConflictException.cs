namespace HomeHub.Api.Data;

/// <summary>
/// Thrown by a provider when a conditional write's expected version doesn't match the stored
/// entity — i.e. the item changed since the client last saw it. Controllers translate this to
/// HTTP 409 with the current server state so the offline write-queue can surface the conflict
/// rather than silently overwriting (Stage 9b, conservative policy).
/// </summary>
public sealed class ConcurrencyConflictException : Exception
{
    /// <summary>The current server-side entity, returned to the client for conflict review.</summary>
    public object Current { get; }

    public ConcurrencyConflictException(object current)
        : base("The item was modified since it was last read.")
    {
        Current = current;
    }
}
