namespace HomeHub.Api.Alerts;

using HomeHub.Api.Data;
using HomeHub.Api.Sensors;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// The general alert engine (built once here, reused by Stage 3+). Evaluates every enabled
/// <see cref="AlertThreshold"/> against stored readings using the sustained-breach rule — a
/// breach must hold continuously for the threshold's duration before an alert is raised — and
/// raises or clears <see cref="ActiveAlert"/> rows accordingly. Deliberately type-agnostic: an
/// alert is (type, severity, message, source, timing), so other sources plug in unchanged.
/// </summary>
public sealed class AlertEngine
{
    private const string SensorAlertType = "sensor";

    /// <summary>
    /// Evaluate all sensor thresholds as of <paramref name="nowUtc"/> and reconcile active alerts.
    /// The clock is a parameter so tests are deterministic (no waiting on wall-clock durations).
    /// </summary>
    /// <returns>
    /// How many sensor alerts are open, and — separately — the ones this pass <b>raised</b>.
    /// </returns>
    /// <remarks>
    /// The two are not interchangeable, and the distinction is the same one
    /// <see cref="ReconcileAsync"/> draws for external alerts: "this condition is true" is a state
    /// worth rendering on every poll, while "this just happened" is an event worth telling someone
    /// about exactly once. Announcing from the open set would re-announce a freezer that has been
    /// warm for an hour, every thirty seconds, all hour.
    /// </remarks>
    public async Task<SensorAlertPass> EvaluateAsync(HomeHubDbContext db, DateTime nowUtc, CancellationToken ct = default)
    {
        var raised = new List<ActiveAlert>();
        var thresholds = await db.AlertThresholds
            .Where(t => t.Enabled)
            .Include(t => t.Zone)
            .ToListAsync(ct);

        var openAlerts = await db.ActiveAlerts
            .Where(a => a.Type == SensorAlertType && a.ClearedAtUtc == null)
            .ToListAsync(ct);
        var openByKey = openAlerts.ToDictionary(a => a.DedupeKey);

        foreach (var threshold in thresholds)
        {
            var key = $"threshold:{threshold.Id}";
            var (breachingNow, sustained, latestValue) = await EvaluateThresholdAsync(db, threshold, nowUtc, ct);
            openByKey.TryGetValue(key, out var open);

            if (sustained && open is null)
            {
                var alert = new ActiveAlert
                {
                    Type = SensorAlertType,
                    DedupeKey = key,
                    Severity = threshold.Severity,
                    Message = BuildMessage(threshold, latestValue),
                    Source = $"sensor:{threshold.ZoneId}",
                    StartedAtUtc = nowUtc,
                };
                db.ActiveAlerts.Add(alert);
                raised.Add(alert);
            }
            else if (!breachingNow && open is not null)
            {
                open.ClearedAtUtc = nowUtc;
            }
            else if (open is not null)
            {
                // Keep the message current while the breach persists.
                open.Message = BuildMessage(threshold, latestValue);
                open.Severity = threshold.Severity;
            }
        }

        await db.SaveChangesAsync(ct);

        var openCount = await db.ActiveAlerts.CountAsync(a => a.Type == SensorAlertType && a.ClearedAtUtc == null, ct);
        return new SensorAlertPass(openCount, raised);
    }

    /// <summary>
    /// Reconcile externally-sourced alerts (e.g. NWS weather) of one <paramref name="type"/>
    /// against the set currently active at the source. New ones are raised, gone ones cleared,
    /// existing ones refreshed — reusing the same <see cref="ActiveAlert"/> store and banner as
    /// sensor alerts (no duplicate mechanism). These carry an explicit expiry rather than a
    /// sustained-duration rule.
    /// </summary>
    /// <summary>
    /// Returns the alerts that were <b>newly raised</b> by this pass — the transitions, not the
    /// still-open ones.
    /// </summary>
    /// <remarks>
    /// Notifications are emitted from these rather than from the open set, because "this condition is
    /// true" and "this just happened" are different claims. Reconciling on every tick would otherwise
    /// re-announce a fault that has been sitting there for an hour.
    /// </remarks>
    public async Task<IReadOnlyList<ExternalAlert>> ReconcileAsync(
        HomeHubDbContext db, string type, IReadOnlyList<ExternalAlert> incoming, DateTime nowUtc, CancellationToken ct = default)
    {
        var raised = new List<ExternalAlert>();
        var open = await db.ActiveAlerts
            .Where(a => a.Type == type && a.ClearedAtUtc == null)
            .ToListAsync(ct);
        var openByKey = open.ToDictionary(a => a.DedupeKey);
        var incomingByKey = incoming.ToDictionary(a => a.DedupeKey);

        // Clear alerts no longer present at the source.
        foreach (var existing in open)
        {
            if (!incomingByKey.ContainsKey(existing.DedupeKey))
                existing.ClearedAtUtc = nowUtc;
        }

        // Raise new, refresh existing.
        foreach (var input in incoming)
        {
            if (openByKey.TryGetValue(input.DedupeKey, out var existing))
            {
                existing.Severity = input.Severity;
                existing.Message = input.Message;
                existing.Source = input.Source;
                existing.ExpiresAtUtc = input.ExpiresAtUtc;
                ApplyDetail(existing, input);
            }
            else
            {
                var alert = new ActiveAlert
                {
                    Type = type,
                    DedupeKey = input.DedupeKey,
                    Severity = input.Severity,
                    Message = input.Message,
                    Source = input.Source,
                    StartedAtUtc = nowUtc,
                    ExpiresAtUtc = input.ExpiresAtUtc,
                };
                ApplyDetail(alert, input);
                db.ActiveAlerts.Add(alert);
                raised.Add(input);
            }
        }

        await db.SaveChangesAsync(ct);
        return raised;
    }

    /// <summary>
    /// Copy the statement-sheet product onto the row, on raise and on every refresh.
    /// </summary>
    /// <remarks>
    /// Refresh overwrites unconditionally, including with nulls. That is deliberate: NWS amends
    /// products in place under the same id, and an amendment that drops the call to action has to
    /// drop it here too. Merging instead would leave the panel showing precautions for a warning
    /// that no longer carries them, which is worse than showing none.
    /// </remarks>
    private static void ApplyDetail(ActiveAlert alert, ExternalAlert input)
    {
        alert.Event = input.Event;
        var d = input.Detail;
        alert.Description = d?.Description;
        alert.Instruction = d?.Instruction;
        alert.AreaDesc = d?.AreaDesc;
        alert.SenderName = d?.SenderName;
        alert.SentUtc = d?.SentUtc;
        alert.OnsetUtc = d?.OnsetUtc;
        alert.EndsUtc = d?.EndsUtc;
        alert.Urgency = d?.Urgency;
        alert.Certainty = d?.Certainty;
        alert.SeverityText = d?.SeverityText;
        alert.ProductId = d?.ProductId;
    }

    private static async Task<(bool BreachingNow, bool Sustained, double LatestValue)> EvaluateThresholdAsync(
        HomeHubDbContext db, AlertThreshold threshold, DateTime nowUtc, CancellationToken ct)
    {
        var duration = TimeSpan.FromMinutes(Math.Max(0, threshold.DurationMinutes));
        // Load enough recent history to confirm a continuous run at least `duration` long.
        var lookback = TimeSpan.FromMinutes(Math.Max(30, threshold.DurationMinutes * 2));
        var since = nowUtc - lookback;

        var readings = await db.SensorReadings
            .Where(r => r.ZoneId == threshold.ZoneId && r.TimestampUtc >= since)
            .OrderBy(r => r.TimestampUtc)
            .ToListAsync(ct);

        if (readings.Count == 0) return (false, false, double.NaN);

        var latest = readings[^1];
        var latestValue = ValueOf(threshold.Metric, latest);
        var breachingNow = Breaches(threshold, latest);

        // Walk forward tracking when the current continuous breach run started.
        DateTime? breachStart = null;
        foreach (var r in readings)
        {
            if (Breaches(threshold, r))
                breachStart ??= r.TimestampUtc;
            else
                breachStart = null;
        }

        var sustained = breachingNow && breachStart is { } start && nowUtc - start >= duration;
        return (breachingNow, sustained, latestValue);
    }

    private static double ValueOf(AlertMetric metric, SensorReading r) =>
        metric == AlertMetric.Temperature ? r.TempF : r.Humidity;

    private static bool Breaches(AlertThreshold t, SensorReading r)
    {
        var value = ValueOf(t.Metric, r);
        return t.Direction == AlertDirection.Above ? value > t.Value : value < t.Value;
    }

    private static string BuildMessage(AlertThreshold t, double latestValue)
    {
        var zone = t.Zone?.Name ?? $"Zone {t.ZoneId}";
        var unit = t.Metric == AlertMetric.Temperature ? "°F" : "%";
        var word = t.Direction == AlertDirection.Above ? "above" : "below";
        var reading = double.IsNaN(latestValue) ? "" : $"{Math.Round(latestValue)}{unit} — ";
        return $"{zone}: {reading}{word} {Math.Round(t.Value)}{unit} for {t.DurationMinutes} min";
    }
}
