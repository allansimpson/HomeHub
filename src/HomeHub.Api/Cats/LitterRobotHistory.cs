namespace HomeHub.Api.Cats;

using System.Globalization;
using HomeHub.Api.HomeAssistant;

/// <summary>
/// How the box has been doing over a window, assembled from Home Assistant's recorder.
/// </summary>
/// <remarks>
/// HomeHub persists recovery attempts and nothing else about the robot, so every trend here comes
/// from HA's own history rather than from a table of ours. That has one consequence the UI must
/// carry: the recorder purges (10 days by default), so a 30- or 90-day request usually comes back
/// short. <see cref="Complete"/> says whether the window was actually covered, and a screen that
/// ignores it draws a partial series as though it were the whole story.
/// </remarks>
public sealed record LitterRobotHistory(
    string Slug,
    int RequestedDays,
    DateTimeOffset? OldestSampleUtc,
    bool Complete,
    IReadOnlyList<LitterDaySample> Days,
    IReadOnlyList<LitterWeightSample> Weights,
    IReadOnlyDictionary<string, double> ClassShare,
    double? DrawerFillPercentPerDay,
    int? DaysUntilDrawerFull,
    int CyclesObserved,
    double? CyclesPerDay,
    IReadOnlyList<LitterEvent> Events);

/// <summary>One day's closing levels. Null where the recorder holds nothing for that day.</summary>
public sealed record LitterDaySample(DateOnly Day, double? DrawerPercent, double? LitterPercent);

/// <summary>One weighing. The robot weighs whoever is in it — there is no cat identity.</summary>
public sealed record LitterWeightSample(DateTimeOffset AtUtc, double Pounds);

/// <summary>
/// One thing the box did, for the tab root's LATELY / TODAY / SINCE THE FAULT band.
/// </summary>
/// <param name="Kind">
/// What happened, as a kind rather than a sentence. The panel writes the English — partly because the
/// sentences carry the household's name for the cat, which is panel-local and never leaves this app,
/// and partly because the tag and its colour are presentation, not data.
/// </param>
/// <param name="StatusCode">The code the robot moved into (or, for <c>ClearedItself</c>, moved out of).</param>
/// <param name="StatusText">pylitterbot's own text for that code, so the panel never paraphrases it.</param>
/// <param name="Value">The reading, where the event carries one — pet weight in pounds.</param>
public sealed record LitterEvent(
    DateTimeOffset AtUtc,
    string Kind,
    string? StatusCode,
    string? StatusText,
    double? Value);

/// <summary>
/// The event kinds the recorder can yield. Deliberately small: this is the vocabulary of things a
/// household would say out loud about the box, not a re-export of the 25 status codes.
/// </summary>
public static class LitterEventKinds
{
    public const string CatVisit = "CatVisit";
    public const string CycleComplete = "CycleComplete";
    /// <summary>A recoverable fault that went away without anyone touching the unit.</summary>
    public const string ClearedItself = "ClearedItself";
    public const string Fault = "Fault";
    public const string NeedsHuman = "NeedsHuman";
    public const string Weight = "Weight";
    public const string Offline = "Offline";
}

/// <summary>Folds raw recorder samples into the shapes the History screen reads.</summary>
public static class LitterHistoryBuilder
{
    /// <summary>Drawer level that counts as full — the point the robot refuses to cycle.</summary>
    private const double DrawerFullPercent = 90;

    public static LitterRobotHistory Build(
        string slug,
        int days,
        DateTimeOffset from,
        DateTimeOffset to,
        IReadOnlyList<HaState> statusSamples,
        IReadOnlyList<HaState> drawerSamples,
        IReadOnlyList<HaState> litterSamples,
        IReadOnlyList<HaState> weightSamples)
    {
        var oldest = new[] { statusSamples, drawerSamples, litterSamples, weightSamples }
            .SelectMany(s => s)
            .Select(s => s.LastChanged)
            .Where(t => t is not null)
            .DefaultIfEmpty(null)
            .Min();

        // The recorder answers with whatever it still holds. Treat the window as covered only if a
        // sample exists near its start — otherwise the caller is looking at a shorter period.
        var complete = oldest is not null && oldest.Value - from < TimeSpan.FromHours(24);

        var byDay = BuildDays(from, to, drawerSamples, litterSamples);
        var weights = weightSamples
            .Select(s => (s.LastChanged, Value: Number(s)))
            .Where(x => x.LastChanged is not null && x.Value is not null)
            .Select(x => new LitterWeightSample(x.LastChanged!.Value, x.Value!.Value))
            .ToList();

        var (rate, daysToFull) = DrawerTrend(byDay);
        var (cycles, cyclesPerDay) = Cycles(statusSamples, oldest, to);

        return new LitterRobotHistory(
            slug,
            days,
            oldest,
            complete,
            byDay,
            weights,
            ClassShare(statusSamples, to),
            rate,
            daysToFull,
            cycles,
            cyclesPerDay,
            Events(from, statusSamples, weightSamples));
    }

    /// <summary>How many events the panel is ever asked to hold. The tab root shows five.</summary>
    private const int MaxEvents = 40;

    /// <summary>
    /// What the box did, newest first, from the same recorder pull the trends come from.
    /// </summary>
    /// <remarks>
    /// Home Assistant reports where the robot <em>is</em>, never how it got there, so every event here
    /// is a <em>transition</em> — the moment the status entity changed value. That is the only honest
    /// reading: a status that held for six hours is one event at its start, not a row per poll.
    ///
    /// <para>Nothing is invented. A cycle counts as complete only when the robot said so (<c>ccc</c>)
    /// or left a running cycle for a stable code; a fault counts as self-cleared only when the panel
    /// can see it both arrive and leave inside the window. A fault that was already active when the
    /// window opens produces no "cleared" row, because we cannot see what cleared it.</para>
    /// </remarks>
    private static List<LitterEvent> Events(
        DateTimeOffset from, IReadOnlyList<HaState> statusSamples, IReadOnlyList<HaState> weightSamples)
    {
        var events = new List<LitterEvent>();

        var ordered = statusSamples
            .Where(s => s.LastChanged is not null)
            .OrderBy(s => s.LastChanged)
            .ToList();

        LitterRobotFault? previous = null;
        // Whether we watched `previous` *arrive*, as opposed to inheriting it from before the window.
        // The recorder's first sample is the state as it stood when the window opened, and its
        // LastChanged is the real (earlier) transition time — so this is the test that tells the two
        // apart, and it is what the "cannot see what cleared it" rule above actually depends on.
        var previousObserved = false;

        foreach (var sample in ordered)
        {
            var code = sample.IsUnavailable ? null : sample.State;
            var fault = LitterRobotFaults.Classify(code);
            // Only transitions. The recorder can repeat a state (an attribute changed, a restart
            // re-published it) and a row per repeat would read as the cat visiting four times.
            if (previous is not null && string.Equals(previous.Code, fault.Code, StringComparison.OrdinalIgnoreCase))
                continue;

            var at = sample.LastChanged!.Value;
            var was = previous;
            var wasObserved = previousObserved;
            previous = fault;
            previousObserved = at >= from;

            // A recoverable fault that ended without a person is the one event the household most
            // wants to see, and it is only visible on the way *out* of the fault.
            //
            // `wasObserved` is what keeps that honest. Without it, a fault carried into the window
            // from before produced a "cleared itself" row on its first transition — so a box that
            // faulted two days ago and was fixed by hand this morning reported itself as having
            // recovered on its own, in a list whose purpose is telling those two apart.
            if (wasObserved &&
                was is { Class: LitterRobotFaultClass.Recoverable } &&
                fault.Class is LitterRobotFaultClass.Stable or LitterRobotFaultClass.Transient)
            {
                events.Add(new LitterEvent(at, LitterEventKinds.ClearedItself, was.Code, was.Text, null));
                continue;
            }

            switch (fault.Class)
            {
                case LitterRobotFaultClass.CatPresent:
                    events.Add(new LitterEvent(at, LitterEventKinds.CatVisit, fault.Code, fault.Text, null));
                    break;

                case LitterRobotFaultClass.Transient when fault.Code == "ccc":
                    events.Add(new LitterEvent(at, LitterEventKinds.CycleComplete, fault.Code, fault.Text, null));
                    break;

                // The robot does not always publish `ccc`; leaving a running cycle for a usable state
                // is the same fact arriving a different way.
                case LitterRobotFaultClass.Stable when was is { Code: "ccp" or "ec" }:
                    events.Add(new LitterEvent(at, LitterEventKinds.CycleComplete, was.Code, was.Text, null));
                    break;

                case LitterRobotFaultClass.Recoverable:
                    events.Add(new LitterEvent(at, LitterEventKinds.Fault, fault.Code, fault.Text, null));
                    break;

                case LitterRobotFaultClass.NeedsHuman:
                    events.Add(new LitterEvent(at, LitterEventKinds.NeedsHuman, fault.Code, fault.Text, null));
                    break;

                case LitterRobotFaultClass.Offline:
                    events.Add(new LitterEvent(at, LitterEventKinds.Offline, fault.Code, fault.Text, null));
                    break;
            }
        }

        // One weighing per visit — the scale reads whoever is in the box, and the recorder only
        // publishes a sample when the figure changed.
        foreach (var sample in weightSamples)
        {
            if (sample.LastChanged is not { } at) continue;
            if (Number(sample) is not { } pounds || pounds <= 0) continue;
            events.Add(new LitterEvent(at, LitterEventKinds.Weight, null, null, pounds));
        }

        return events.OrderByDescending(e => e.AtUtc).Take(MaxEvents).ToList();
    }

    /// <summary>
    /// Clean cycles, counted from status transitions rather than from a counter.
    /// </summary>
    /// <remarks>
    /// Home Assistant publishes no cycle count for this robot — not as a sensor, and not as an
    /// attribute on the vacuum entity (verified 2026-07-30). But every cycle passes through
    /// <c>ccp</c>, so the recorder's status history counts them: each *entry* into <c>ccp</c> is one
    /// cycle, and consecutive <c>ccp</c> samples are the same cycle still running.
    ///
    /// <para>This is an <em>observed</em> count, not the robot's odometer (which reads ~13,756 in its
    /// own diagnostics). It only sees what the recorder kept, and a cycle that began and ended
    /// between two cloud pushes is invisible. Present it as cycles seen in the window, never as a
    /// lifetime total.</para>
    /// </remarks>
    private static (int Observed, double? PerDay) Cycles(
        IReadOnlyList<HaState> statusSamples, DateTimeOffset? oldest, DateTimeOffset to)
    {
        var ordered = statusSamples
            .Where(s => s.LastChanged is not null)
            .OrderBy(s => s.LastChanged)
            .ToList();
        if (ordered.Count == 0 || oldest is null) return (0, null);

        var count = 0;
        string? previous = null;
        foreach (var sample in ordered)
        {
            if (sample.State == "ccp" && previous != "ccp") count++;
            previous = sample.State;
        }

        // Rate over the window the recorder actually covered, not the window that was asked for —
        // dividing by 90 days of which only one was recorded would report a robot that never cycles.
        var span = (to - oldest.Value).TotalDays;
        return (count, span >= 0.5 ? count / span : null);
    }

    /// <summary>
    /// One row per calendar day, carrying that day's last reading. Days the recorder has nothing for
    /// stay in the list with nulls rather than being dropped, so a gap reads as a gap.
    /// </summary>
    private static List<LitterDaySample> BuildDays(
        DateTimeOffset from, DateTimeOffset to,
        IReadOnlyList<HaState> drawer, IReadOnlyList<HaState> litter)
    {
        var drawerByDay = LastPerDay(drawer);
        var litterByDay = LastPerDay(litter);

        var result = new List<LitterDaySample>();
        for (var day = DateOnly.FromDateTime(from.LocalDateTime); day <= DateOnly.FromDateTime(to.LocalDateTime); day = day.AddDays(1))
        {
            // Explicitly nullable: `TryGetValue` on a Dictionary<,double> hands back 0 on a miss, and
            // a day with no reading is not a day the drawer was empty. That distinction is the whole
            // rule — an unrecorded level shown as 0% invents days that never happened and turns the
            // first real reading into a phantom rise in the fill rate.
            double? drawerToday = drawerByDay.TryGetValue(day, out var d) ? d : null;
            double? litterToday = litterByDay.TryGetValue(day, out var l) ? l : null;
            result.Add(new LitterDaySample(day, drawerToday, litterToday));
        }
        return result;
    }

    private static Dictionary<DateOnly, double> LastPerDay(IReadOnlyList<HaState> samples)
    {
        var byDay = new Dictionary<DateOnly, double>();
        foreach (var sample in samples.OrderBy(s => s.LastChanged))
        {
            if (sample.LastChanged is not { } at) continue;
            if (Number(sample) is not { } value) continue;
            byDay[DateOnly.FromDateTime(at.LocalDateTime)] = value;
        }
        return byDay;
    }

    /// <summary>
    /// Share of the window spent in each fault class, weighted by how long each state lasted rather
    /// than by how many samples it produced — a status that flickers ten times in a minute is not ten
    /// times as important as one that held for a day.
    /// </summary>
    private static Dictionary<string, double> ClassShare(IReadOnlyList<HaState> statusSamples, DateTimeOffset to)
    {
        var ordered = statusSamples
            .Where(s => s.LastChanged is not null)
            .OrderBy(s => s.LastChanged)
            .ToList();
        if (ordered.Count == 0) return [];

        var totals = new Dictionary<string, double>(StringComparer.Ordinal);
        for (var i = 0; i < ordered.Count; i++)
        {
            var start = ordered[i].LastChanged!.Value;
            var end = i + 1 < ordered.Count ? ordered[i + 1].LastChanged!.Value : to;
            var seconds = (end - start).TotalSeconds;
            if (seconds <= 0) continue;

            var state = ordered[i].State;
            var klass = LitterRobotFaults
                .Classify(state is null || ordered[i].IsUnavailable ? null : state)
                .Class.ToString();
            totals[klass] = totals.GetValueOrDefault(klass) + seconds;
        }

        var total = totals.Values.Sum();
        if (total <= 0) return [];
        return totals.ToDictionary(kv => kv.Key, kv => kv.Value / total);
    }

    /// <summary>
    /// How fast the drawer fills, and how long until it needs emptying.
    /// </summary>
    /// <remarks>
    /// Only rises count. Emptying the drawer drops the reading to near zero, and folding that fall
    /// into the average would report a box that fills more slowly the more it is used.
    /// </remarks>
    private static (double? PercentPerDay, int? DaysToFull) DrawerTrend(IReadOnlyList<LitterDaySample> days)
    {
        var known = days.Where(d => d.DrawerPercent is not null).ToList();
        if (known.Count < 2) return (null, null);

        double rise = 0;
        for (var i = 1; i < known.Count; i++)
        {
            var delta = known[i].DrawerPercent!.Value - known[i - 1].DrawerPercent!.Value;
            if (delta > 0) rise += delta;
        }

        var span = known[^1].Day.DayNumber - known[0].Day.DayNumber;
        if (span <= 0) return (null, null);

        var perDay = rise / span;
        var current = known[^1].DrawerPercent!.Value;
        int? toFull = perDay > 0.01 && current < DrawerFullPercent
            ? (int)Math.Ceiling((DrawerFullPercent - current) / perDay)
            : null;

        return (perDay, toFull);
    }

    private static double? Number(HaState state)
    {
        if (state.IsUnavailable) return null;
        return double.TryParse(state.State, NumberStyles.Float, CultureInfo.InvariantCulture, out var value)
            ? value
            : null;
    }
}
