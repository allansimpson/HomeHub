namespace HomeHub.Api.Care;

using System.ComponentModel.DataAnnotations;

/// <summary>
/// One logged moment in a child's day, kept by HomeHub itself.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why this exists at all.</b> Care logging ran entirely through the Huckleberry integration,
/// which exposes seventeen Home Assistant services and no more: bottle, four diaper kinds, growth,
/// and the nursing and sleep timers. Verified against the live integration rather than taken from a
/// document — there is no pump, solids, medicine, bath, tummy-time or temperature service, and no
/// sensor for any of them, so those six types could not be logged at all. None of the writes accepts
/// a timestamp either, so nothing could be recorded after the fact.
/// </para>
/// <para>
/// A native table answers all of that at once: ten types instead of four, a real
/// <see cref="AtUtc"/> so a 2am feed can be written at 6am, and — the thing Huckleberry cannot do
/// from here at all — <b>edit and delete</b>. The whole Baby surface is built around writes being
/// irreversible; that was a property of the integration, not of the domain.
/// </para>
/// <para>
/// <b>One table, discriminated.</b> Every type is the same shape — something happened, at a time,
/// with a few numbers and words attached — and the screens that read it all want the same query:
/// the newest of a kind, everything today, totals by type. Ten tables would make each of those a
/// union and buy nothing; the columns below are the union of what the ten types record, and each is
/// null where its type has nothing to say.
/// </para>
/// </remarks>
public class CareEntry
{
    public int Id { get; set; }

    /// <summary>Which child, by the same key the Huckleberry surface uses (<c>conrad</c>).</summary>
    /// <remarks>
    /// A string rather than a foreign key, deliberately: children are defined upstream, HomeHub has
    /// no table of them, and inventing one here would create a second roster to keep in step with
    /// the household's own app.
    /// </remarks>
    [Required]
    [MaxLength(64)]
    public required string ChildKey { get; set; }

    public CareEntryType Type { get; set; }

    /// <summary>
    /// When it happened — not when it was written down.
    /// </summary>
    /// <remarks>
    /// The field the whole redesign hangs on. Huckleberry's services log at the moment of the call,
    /// which is why the design's When picker had nothing behind it: a bottle given at 2am and
    /// entered at 6am was recorded as 6am, and there was no way to say otherwise. Here it is an
    /// ordinary column, so "when" is a question the panel can ask.
    /// </remarks>
    public DateTime AtUtc { get; set; }

    /// <summary>When the row was written, which is a different fact from <see cref="AtUtc"/>.</summary>
    public DateTime CreatedUtc { get; set; }

    /// <summary>Last edited, or null if it never was. Editing is the point of owning the data.</summary>
    public DateTime? UpdatedUtc { get; set; }

    // ---- The measured value, whatever the type measures ----

    /// <summary>
    /// Ounces, millilitres, minutes, degrees — whatever <see cref="Unit"/> says.
    /// </summary>
    /// <remarks>
    /// <b>Nullable, and that nullability is load-bearing.</b> A pump session with no amount is the
    /// ordinary case — five of the household's last six were saved without one — and Huckleberry
    /// stores that as <c>0 oz</c> and then reports <c>0 oz</c> back, which is a measurement nobody
    /// took. Null here means "not measured" and renders as an em dash; zero means somebody measured
    /// zero.
    /// </remarks>
    public double? Amount { get; set; }

    [MaxLength(16)]
    public string? Unit { get; set; }

    /// <summary>Bottle only: how much went in, and how much came back. Null on every other type.</summary>
    /// <remarks>
    /// <para>
    /// <b><see cref="Amount"/> is what was taken — these two are what it was worked out from.</b>
    /// The bottle sheet asks for the bottle and what was left in it and subtracts, because that is
    /// what somebody standing at the sink actually knows: they poured four ounces and half an ounce
    /// came back. Only the difference was ever stored, and the sheet warned about it in a comment —
    /// so reopening a feed to correct it showed the *consumed* figure sitting in the OFFERED field
    /// with REMAINING blank, which reads as a bottle nobody drank from and quietly loses how big the
    /// bottle was.
    /// </para>
    /// <para>
    /// Kept alongside the difference rather than replacing it. <see cref="Amount"/> stays the figure
    /// every other surface reads — the day totals, the row on the log, the last-fed line — and none
    /// of them should have to know that one type computes it. These two exist so a correction opens
    /// on what was actually entered.
    /// </para>
    /// </remarks>
    public double? Offered { get; set; }

    /// <inheritdoc cref="Offered"/>
    public double? Left { get; set; }

    /// <summary>Minutes, for the types that are a duration: nursing, pump, sleep, tummy time.</summary>
    public double? DurationMinutes { get; set; }

    // ---- Type-specific detail, each null where its type has nothing to say ----

    /// <summary>Bottle contents, diaper kind, medicine name, solids food — the type's own noun.</summary>
    /// <remarks>
    /// Stored as the vendor's own enum spelling where one exists (<c>breast_milk</c>, <c>both</c>),
    /// because the household reads the same words in the Huckleberry app and a second vocabulary is
    /// a second thing to reconcile. Free text only where the domain has no enum — a medicine name.
    /// </remarks>
    [MaxLength(120)]
    public string? Kind { get; set; }

    /// <summary>`left`, `right` or `both`, for nursing and pump.</summary>
    [MaxLength(16)]
    public string? Side { get; set; }

    /// <summary>`little`, `medium`, `big` — a diaper's amount.</summary>
    [MaxLength(16)]
    public string? PeeAmount { get; set; }

    [MaxLength(16)]
    public string? PooAmount { get; set; }

    [MaxLength(16)]
    public string? Color { get; set; }

    [MaxLength(24)]
    public string? Consistency { get; set; }

    public bool? DiaperRash { get; set; }

    /// <summary>Growth: pounds and ounces as the household reads them, never decimal pounds.</summary>
    /// <remarks>
    /// The trap named in the capability notes. Weight is decimal pounds upstream, and sending 8.5
    /// where 8 lb 5 oz was meant records a wildly wrong measurement. Kept as the pair here and
    /// folded at the edge, so the mistake has one place it could happen instead of every call site.
    /// </remarks>
    public double? Pounds { get; set; }

    public double? Ounces { get; set; }

    public double? HeightInches { get; set; }

    public double? HeadInches { get; set; }

    [MaxLength(500)]
    public string? Notes { get; set; }

    /// <summary>Whether the household typed this on the panel, or it was pulled in from Huckleberry.</summary>
    public CareEntrySource Source { get; set; }

    /// <summary>
    /// What an imported row was, upstream — so importing twice writes it once.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Synthesised, because Huckleberry does not supply one.</b> Its calendar events carry a
    /// <c>uid</c> field and it is null on every single one, so there is no vendor identifier to key
    /// on. The composite below stands in: child, type and the instant it happened, which the feed
    /// gives to the millisecond (<c>06:13:55.481</c>). Two bottles at the same millisecond is not a
    /// thing that happens.
    /// </para>
    /// <para>
    /// A unique index enforces it rather than a check-then-insert, so a re-sync running twice at once
    /// cannot slip a duplicate through the gap between the two. Null for anything typed on the panel,
    /// and the index is filtered to match — those rows have no upstream to collide with.
    /// </para>
    /// </remarks>
    [MaxLength(160)]
    public string? ExternalKey { get; set; }

    public int Version { get; set; } = 1;
}

/// <summary>Where a row came from.</summary>
/// <remarks>
/// HomeHub is the record — the panel writes here and nowhere else.
/// </remarks>
public enum CareEntrySource
{
    /// <summary>Typed on the panel. The only kind written since 2026-08-30.</summary>
    Panel,

    /// <summary>
    /// Pulled in from the retired Huckleberry integration's calendar, by an import that no longer
    /// exists.
    /// </summary>
    /// <remarks>
    /// <b>Kept because rows still carry it.</b> The importer went with the integration, but the
    /// entries it wrote are the household's own history; rewriting them to say <c>Panel</c> would be
    /// falsifying the log to tidy up a value nothing branches on.
    /// </remarks>
    HuckleberryImport,
}

/// <summary>
/// The ten things a household logs, as the design's tile grid names them.
/// </summary>
/// <remarks>
/// Five of these were recoverable from the retired integration's calendar by the import that ran
/// during the migration — bottle, nursing, diaper, sleep and medicine. The rest had never been
/// recorded anywhere and started empty, which was the honest state for them: it had no service to
/// write them and no sensor to read
/// them, so there is nothing to backfill.
/// </remarks>
public enum CareEntryType
{
    Bottle,
    Nursing,
    Pump,
    Diaper,
    Solids,
    Sleep,
    Medicine,
    Bath,
    TummyTime,
    Temperature,

    /// <summary>Not a tile — a measurement, entered deliberately. Kept here so the log is complete.</summary>
    Growth,
}

/// <summary>
/// A timer that is running now, or paused.
/// </summary>
/// <remarks>
/// <para>
/// Separate from <see cref="CareEntry"/> because a running session is not yet a record of anything:
/// it becomes one on COMPLETE and becomes nothing on CANCEL. Conflating them would leave a
/// half-written feed in the log the moment somebody started a timer and walked off.
/// </para>
/// <para>
/// <b>Cancel and complete are different acts</b>, and the design is emphatic that they must never
/// be one ambiguous stop. That distinction lives here: complete writes an entry, cancel deletes the
/// row and writes nothing.
/// </para>
/// </remarks>
public class CareTimer
{
    public int Id { get; set; }

    [Required]
    [MaxLength(64)]
    public required string ChildKey { get; set; }

    public CareEntryType Type { get; set; }

    /// <summary>`left` or `right` for nursing; null for sleep.</summary>
    [MaxLength(16)]
    public string? Side { get; set; }

    public DateTime StartedUtc { get; set; }

    /// <summary>Set while paused, null while running.</summary>
    public DateTime? PausedUtc { get; set; }

    /// <summary>Time already banked by earlier run/pause cycles, so a pause is not a reset.</summary>
    public double AccumulatedMinutes { get; set; }

    /// <summary>
    /// Pump only: minutes of stimulation, then expression.
    /// </summary>
    /// <remarks>
    /// The pump runs two phases and the panel counts the first one *down*, because the number wanted
    /// at 6am is how long until the switch. Both are adjustable mid-session, which moves the switch
    /// and its chime with them.
    /// </remarks>
    public int? PhaseOneMinutes { get; set; }

    public int? PhaseTwoMinutes { get; set; }

    /// <summary>1 or 2 while a pump session runs. Null for every other type.</summary>
    public int? Phase { get; set; }

    /// <summary>
    /// Elapsed minutes at the moment expression began. Null until the switch.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Expression is seventeen minutes of expression, not seventeen minutes minus however late
    /// somebody was.</b> Both phases used to be measured from the start of the session, so the
    /// second one ended at <c>PhaseOneMinutes + PhaseTwoMinutes</c> however long the first actually
    /// ran — and nothing switches a pump on anybody's behalf, so overrunning stimulation by four
    /// minutes at 4am silently docked four minutes off the pumping. The phase that was short was
    /// the one that produces the milk.
    /// </para>
    /// <para>
    /// Elapsed minutes rather than a switch timestamp, because elapsed is the figure that already
    /// knows about pauses — <see cref="AccumulatedMinutes"/> banks them, and a wall clock would
    /// count a ten-minute pause as ten minutes of expression.
    /// </para>
    /// <para>
    /// Null on a session that has not switched yet, and on any that was already running when this
    /// column arrived; the panel falls back to the old reading for those rather than showing a
    /// countdown it cannot work out.
    /// </para>
    /// </remarks>
    public double? PhaseTwoAtMinutes { get; set; }

    /// <summary>
    /// Pump only: the session has been finished and is being held for its amount. Null while it runs.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>A pump session is measured at one moment and written at another.</b> How much was
    /// expressed is knowable only at the end, so FINISH stops the clock and holds the session here
    /// rather than writing it: the panel then asks for the amount once, and SAVE writes the session
    /// and its amount together. There is deliberately no path that writes a session and updates its
    /// amount afterwards, and none that carries an amount from before the session ran.
    /// </para>
    /// <para>
    /// The row is what makes the hold survive. Closing the panel, walking away, or reopening the app
    /// on another device all find the same held session — the day view reports it as awaiting an
    /// amount, and opening PUMP returns to the finish step rather than offering to start a new one.
    /// <see cref="AccumulatedMinutes"/> is banked at the same moment, so the length being written is
    /// what the session actually ran and not what has elapsed since somebody put the phone down.
    /// </para>
    /// </remarks>
    public DateTime? EndedUtc { get; set; }
}
