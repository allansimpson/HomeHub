namespace HomeHub.Api.Care;

using System.Globalization;
using HomeHub.Api.Baby;
using HomeHub.Api.Data;
using HomeHub.Api.HomeAssistant;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

/// <summary>What one pull found.</summary>
/// <param name="Read">Calendar events the window returned.</param>
/// <param name="Imported">Rows written.</param>
/// <param name="AlreadyHad">Events that were already in the log — the ordinary result of a re-sync.</param>
/// <param name="Skipped">Events this cannot classify. Counted, never guessed at.</param>
public sealed record CareImportResult(int Read, int Imported, int AlreadyHad, int Skipped)
{
    public static readonly CareImportResult Nothing = new(0, 0, 0, 0);

    public CareImportResult Plus(CareImportResult other) => new(
        Read + other.Read, Imported + other.Imported, AlreadyHad + other.AlreadyHad, Skipped + other.Skipped);
}

/// <summary>
/// Pulls the household's own history out of Huckleberry and into HomeHub's log.
/// </summary>
/// <remarks>
/// <para>
/// <b>A bridge with an end date.</b> HomeHub is the record now — the panel writes here and nowhere
/// else — but the household has months of feeds and nappies in an app they have been using all
/// along, and starting from an empty log would throw that away. This runs on demand, as often as
/// wanted, until they have fully switched over and it is simply never called again.
/// </para>
/// <para>
/// <b>Idempotent by construction.</b> Each event gets a synthesised key — Huckleberry's own
/// <c>uid</c> is null on every one — and a filtered unique index enforces it, so pulling the same
/// window twice writes each event once even if two pulls overlap. That matters because the honest
/// way to use this is to re-run it whenever you want, not to track what was fetched last time.
/// </para>
/// <para>
/// <b>It only reads.</b> Nothing here writes to Huckleberry, which is what "native only" means.
/// </para>
/// </remarks>
public sealed class CareImportService
{
    /// <summary>
    /// How much is asked for at once.
    /// </summary>
    /// <remarks>
    /// The calendar API answers a window at a time and the household's own feed runs to roughly 14
    /// events a day, so a fortnight is a comfortable request. Longer windows are walked in these
    /// steps rather than asked for whole — a year in one call is how a request times out and takes
    /// the whole import with it.
    /// </remarks>
    private static readonly TimeSpan Window = TimeSpan.FromDays(14);

    private readonly HomeHubDbContext _db;
    /// <summary>
    /// Null on a panel with no Home Assistant configured.
    /// </summary>
    /// <remarks>
    /// The client is only registered when a URL and token exist, so requiring it in the constructor
    /// would make a panel without Home Assistant fail to start — over an import it is never going to
    /// run. There is simply nothing upstream to read from, which the result reports as zero rather
    /// than as an error.
    /// </remarks>
    private readonly HomeAssistantClient? _ha;
    private readonly HuckleberryOptions _options;
    private readonly ILogger<CareImportService> _logger;

    public CareImportService(
        HomeHubDbContext db,
        HomeAssistantClient? ha,
        IOptions<HuckleberryOptions> options,
        ILogger<CareImportService> logger)
    {
        ArgumentNullException.ThrowIfNull(options);
        _db = db;
        _ha = ha;
        _options = options.Value;
        _logger = logger;
    }

    /// <summary>
    /// Pull a range, in windows, and write what is new.
    /// </summary>
    /// <remarks>
    /// Each window is saved as it lands rather than accumulating to one commit at the end: a pull
    /// that fails in month four should leave months one to three imported, not roll the lot back.
    /// </remarks>
    public async Task<CareImportResult> ImportAsync(
        string childKey, DateTimeOffset fromUtc, DateTimeOffset toUtc, CancellationToken ct)
    {
        if (_ha is null)
        {
            _logger.LogInformation("Care import asked for, but this panel has no Home Assistant to read from.");
            return CareImportResult.Nothing;
        }

        var entity = string.Format(CultureInfo.InvariantCulture, _options.CalendarEntityFormat, childKey);
        var total = CareImportResult.Nothing;

        for (var start = fromUtc; start < toUtc; start += Window)
        {
            var end = start + Window;
            if (end > toUtc) end = toUtc;

            IReadOnlyList<HaCalendarEvent> events;
            try
            {
                events = await _ha.GetCalendarEventsAsync(entity, start, end, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception ex)
            {
                // One unreadable window is not a failed import. Reported and stepped over, so a gap
                // in the middle of a year does not cost the rest of it.
                _logger.LogWarning(ex, "Care import could not read {Entity} from {Start} to {End}.", entity, start, end);
                continue;
            }

            total = total.Plus(await AbsorbAsync(childKey, events, ct));
        }

        _logger.LogInformation(
            "Care import for {Child}: read {Read}, imported {Imported}, already had {Had}, skipped {Skipped}.",
            childKey, total.Read, total.Imported, total.AlreadyHad, total.Skipped);
        return total;
    }

    private async Task<CareImportResult> AbsorbAsync(
        string childKey, IReadOnlyList<HaCalendarEvent> events, CancellationToken ct)
    {
        var parsed = new List<CareEntry>();
        var skipped = 0;

        foreach (var e in events)
        {
            if (e.Start?.Value is not { } start) { skipped++; continue; }
            var entry = HuckleberryCalendarParser.Parse(
                e.Summary, e.Description, start.UtcDateTime, e.End?.Value?.UtcDateTime, childKey);
            if (entry is null) { skipped++; continue; }
            parsed.Add(entry);
        }

        if (parsed.Count == 0) return new CareImportResult(events.Count, 0, 0, skipped);

        // Asked once for the whole window rather than per row. The unique index is what actually
        // guarantees the outcome; this is only to avoid handing the database a batch that is almost
        // entirely conflicts on the second run.
        var keys = parsed.Select(p => p.ExternalKey!).ToList();
        var known = await _db.CareEntries
            .Where(e => e.ExternalKey != null && keys.Contains(e.ExternalKey))
            .Select(e => e.ExternalKey!)
            .ToListAsync(ct);
        var seen = known.ToHashSet(StringComparer.Ordinal);

        var fresh = parsed.Where(p => seen.Add(p.ExternalKey!)).ToList();
        if (fresh.Count > 0)
        {
            _db.CareEntries.AddRange(fresh);
            await _db.SaveChangesAsync(ct);
        }

        return new CareImportResult(events.Count, fresh.Count, parsed.Count - fresh.Count, skipped);
    }
}
