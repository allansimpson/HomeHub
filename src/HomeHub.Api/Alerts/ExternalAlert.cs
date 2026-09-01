namespace HomeHub.Api.Alerts;

/// <summary>
/// Input to <see cref="AlertEngine.ReconcileAsync"/> for alerts that originate fully-formed
/// outside the threshold engine (e.g. NWS weather). Identity is <see cref="DedupeKey"/>.
/// </summary>
/// <param name="Event">
/// What the product is called — CAP <c>event</c>, e.g. "Special Weather Statement". The banner and
/// the statement sheet both title themselves from this. Null for alerts that have no name of their
/// own (sensor thresholds), where the banner falls back to reading a headline out of the message.
/// </param>
/// <param name="Detail">
/// The long-form body of the alert, when it has one — everything the banner has no room for. Null
/// for sources that are only ever one line.
/// </param>
public record ExternalAlert(
    string DedupeKey,
    AlertSeverity Severity,
    string Message,
    string Source,
    DateTime? ExpiresAtUtc,
    string? Event = null,
    AlertDetail? Detail = null);

/// <summary>
/// The full text of an alert, for the statement sheet — see
/// <c>design_handoff_weather_alert/ALERT_SHEET.md</c> §2.
/// </summary>
/// <remarks>
/// Split out from <see cref="ExternalAlert"/> rather than flattened into it because it travels as a
/// unit and is absent as a unit: an alert either has a product behind it or it does not. Every
/// member is optional — the sheet drops any section whose fields are missing rather than printing
/// an em dash, so a sensor-threshold alert reusing this surface simply has fewer rows.
/// </remarks>
public record AlertDetail(
    string? Description = null,
    string? Instruction = null,
    string? AreaDesc = null,
    string? SenderName = null,
    DateTime? SentUtc = null,
    DateTime? OnsetUtc = null,
    DateTime? EndsUtc = null,
    string? Urgency = null,
    string? Certainty = null,
    string? SeverityText = null,
    string? ProductId = null);
