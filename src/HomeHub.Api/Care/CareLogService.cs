namespace HomeHub.Api.Care;

using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;

/// <summary>What a sheet sends when it saves. Every field optional but the two that identify it.</summary>
/// <remarks>
/// One shape for all ten types rather than ten inputs. The types differ in which fields they fill,
/// not in what a logged moment <i>is</i>, and a controller action per type would be ten near-copies
/// of the same validation. What is type-specific lives in <see cref="CareLogService.Normalise"/>.
/// </remarks>
public sealed record CareEntryInput(
    CareEntryType Type,
    /// <summary>When it happened. Null means now — which is what every sheet defaults to.</summary>
    DateTime? AtUtc = null,
    double? Amount = null,
    string? Unit = null,
    double? DurationMinutes = null,
    string? Kind = null,
    string? Side = null,
    string? PeeAmount = null,
    string? PooAmount = null,
    string? Color = null,
    string? Consistency = null,
    bool? DiaperRash = null,
    double? Pounds = null,
    double? Ounces = null,
    double? HeightInches = null,
    double? HeadInches = null,
    string? Notes = null,
    /// <summary>
    /// The panel's own identifier for this entry, so writing it twice records it once.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>What makes an offline write safe to replay.</b> An entry logged without a connection sits
    /// in the client's queue until one comes back, and the request that then carries it can fail in
    /// the one way a retry cannot distinguish: the row is written and the response is lost. Retrying
    /// logs the feed twice; not retrying loses it. Neither is acceptable on a medical record, and
    /// picking between them is what a key removes the need to do.
    /// </para>
    /// <para>
    /// Null from anything that is not replaying — the timer's own complete, an import — and those
    /// rows keep a null <see cref="CareEntry.ExternalKey"/> exactly as before.
    /// </para>
    /// </remarks>
    string? ClientKey = null);

/// <summary>
/// The care log HomeHub owns: ten types, a real time, and rows that can be corrected.
/// </summary>
/// <remarks>
/// <para>
/// Everything the Huckleberry path could not do lives here. Writes are ordinary rows, so they can be
/// edited and deleted — the Baby surface was built around irreversible writes, and that was a
/// property of the integration rather than of the domain. Timers are separate until they complete,
/// because a running session is not yet a record of anything.
/// </para>
/// </remarks>
public sealed class CareLogService
{
    private readonly HomeHubDbContext _db;
    private readonly TimeProvider _time;

    public CareLogService(HomeHubDbContext db, TimeProvider time)
    {
        _db = db;
        _time = time;
    }

    private DateTime UtcNow => _time.GetUtcNow().UtcDateTime;

    /// <summary>
    /// Write an entry. Idempotent when the panel supplies a <see cref="CareEntryInput.ClientKey"/>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Writing the same key twice returns the first row rather than a second one.</b> That is
    /// what makes an offline entry safe to replay: the failure a queue cannot tell apart from a
    /// dropped request is the one where the row landed and the response did not, and on a feed log
    /// the cost of guessing wrong is a duplicated feed at 3am — or a lost one.
    /// </para>
    /// <para>
    /// Keyed through <see cref="CareEntry.ExternalKey"/>, which already exists for exactly this
    /// reason on the import path and already carries a unique filtered index. The <c>panel:</c>
    /// prefix keeps the two namespaces apart from the import's <c>hb:</c>; nothing can collide.
    /// </para>
    /// <para>
    /// The look-up before the insert answers the ordinary case. The catch below answers the race the
    /// look-up cannot: two replays arriving together both find nothing, and the index — not this
    /// method — is what actually decides there is one row. Note that the in-memory provider used by
    /// the tests does not enforce indexes, so the first path is the one they exercise.
    /// </para>
    /// </remarks>
    public async Task<CareEntry> AddAsync(string childKey, CareEntryInput input, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(input);
        var externalKey = ClientEntryKey(input.ClientKey);

        if (externalKey is not null && await FindByExternalKeyAsync(externalKey, ct) is { } already)
            return already;

        var entry = new CareEntry
        {
            ChildKey = childKey,
            Type = input.Type,
            // Null means now. A sheet that never opened the When row sends nothing, and the ordinary
            // case — logging as you finish — costs no round trip through a time picker.
            AtUtc = input.AtUtc ?? UtcNow,
            CreatedUtc = UtcNow,
            Source = CareEntrySource.Panel,
            ExternalKey = externalKey,
        };
        Apply(entry, input);
        Normalise(entry);

        _db.CareEntries.Add(entry);
        try
        {
            await _db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException) when (externalKey is not null)
        {
            // The other replay won. Drop ours so the context is not left holding a row that was
            // never written, and hand back the one that was.
            _db.Entry(entry).State = EntityState.Detached;
            // Only swallow the failure if a row with our key is genuinely there. A `DbUpdateException`
            // that was about something else must still surface — a write that silently did nothing is
            // the failure mode this whole path exists to prevent.
            var winner = await FindByExternalKeyAsync(externalKey, ct);
            if (winner is null) throw;
            return winner;
        }
        return entry;
    }

    /// <summary>A panel-supplied key, namespaced so it cannot collide with an imported one.</summary>
    private static string? ClientEntryKey(string? clientKey)
    {
        var trimmed = clientKey?.Trim();
        if (string.IsNullOrEmpty(trimmed)) return null;
        // The column holds 160; a UUID is 36. Truncating rather than rejecting keeps a client that
        // sends something longer working — the key only has to be stable and unique, not short.
        var key = $"panel:{trimmed}";
        return key.Length <= 160 ? key : key[..160];
    }

    private Task<CareEntry?> FindByExternalKeyAsync(string externalKey, CancellationToken ct) =>
        _db.CareEntries.FirstOrDefaultAsync(e => e.ExternalKey == externalKey, ct);

    /// <summary>Correct an entry. Returns null when it is gone.</summary>
    /// <remarks>
    /// The capability the whole redesign is for. Huckleberry has no edit service, so a mistyped
    /// amount was permanent and the panel had to warn about it above every SAVE; here it is a row.
    /// </remarks>
    public async Task<CareEntry?> UpdateAsync(
        int id, CareEntryInput input, int? baseVersion, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(input);
        var entry = await _db.CareEntries.FirstOrDefaultAsync(e => e.Id == id, ct);
        if (entry is null) return null;

        /*
         * A correction that was made against an older row is refused rather than applied.
         *
         * This is the case a queue creates and a live panel does not: an edit typed on a phone with
         * no signal can sit for hours, and in that time the same entry may have been corrected on
         * the wall panel. Applying both in arrival order means the older wins silently. The
         * household is asked instead — which is the policy every other queued domain here follows.
         */
        // Thrown with the entity rather than a DTO: the shape the client reviews is the controller's
        // business, and this file has no reason to know about it.
        if (baseVersion is { } v && v != entry.Version) throw new ConcurrencyConflictException(entry);

        // The type is not editable: a bottle corrected into a diaper is two different mistakes, and
        // deleting and re-adding says what happened more clearly than a row that changed species.
        if (input.AtUtc is { } at) entry.AtUtc = at;
        Apply(entry, input);
        Normalise(entry);
        entry.UpdatedUtc = UtcNow;
        entry.Version++;

        await _db.SaveChangesAsync(ct);
        return entry;
    }

    public async Task<bool> DeleteAsync(int id, int? baseVersion, CancellationToken ct)
    {
        var entry = await _db.CareEntries.FirstOrDefaultAsync(e => e.Id == id, ct);
        if (entry is null) return false;
        // Same reasoning as the correction above: a delete queued offline may be aimed at a row that
        // has since been corrected, and removing it would take the correction with it.
        if (baseVersion is { } v && v != entry.Version) throw new ConcurrencyConflictException(entry);
        _db.CareEntries.Remove(entry);
        await _db.SaveChangesAsync(ct);
        return true;
    }

    /// <summary>Everything in a window, newest first — the log screen's one query.</summary>
    public async Task<IReadOnlyList<CareEntry>> ListAsync(
        string childKey, DateTime fromUtc, DateTime toUtc, CancellationToken ct) =>
        await _db.CareEntries
            .Where(e => e.ChildKey == childKey && e.AtUtc >= fromUtc && e.AtUtc < toUtc)
            .OrderByDescending(e => e.AtUtc)
            .ToListAsync(ct);

    /// <summary>
    /// The newest entry of each type — the tile captions and every sheet's pre-fill.
    /// </summary>
    /// <remarks>
    /// One query rather than ten. A type the household has never logged is simply absent from the
    /// result, which is what drives the design's <c>NO RECORD</c> caption; an empty tile is a fact
    /// about the household, not a hole in the data.
    /// </remarks>
    public async Task<IReadOnlyDictionary<CareEntryType, CareEntry>> LastByTypeAsync(
        string childKey, CancellationToken ct)
    {
        var rows = await _db.CareEntries
            .Where(e => e.ChildKey == childKey)
            .GroupBy(e => e.Type)
            .Select(g => g.OrderByDescending(e => e.AtUtc).First())
            .ToListAsync(ct);

        return rows.ToDictionary(e => e.Type);
    }

    // ---- timers ----

    public async Task<CareTimer?> RunningAsync(string childKey, CareEntryType type, CancellationToken ct) =>
        await _db.CareTimers.FirstOrDefaultAsync(t => t.ChildKey == childKey && t.Type == type, ct);

    public async Task<IReadOnlyList<CareTimer>> RunningAsync(string childKey, CancellationToken ct) =>
        await _db.CareTimers.Where(t => t.ChildKey == childKey).ToListAsync(ct);

    /// <summary>
    /// Begin a session. Returns the existing one rather than starting a second.
    /// </summary>
    /// <remarks>
    /// Two nursing timers is not a state the domain has an answer for. The unique index makes it
    /// unrepresentable; this makes the double-tap that would have hit it harmless.
    /// </remarks>
    public async Task<CareTimer> StartTimerAsync(
        string childKey, CareEntryType type, string? side, int? phaseOne, int? phaseTwo, CancellationToken ct)
    {
        if (await RunningAsync(childKey, type, ct) is { } already) return already;

        var timer = new CareTimer
        {
            ChildKey = childKey,
            Type = type,
            Side = side,
            StartedUtc = UtcNow,
            // 3 and 17 — the household's own pattern. The panel sends both explicitly, so these
            // only apply to a session started without them; they match the client's `PUMP_PHASES`
            // so the two cannot quietly disagree about what "default" means.
            PhaseOneMinutes = type == CareEntryType.Pump ? phaseOne ?? 3 : null,
            PhaseTwoMinutes = type == CareEntryType.Pump ? phaseTwo ?? 17 : null,
            Phase = type == CareEntryType.Pump ? 1 : null,
        };
        _db.CareTimers.Add(timer);
        await _db.SaveChangesAsync(ct);
        return timer;
    }

    /// <summary>
    /// Stop a pump session's clock and hold it for its amount. Writes nothing.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>The one stop in this domain that is neither a write nor a discard.</b> How much was
    /// expressed is knowable only once the session is over, so FINISH banks the measurement and
    /// leaves the row standing; the panel asks for the amount, and
    /// <see cref="CompleteTimerAsync"/> writes the session and its amount in one act. See
    /// <see cref="CareTimer.EndedUtc"/> for why the hold is a row rather than panel state.
    /// </para>
    /// <para>
    /// Finishing twice is the first finish. The measurement is taken at the moment the clock stops,
    /// and a second call — a stale panel, a replayed request — must not restamp a session that has
    /// been sitting held for ten minutes with the length it had when it ended.
    /// </para>
    /// </remarks>
    public async Task<CareTimer?> FinishTimerAsync(string childKey, CareEntryType type, CancellationToken ct)
    {
        var timer = await RunningAsync(childKey, type, ct);
        if (timer is null || timer.EndedUtc is not null) return timer;

        // Bank first, then stamp: `ElapsedMinutes` reads the running clock, and it stops meaning
        // anything the moment the session is held. `StartedUtc` moves with it for the reason given
        // on the pause below — the entry's own start is derived from the pair.
        timer.AccumulatedMinutes = ElapsedMinutes(timer);
        timer.StartedUtc = UtcNow;
        timer.EndedUtc = UtcNow;
        await _db.SaveChangesAsync(ct);
        return timer;
    }

    /// <summary>Pause: bank what has run so far, so resuming is not a restart.</summary>
    public async Task<CareTimer?> PauseTimerAsync(string childKey, CareEntryType type, CancellationToken ct)
    {
        var timer = await RunningAsync(childKey, type, ct);
        if (timer is null || timer.PausedUtc is not null || timer.EndedUtc is not null) return timer;

        timer.AccumulatedMinutes = ElapsedMinutes(timer);
        /*
         * The clock moves with the bank, because the pair is what the written entry is derived from.
         *
         * `CompleteTimerAsync` back-dates the entry to `StartedUtc − AccumulatedMinutes`, which is
         * only the session's own start while the two are in step — and this banked the run without
         * moving the mark it was banked from. A nursing session started at 10:00 and paused at
         * 10:20 wrote itself as having begun at 9:40: an hour of the night the household did not
         * spend feeding, on the one screen that exists to say when things happened. `Resume` already
         * moves the mark for the same reason.
         */
        timer.StartedUtc = UtcNow;
        timer.PausedUtc = UtcNow;
        await _db.SaveChangesAsync(ct);
        return timer;
    }

    public async Task<CareTimer?> ResumeTimerAsync(string childKey, CareEntryType type, CancellationToken ct)
    {
        var timer = await RunningAsync(childKey, type, ct);
        // A held session has stopped for good — there is nothing to resume, only an amount to give.
        if (timer is null || timer.PausedUtc is null || timer.EndedUtc is not null) return timer;

        timer.StartedUtc = UtcNow;
        timer.PausedUtc = null;
        await _db.SaveChangesAsync(ct);
        return timer;
    }

    public async Task<CareTimer?> SwitchSideAsync(string childKey, CareEntryType type, string side, CancellationToken ct)
    {
        var timer = await RunningAsync(childKey, type, ct);
        if (timer is null) return null;
        timer.Side = side;
        await _db.SaveChangesAsync(ct);
        return timer;
    }

    /// <summary>Advance a pump session to expression, early or on time.</summary>
    /// <remarks>
    /// <para>
    /// <b>Expression starts its full length here, whenever here is.</b> Stamping the elapsed clock
    /// is what makes that true: the panel counts the second phase from this mark rather than from
    /// the start of the session, so stimulation running four minutes over costs the session four
    /// minutes and costs expression nothing. See <see cref="CareTimer.PhaseTwoAtMinutes"/>.
    /// </para>
    /// <para>
    /// Switching twice is the first switch. The button disables itself in phase two, but a second
    /// tap arriving from a stale panel or a replayed request must not restart the seventeen minutes
    /// somebody is already eight minutes into.
    /// </para>
    /// </remarks>
    public async Task<CareTimer?> SwitchPhaseAsync(string childKey, CancellationToken ct)
    {
        var timer = await RunningAsync(childKey, CareEntryType.Pump, ct);
        if (timer is null) return null;
        // A held session has no phases left to advance through.
        if (timer.Phase == 2 || timer.EndedUtc is not null) return timer;

        timer.Phase = 2;
        timer.PhaseTwoAtMinutes = Math.Round(ElapsedMinutes(timer), 2);
        await _db.SaveChangesAsync(ct);
        return timer;
    }

    /// <summary>
    /// Throw the session away. Writes nothing.
    /// </summary>
    /// <remarks>
    /// <b>Cancel and complete are different acts</b>, and the design is emphatic they must never be
    /// one ambiguous stop. This is the half that leaves no trace.
    /// </remarks>
    public async Task<bool> CancelTimerAsync(string childKey, CareEntryType type, CancellationToken ct)
    {
        var timer = await RunningAsync(childKey, type, ct);
        if (timer is null) return false;
        _db.CareTimers.Remove(timer);
        await _db.SaveChangesAsync(ct);
        return true;
    }

    /// <summary>
    /// End the session and write it to the log.
    /// </summary>
    /// <remarks>
    /// The entry is back-dated to when the session <i>started</i>, not when somebody pressed the
    /// button — a feed that ran from 9:01 belongs at 9:01 in the day's rhythm. <paramref name="amount"/>
    /// is for pump, where it is genuinely optional: null persists as "not measured" and must never
    /// become a zero somebody did not weigh.
    /// </remarks>
    public async Task<CareEntry?> CompleteTimerAsync(
        string childKey, CareEntryType type, double? amount, string? unit, DateTime? atUtc, CancellationToken ct)
    {
        var timer = await RunningAsync(childKey, type, ct);
        if (timer is null) return null;

        var minutes = Math.Round(ElapsedMinutes(timer), 2);
        _db.CareTimers.Remove(timer);

        var entry = new CareEntry
        {
            ChildKey = childKey,
            Type = type,
            /*
             * The panel's correction wins, and only the pump's finish step offers one.
             *
             * A timer left running while the pump was packed away measures more than the session
             * ran, and that is the common case rather than the careless one — so the finish panel
             * lets the start be moved and sends it here. Absent, the session's own reckoning
             * stands: the clock's mark less what it banked, which is where the session began.
             */
            AtUtc = atUtc ?? timer.StartedUtc.AddMinutes(-timer.AccumulatedMinutes),
            CreatedUtc = UtcNow,
            Source = CareEntrySource.Panel,
            DurationMinutes = minutes,
            Side = timer.Side,
            Amount = amount,
            Unit = amount is null ? null : unit ?? "oz",
        };
        _db.CareEntries.Add(entry);
        await _db.SaveChangesAsync(ct);
        return entry;
    }

    /// <summary>How long a session has run, banked time included and a pause held still.</summary>
    /// <remarks>
    /// A finished-but-unsaved session holds still for the same reason a paused one does, and more
    /// firmly: its length is a measurement that has already been taken, and it must read the same
    /// ten minutes later when somebody comes back to give it an amount.
    /// </remarks>
    public double ElapsedMinutes(CareTimer timer)
    {
        ArgumentNullException.ThrowIfNull(timer);
        if (timer.EndedUtc is not null || timer.PausedUtc is not null) return timer.AccumulatedMinutes;
        return timer.AccumulatedMinutes + (UtcNow - timer.StartedUtc).TotalMinutes;
    }

    private static void Apply(CareEntry entry, CareEntryInput input)
    {
        entry.Amount = input.Amount;
        entry.Unit = input.Unit;
        entry.DurationMinutes = input.DurationMinutes;
        entry.Kind = input.Kind;
        entry.Side = input.Side;
        entry.PeeAmount = input.PeeAmount;
        entry.PooAmount = input.PooAmount;
        entry.Color = input.Color;
        entry.Consistency = input.Consistency;
        entry.DiaperRash = input.DiaperRash;
        entry.Pounds = input.Pounds;
        entry.Ounces = input.Ounces;
        entry.HeightInches = input.HeightInches;
        entry.HeadInches = input.HeadInches;
        entry.Notes = input.Notes;
    }

    /// <summary>
    /// The few rules that are the type's rather than the row's.
    /// </summary>
    /// <remarks>
    /// <b>An amount of zero is erased, not stored.</b> Huckleberry's pump takes a missing amount and
    /// writes <c>0 oz</c>, then reports <c>0 oz</c> back as though somebody had weighed it. A sheet
    /// that sends zero for "I did not measure" would recreate exactly that, so zero on the types
    /// where measurement is optional becomes null — the em dash the design draws.
    /// </remarks>
    private static void Normalise(CareEntry entry)
    {
        if (entry.Type is CareEntryType.Pump && entry.Amount is 0) entry.Amount = null;
        if (entry.Amount is null) entry.Unit = null;

        // A unit with nothing to measure is noise on the row.
        if (entry.DurationMinutes is <= 0) entry.DurationMinutes = null;
    }
}
