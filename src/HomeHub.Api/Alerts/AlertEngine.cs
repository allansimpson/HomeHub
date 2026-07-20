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
    /// Evaluate all sensor thresholds as of <paramref name="nowUtc"/> and reconcile active
    /// alerts. Returns the number of currently-open sensor alerts. The clock is a parameter so
    /// tests are deterministic (no waiting on wall-clock durations).
    /// </summary>
    public async Task<int> EvaluateAsync(HomeHubDbContext db, DateTime nowUtc, CancellationToken ct = default)
    {
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
                db.ActiveAlerts.Add(new ActiveAlert
                {
                    Type = SensorAlertType,
                    DedupeKey = key,
                    Severity = threshold.Severity,
                    Message = BuildMessage(threshold, latestValue),
                    Source = $"sensor:{threshold.ZoneId}",
                    StartedAtUtc = nowUtc,
                });
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

        return await db.ActiveAlerts.CountAsync(a => a.Type == SensorAlertType && a.ClearedAtUtc == null, ct);
    }

    /// <summary>
    /// Reconcile externally-sourced alerts (e.g. NWS weather) of one <paramref name="type"/>
    /// against the set currently active at the source. New ones are raised, gone ones cleared,
    /// existing ones refreshed — reusing the same <see cref="ActiveAlert"/> store and banner as
    /// sensor alerts (no duplicate mechanism). These carry an explicit expiry rather than a
    /// sustained-duration rule.
    /// </summary>
    public async Task ReconcileAsync(
        HomeHubDbContext db, string type, IReadOnlyList<ExternalAlert> incoming, DateTime nowUtc, CancellationToken ct = default)
    {
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
            }
            else
            {
                db.ActiveAlerts.Add(new ActiveAlert
                {
                    Type = type,
                    DedupeKey = input.DedupeKey,
                    Severity = input.Severity,
                    Message = input.Message,
                    Source = input.Source,
                    StartedAtUtc = nowUtc,
                    ExpiresAtUtc = input.ExpiresAtUtc,
                });
            }
        }

        await db.SaveChangesAsync(ct);
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
