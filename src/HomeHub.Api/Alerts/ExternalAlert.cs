namespace HomeHub.Api.Alerts;

/// <summary>
/// Input to <see cref="AlertEngine.ReconcileAsync"/> for alerts that originate fully-formed
/// outside the threshold engine (e.g. NWS weather). Identity is <see cref="DedupeKey"/>.
/// </summary>
public record ExternalAlert(
    string DedupeKey,
    AlertSeverity Severity,
    string Message,
    string Source,
    DateTime? ExpiresAtUtc);
