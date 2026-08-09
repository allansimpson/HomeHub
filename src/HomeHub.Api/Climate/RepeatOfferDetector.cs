namespace HomeHub.Api.Climate;

using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// "You've cooled the Master Bedroom to about 69° three evenings running. Make it standing?"
/// </summary>
/// <remarks>
/// This is the section's answer to schedules. A schedule is a promise about a week the household has
/// not had yet, so none was built; instead a standing target can earn its way in from evidence, with
/// real numbers, once the household has demonstrated what it actually wants (DECISIONS §3).
/// <para>
/// The evidence is deliberately narrow — three or more loans in a fortnight, all within a degree of
/// each other, all in the same three-hour stretch of the day, and <b>none of them promoted</b>. That
/// last clause is the whole heuristic: someone who already pressed <c>KEEP</c> has answered this
/// question, and asking again would be the panel not listening.
/// </para>
/// </remarks>
public sealed class RepeatOfferDetector
{
    private static readonly TimeSpan Lookback = TimeSpan.FromDays(14);
    private const int MinimumOccurrences = 3;

    /// <summary>All within ±1° of each other — so a two-degree spread, end to end.</summary>
    private const double SpreadF = 2;

    /// <summary>Once a week per room. A heuristic that keeps being right must not become nagging.</summary>
    private static readonly TimeSpan ShowAtMostEvery = TimeSpan.FromDays(7);

    /// <summary><c>NO, KEEP ASKING</c> buys this much quiet for that room and that time of day.</summary>
    public static readonly TimeSpan SuppressFor = TimeSpan.FromDays(30);

    private readonly HomeHubDbContext _db;
    private readonly TimeProvider _time;

    public RepeatOfferDetector(HomeHubDbContext db, TimeProvider time)
    {
        _db = db;
        _time = time;
    }

    /// <summary>The one offer worth making right now, or null. Never more than one on screen.</summary>
    public async Task<RepeatOfferDto?> FindAsync(
        IReadOnlyList<ClimateZone> zones, DateTime nowUtc, CancellationToken ct = default)
    {
        var since = nowUtc - Lookback;
        var candidates = zones.Where(z => z.Class == ZoneClass.Automated).Select(z => z.Id).ToList();
        if (candidates.Count == 0) return null;

        // "The same three-hour stretch of the day" is a wall-clock claim, so the window is bucketed
        // against the injected clock's zone rather than whatever the host machine is set to.
        var offset = _time.GetLocalNow().Offset;

        var overrides = await _db.ZoneOverrides
            .Where(o => candidates.Contains(o.ZoneId) && o.StartedAtUtc >= since)
            .ToListAsync(ct);

        foreach (var zone in zones.Where(z => z.Class == ZoneClass.Automated))
        {
            // Never while a loan is live: the household is in the middle of the very act the offer is
            // about, and the row already carries KEEP.
            if (overrides.Any(o => o.ZoneId == zone.Id && o.IsLiveAt(nowUtc))) continue;
            if (zone.OfferShownAtUtc is { } shown && nowUtc - shown < ShowAtMostEvery) continue;

            var mine = overrides.Where(o => o.ZoneId == zone.Id && o.CancelledAtUtc == null).ToList();
            if (mine.Any(o => o.PromotedAtUtc is not null)) continue;

            foreach (var group in mine.GroupBy(o => WindowHour(o.StartedAtUtc, offset)))
            {
                if (group.Count() < MinimumOccurrences) continue;
                var targets = group.Select(o => o.TargetF).ToList();
                if (targets.Max() - targets.Min() > SpreadF) continue;
                if (zone.OfferSuppressedUntilUtc is { } until
                    && until > nowUtc
                    && zone.OfferSuppressedWindowHour == group.Key) continue;

                return new RepeatOfferDto(zone.Id, zone.Name, Math.Round(targets.Average()), group.Key);
            }
        }

        return null;
    }

    /// <summary>The first local hour of the three-hour clock window a loan started in.</summary>
    public static int WindowHour(DateTime startedAtUtc, TimeSpan localOffset) =>
        (startedAtUtc + localOffset).Hour / 3 * 3;
}
