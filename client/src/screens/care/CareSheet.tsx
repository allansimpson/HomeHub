import { useMemo, useState } from 'react'
import {
  CARE_LABELS, PUMP_PHASES, careTitle, clockLabel, elapsedLabel, kindLabel, otherSide, reviewSentence,
  valueLabel,
} from '../../app/care'
import { CarePanel } from './CarePanel'
import { WhenPickerBody, WhenPickerFoot, useWhenDraft } from './WhenPicker'
import type { CareEntryDto, CareEntryInput, CareEntryTypeName } from '../../api/types'

/**
 * The diaper colour swatches.
 *
 * <b>The fill is the data.</b> These are painted blocks of the colour being recorded, not bordered
 * boxes of text, and the selection is a brass frame *around* the block rather than a change to it —
 * because the moment the fill changes to indicate selection it stops being the thing it is
 * reporting. The hex values are documentation and are never printed on screen.
 */
const SWATCHES: Record<string, string> = {
  yellow: '#E0BE3E',
  brown: '#8A5A32',
  black: '#2E2A26',
  green: '#45702A',
  red: '#B5402F',
  gray: '#C9C3B7',
}

/**
 * What a sheet offers, per type.
 *
 * <b>One sheet, configured, rather than ten screens.</b> The design says so itself — medicine is
 * "the light frame, reused by bath, tummy time and temperature" — and the ten differ in which rows
 * they show, not in what saving means. Ten components would be ten copies of the same review line
 * and the same SAVE, drifting apart one fix at a time.
 *
 * <b>`columns` is not decoration.</b> Every chip row in the design is an equal-width grid with a
 * stated column count — five quick amounts, three contents, four kinds, six colours — and the
 * counts are chosen so the values line up in readable rows. Letting the chips size to their text
 * instead gives a ragged edge and puts `MUCOUSY` on a different line depending on what precedes it.
 */
export interface SheetShape {
  measure?: {
    /** The section label — `AMOUNT`, `DOSE`, `TOTAL`. */
    label: string
    /** The wire unit stored with the entry. */
    unit: string
    /** The caption under the stepper value — `OUNCES`, `ML`, `MINUTES`. */
    caption: string
    /** The right-hand note on the section label row. */
    note?: string
    step: number
    quick: number[]
    columns: number
  }
  /**
   * The measurement is genuinely optional, so NONE is a first-class choice beside the quick values.
   *
   * Pump only. Five of the last six real sessions were saved without an amount, and the old app
   * stored that as `0 oz` and reported `0 oz` back — a measurement nobody took.
   */
  optionalAmount?: boolean
  /** The two-way row at the top of the diaper panel. */
  mode?: { values: string[]; swaps: ChoiceField; then: Record<string, string[]> }
  choices?: ChoiceRow[]
  /** Nursing: the two big start-a-timer tiles, and the side row that follows the stepper. */
  timer?: boolean
  /** Pump: the two phase steppers and START SESSION, above the typed route. */
  phases?: boolean
  /**
   * OR LOG ONE YOU FINISHED — a length and an amount, as two compact rows.
   *
   * <b>Pump only, and it is the panel's second route rather than its measurement.</b> The one thing
   * this panel must never do is ask for an amount before the session has run; the amount is
   * knowable at exactly one moment, the end. A session started here is given its amount on the
   * finish panel. A session pumped away from the panel is already over by the time anybody is
   * typing it, so here — and only here — the length and the amount are entered together.
   *
   * The full-height stepper is deliberately not drawn on this panel. `measure` still supplies the
   * step, unit and quick values, which the finish panel reads too, so the two cannot disagree about
   * what an ounce figure looks like.
   */
  typed?: boolean
  /**
   * One START button and nothing to configure — a session with no side and no phases.
   *
   * <b>The third kind of timer, and the one that had no way to be started.</b> Nursing offers two
   * tiles because a session begins on a side, and pump offers a button under its phase steppers
   * because those decide when it switches. Tummy time needs neither: there is a single thing to
   * begin and the only question is when it ends. Without this the panel had a minutes stepper and
   * a SAVE, so the only way to record a session was to watch a clock elsewhere and type the answer
   * afterwards — which is the thing a timer exists to stop somebody doing.
   */
  stopwatch?: boolean
  /** Bottle: the gauge, with OFFERED and REMAINING adjusting it. See the bands themselves. */
  bottle?: boolean
  /** Medicine: the list of what has been given before, above the dose. */
  medicines?: boolean
}

interface ChoiceRow {
  label: string
  note?: string
  field: ChoiceField
  values: string[]
  columns: number
  /** Painted colour blocks rather than bordered words. */
  swatches?: boolean
  /** The nursing SIDE row, which sits right-aligned rather than spanning the panel. */
  align?: 'right'
}

/**
 * `size` is not a wire field.
 *
 * The API carries the amount in two columns — `peeAmount` and `pooAmount` — while the panel offers
 * one row of LITTLE · MEDIUM · BIG, because "how big was it" is one question however the diaper
 * turned out. Which column it lands in is decided from the kind when the input is built.
 */
type ChoiceField = 'kind' | 'size' | 'color' | 'consistency' | 'side'

/**
 * The seven bottle contents are the API's own enum, and the four diaper kinds are too — the
 * household reads the same words in the app this log replaces, so a second vocabulary would be a
 * second thing to reconcile. `MIXED` is the one exception: it is the word the household reads,
 * while `both` is what the wire carries.
 */
/**
 * What each panel is made of.
 *
 * Exported for its test rather than for any caller. Every type in `TIMED_TYPES` must carry one of
 * the three start affordances — `timer`, `phases` or `stopwatch` — and sleep spent the whole life
 * of the log carrying none of them: its tile said `TIMER`, its sheet had a stepper and a SAVE, and
 * the session it advertised could not be started. That is not a mistake review catches, because
 * both halves read correctly on their own; it is caught by asserting the two lists against each
 * other, which is what `care.test.ts` now does.
 */
// Exported for the test only, so fast refresh loses this file — the same trade every provider here
// makes for its hook. Moving it out would drag `SheetShape`, `ChoiceRow` and `SWATCHES` with it,
// which is a lot of churn to buy back a dev-server nicety on a file that rarely changes.
// eslint-disable-next-line react-refresh/only-export-components
export const SHAPES: Partial<Record<CareEntryTypeName, SheetShape>> = {
  Bottle: {
    // Offered, left, and the consumed figure the panel works out between them.
    bottle: true,
    choices: [{
      /*
       * Six — `design_handoff_baby/README.md` §7, which fills the grid to two clean rows of three.
       *
       * <b>`breast_formula` is the bottle that is some of each.</b> It is a value in its own right
       * and not a note on one of the others: a household topping breast milk up with formula was
       * previously choosing whichever it felt was the larger half, which makes the log say a thing
       * that did not happen. It is ours rather than the vendor's — no upstream enum has it — which
       * is fine, because `CareEntry.Kind` is free text and this panel keeps its own record.
       *
       * `soy_milk` and `tube_feeding` are still not offered: neither is anything this household
       * gives, and on a panel whose whole argument is that the common case should need no
       * adjustment, two dead chips are two more things to read past at 3am.
       *
       * Only the *offer* is this list. `kindLabel` renders whatever a row carries, so anything
       * already logged keeps reading correctly wherever it appears.
       */
      label: 'Contents', note: 'Six values', field: 'kind', columns: 3,
      values: ['formula', 'breast_milk', 'breast_formula', 'cow_milk', 'goat_milk', 'other'],
    }],
  },
  Diaper: {
    // POTTY swaps the four kinds for the three a potty has. The mode is not stored — the kind is.
    mode: {
      values: ['diaper', 'potty'],
      swaps: 'kind',
      then: { diaper: ['pee', 'poo', 'both', 'dry'], potty: ['sat_but_dry', 'potty', 'accident'] },
    },
    choices: [
      { label: 'Kind', field: 'kind', columns: 4, values: ['pee', 'poo', 'both', 'dry'] },
      { label: 'Amount', field: 'size', columns: 3, values: ['little', 'medium', 'big'] },
      { label: 'Colour', field: 'color', columns: 6, swatches: true, values: Object.keys(SWATCHES) },
      {
        label: 'Consistency', field: 'consistency', columns: 4,
        values: ['solid', 'loose', 'runny', 'mucousy', 'hard', 'pebbles', 'diarrhea'],
      },
    ],
  },
  Nursing: {
    timer: true,
    measure: {
      label: 'Or type one you finished', unit: 'min', caption: 'Minutes',
      step: 1, quick: [5, 8, 12, 20], columns: 4,
    },
    choices: [{ label: 'Side', field: 'side', columns: 3, align: 'right', values: ['left', 'right', 'both'] }],
  },
  Pump: {
    // Stimulation then expression. Set before starting, because they decide when the session
    // switches and when it chimes — the server needs both at start time, not at completion.
    phases: true,
    // The second route: a session that is already over, where the amount is in hand. See `typed`.
    typed: true,
    measure: {
      label: 'Amount', unit: 'oz', caption: 'Ounces', note: 'Optional',
      step: 0.5, quick: [2, 4, 8, 11.5], columns: 5,
    },
    optionalAmount: true,
  },
  Medicine: {
    medicines: true,
    // Millilitres only, and no unit toggle: doses are a property of the medicine, and the list
    // above supplies them.
    measure: {
      label: 'Dose', unit: 'ml', caption: 'ML', note: 'Millilitres',
      // The two doses this household actually gives lead the row; the design's `0.3` was a value
      // from its own fixture and nothing here is given at it.
      step: 0.05, quick: [0.6, 0.25, 1, 1.25], columns: 4,
    },
  },
  Solids: {
    measure: { label: 'Amount', unit: 'tsp', caption: 'Teaspoons', step: 1, quick: [1, 2, 4], columns: 4 },
  },
  TummyTime: {
    stopwatch: true,
    // `Or type one you finished`, as nursing words it: the timer is the way in, and the stepper is
    // there for the session somebody has already done and is writing up afterwards.
    measure: {
      label: 'Or type one you finished', unit: 'min', caption: 'Minutes',
      step: 1, quick: [3, 5, 10, 15], columns: 4,
    },
  },
  Temperature: {
    measure: { label: 'Reading', unit: 'f', caption: 'Degrees', step: 0.1, quick: [97.5, 98.6, 99.5, 100.4], columns: 4 },
  },
  Sleep: {
    /*
     * The timer this tile has claimed to have all along.
     *
     * `Sleep` has been in `TIMED_TYPES` since the log was built and its caption has read `TIMER`,
     * but the panel carried neither of the two start affordances that existed — nursing's side
     * tiles or pump's phase button — and `openingAmount` prefills the stepper from the last
     * session, so `durationMinutes` was never null and the start-a-session branch in `CareLogView`
     * could not be reached. Pressing SAVE wrote a row. The capability was advertised on the tile
     * and absent from the sheet; the plain one-button start added for tummy time is exactly what it
     * was missing.
     */
    stopwatch: true,
    measure: {
      label: 'Or type one you finished', unit: 'min', caption: 'Minutes',
      step: 5, quick: [20, 45, 60, 90], columns: 4,
    },
  },
  Bath: {},
}

/** One medicine the household has given before, as the WHAT list offers it. */
export interface KnownMedicine {
  name: string
  amount: number | null
  unit: string | null
}

interface Props {
  type: CareEntryTypeName
  last: CareEntryDto | undefined
  /**
   * An existing entry being corrected, rather than a new one being written.
   *
   * The whole panel seeds from this instead of from `last` when it is set. Same fields, same review
   * line, same SAVE — what changes is that SAVE updates a row rather than appending one.
   */
  editing?: CareEntryDto | null
  /** What has been given before, newest first. Medicine only. */
  medicines?: KnownMedicine[]
  saving: boolean
  /** The name in the title block's right-hand label. */
  childName?: string
  onSave: (input: CareEntryInput) => void
  /** Begin a session rather than write an entry — the nursing tiles and pump's START SESSION. */
  onStart?: (opts: { side?: string; phaseOne?: number; phaseTwo?: number }) => void
  onCancel: () => void
}

/**
 * One logging panel, pre-filled from the last entry of its kind.
 *
 * <b>The review line is the confirmation.</b> There is no hold and no second dialogue — those were
 * the old integration's answer to writes that could never be taken back, and this log can be
 * corrected and deleted, so a plain SAVE under a sentence stating exactly what will be written is
 * both safer and faster.
 */
export function CareSheet({
  type, last, editing, medicines = [], saving, childName, onSave, onStart, onCancel,
}: Props) {
  const shape = SHAPES[type] ?? {}
  const seed = editing ?? last

  // Stimulation, then expression. The design remembers these per person; until that is stored they
  // open on the defaults, which is what the tile caption promises.
  const [phaseOne, setPhaseOne] = useState(PUMP_PHASES[0])
  const [phaseTwo, setPhaseTwo] = useState(PUMP_PHASES[1])

  /*
   * The medicine the panel opens on: the one last given, or the household's first.
   *
   * Opening on nothing would mean choosing a name *and* dialling a dose before SAVE meant anything,
   * which is two decisions for the commonest possible entry. Opening on a medicine makes the
   * ordinary case a single tap, and the dose comes with it.
   */
  const openMed = shape.medicines
    ? medicines.find((m) => m.name === seed?.kind) ?? medicines[0] ?? null
    : null

  /** What this panel's stepper measures: minutes for a session, otherwise the entry's own amount. */
  const isDuration = shape.measure?.unit === 'min'

  const [amount, setAmount] = useState<number | null>(() => {
    /*
     * The figure the stepper moves, which is not always the one an entry leads with.
     *
     * <b>This read `amount ?? durationMinutes`, and on a pump the two are different facts.</b> A
     * completed pump session carries its minutes and, until it is measured, no amount at all — so
     * correcting one opened the OUNCES stepper on the twenty *minutes* it ran, and saving wrote
     * twenty ounces and erased the duration. The one entry somebody opens specifically to add an
     * amount to was the one that could not survive being opened.
     *
     * The unit decides. A panel that measures minutes edits the duration; every other panel edits
     * the amount, and neither falls back to the other.
     */
    if (editing) return (isDuration ? editing.durationMinutes : editing.amount) ?? null
    if (openMed) return last?.amount ?? openMed.amount
    return openingAmount(type, last, shape)
  })
  const [choices, setChoices] = useState<Partial<Record<ChoiceField, string | null>>>(() => ({
    kind: seed?.kind ?? openMed?.name ?? null,
    size: seed?.pooAmount ?? seed?.peeAmount ?? null,
    color: editing?.color ?? null,
    consistency: editing?.consistency ?? null,
    // Correcting a session keeps its side; a new one offers the opposite of last time.
    side: shape.timer ? (editing ? editing.side : otherSide(last?.side) ?? 'left') : null,
  }))
  const [mode, setMode] = useState<string>(() => (shape.mode ? shape.mode.values[0] : ''))
  /*
   * How long the typed session ran.
   *
   * Opens on the phases' own sum, which is the length a session started from this panel would have
   * run — the household types up a session it has just done, and that is the answer more often than
   * any other. A correction opens on what the entry actually measured.
   */
  const [length, setLength] = useState<number>(
    () => Math.max(1, Math.round(editing?.durationMinutes ?? PUMP_PHASES[0] + PUMP_PHASES[1])),
  )
  /*
   * What went in, and what came back.
   *
   * <b>A correction opens on what was entered, now that both ends are stored.</b> Only the
   * difference used to be — so reopening a feed put the *consumed* figure in OFFERED and left
   * REMAINING empty, which says a full bottle came back untouched. Somebody correcting a feed
   * because the baby took more then adjusted the wrong end of the sum, and how big the bottle had
   * been was gone for good.
   *
   * <b>A bottle logged before the columns existed still has only the difference</b>, and it falls
   * back to exactly the old behaviour: the taken amount in OFFERED, nothing remaining. That is not
   * a good reading, but it is the honest one — those rows never recorded what was poured, and the
   * alternative is inventing a bottle size. It corrects itself the first time such an entry is
   * saved, which is what somebody opening it is about to do.
   *
   * A new entry opens on the last feed's amount, which is likewise the last *taken* rather than the
   * last offered — close enough to be a useful default. `left` opens at none: a bottle that went
   * back empty is the common case, and defaulting to anything else would put a subtraction in front
   * of every clean feed.
   */
  const [offered, setOffered] = useState<number | null>(
    () => (editing ? editing.offered ?? editing.amount : last?.amount ?? 3.5),
  )
  const [left, setLeft] = useState<number | null>(() => editing?.left ?? null)
  const consumed = offered == null ? null : Math.max(0, Math.round((offered - (left ?? 0)) * 100) / 100)
  /* How much of the bottle the gauge fills. Nothing offered is nothing to divide by — an empty bar
     rather than a full one, which would read as a bottle drained. */
  const consumedShare = offered && offered > 0 && consumed != null
    ? Math.max(0, Math.min(1, consumed / offered))
    : 0
  const [rash, setRash] = useState(() => editing?.diaperRash ?? false)

  const [at, setAt] = useState<Date>(() => (editing ? new Date(editing.atUtc) : new Date()))
  /** True once a time has been set by hand, so back-dating stops overwriting it. */
  const [timeSet, setTimeSet] = useState(() => Boolean(editing))

  const [picking, setPicking] = useState(false)
  const when = useWhenDraft()

  /*
   * A medicine the list has never seen.
   *
   * `custom` is derived rather than stored: whatever is chosen is either one of the known names or
   * it is not, and keeping a second copy of that fact is how the row and the entry drift apart when
   * an edit opens on a name typed weeks ago.
   */
  const [typing, setTyping] = useState<string | null>(null)
  const custom = choices.kind && !medicines.some((m) => m.name === choices.kind) ? choices.kind : null

  const commitCustom = () => {
    if (typing === null) return
    const name = typing.trim()
    setTyping(null)
    // Emptying the field clears the choice rather than writing a blank name onto the entry.
    setChoices((c) => ({ ...c, kind: name || null }))
  }

  /*
   * A typed duration back-dates the start.
   *
   * The nursing panel's time row says `Started`, not `When`: what is being recorded is a session
   * that ran for eight minutes and therefore began eight minutes ago. Typing the duration and then
   * having to set the start by hand would be asking for the same fact twice.
   */
  const startedAt = useMemo(() => {
    // Nursing back-dates by the typed duration; the pump's typed route by its length row. Both are
    // "a session that ran this long and therefore began that long ago".
    const ran = shape.timer ? amount : shape.typed ? length : null
    if (timeSet || ran == null) return at
    return new Date(Date.now() - ran * 60_000)
  }, [timeSet, shape.timer, shape.typed, amount, length, at])

  const input = useMemo<CareEntryInput>(() => {
    const measured = shape.measure
    const size = choices.size ?? null
    // A wet diaper's size belongs in `peeAmount`; everything else that has one is the poo. `dry`
    // takes neither — there was nothing to be little or big.
    const wet = choices.kind === 'pee'
    return {
      type,
      atUtc: startedAt.toISOString(),
      // A bottle writes what was consumed. Offered and left ride along for the day they are stored.
      amount: shape.bottle ? consumed : isDuration ? null : amount,
      offered: shape.bottle ? offered : null,
      left: shape.bottle ? left : null,
      unit: shape.bottle ? 'oz' : isDuration ? null : (measured?.unit ?? null),
      /*
       * A correction keeps the minutes it is not editing.
       *
       * Only a panel that measures minutes writes them. Everything else sent a null here, which on
       * a new entry is correct — nothing timed it — and on a *correction* threw away the duration
       * the session had measured. Adding an ounce figure to a finished pump is exactly that case.
       */
      durationMinutes: isDuration ? amount : shape.typed ? length : editing?.durationMinutes ?? null,
      kind: choices.kind ?? null,
      side: choices.side ?? null,
      peeAmount: wet ? size : null,
      pooAmount: wet || choices.kind === 'dry' ? null : size,
      color: choices.color ?? null,
      consistency: choices.consistency ?? null,
      diaperRash: type === 'Diaper' ? rash : null,
    }
  }, [type, startedAt, amount, choices, rash, shape.measure, shape.bottle, shape.typed, offered,
    left, consumed, isDuration, length, editing])

  const step = (delta: number) => setAmount((cur) => {
    const next = Math.round(((cur ?? 0) + delta) * 100) / 100
    return next <= 0 ? null : next
  })

  const pick = (field: ChoiceField, value: string) =>
    // Tapping the chosen value again clears it — an optional field must be un-fillable, or a
    // mis-tap becomes permanent.
    setChoices((c) => ({ ...c, [field]: c[field] === value ? null : value }))

  const rows = shape.choices ?? []
  const kindRow = shape.mode ? rows.find((r) => r.field === shape.mode!.swaps) : undefined

  const title = picking ? 'When' : careTitle(type)
  /*
   * `Scrolls inside` is gone with the scrolling it announced.
   *
   * It was an honest warning while the diaper panel genuinely ran past its own height — the one
   * panel where a field could be below the fold, on the one label slot every other panel uses for
   * whose entry this is. Now that the rows are packed to fit (`--dense`), it announced a behaviour
   * that no longer happens, and CONRAD is the more useful thing to have there.
   */
  const label = picking ? callerLabel(type, input)
    : editing ? 'Editing'
    : childName?.toUpperCase()

  return (
    <CarePanel
      title={title}
      label={label}
      last={
        picking ? <>Default · now, {clockLabel(new Date())}</>
        : editing ? <>Logged {clockLabel(new Date(editing.atUtc))} · saving replaces it</>
        : lastLine(last)
      }
      dense={type === 'Diaper'}
      onClose={onCancel}
      footer={
        picking ? (
          <WhenPickerFoot
            note={`Sets the time on this ${careTitle(type).toLowerCase()}. Nothing is written yet.`}
            draft={when}
            onBack={() => setPicking(false)}
            onSet={() => { setAt(when.at); setTimeSet(true); setPicking(false) }}
          />
        ) : (
          <>
            <p className="ml-carepanel__review">{reviewSentence(input, startedAt)}</p>
            <button
              type="button"
              className="ml-carepanel__save"
              onClick={() => onSave(input)}
              disabled={saving}
            >
              Save
            </button>
          </>
        )
      }
    >
      {picking ? <WhenPickerBody draft={when} /> : (
        <>
          {/* DIAPER / POTTY. The mode is not stored — it decides which kinds are on offer. */}
          {shape.mode && (
            <div className="ml-caresheet__grid" style={cols(shape.mode.values.length)}>
              {shape.mode.values.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={'ml-carechip' + (mode === m ? ' ml-carechip--on' : '')}
                  onClick={() => { setMode(m); setChoices((c) => ({ ...c, kind: null })) }}
                >
                  {m}
                </button>
              ))}
            </div>
          )}

          {/* SESSION — the two phases, then the button that begins them. */}
          {shape.phases && !editing && (
            <>
              <Label label="Session" note={`${phaseOne + phaseTwo} min in two phases`} />
              <PhaseRow
                name="Stimulation" which="Phase one"
                value={phaseOne} onChange={(v) => setPhaseOne(Math.max(1, v ?? 1))}
              />
              <PhaseRow
                name="Expression" which="Phase two"
                value={phaseTwo} onChange={(v) => setPhaseTwo(Math.max(1, v ?? 1))}
              />
              <button
                type="button"
                className="ml-caresheet__begin"
                onClick={() => onStart?.({ phaseOne, phaseTwo })}
                disabled={saving}
              >
                <span className="ml-caresheet__beginlabel">Start session</span>
                {/* Load-bearing, in the handoff's own words: it says the amount is coming later, so
                    an empty amount reads as a question not yet asked rather than a field skipped. */}
                <span className="ml-caresheet__beginnote">No amount yet</span>
              </button>
            </>
          )}

          {/*
            A session with nothing to configure: one button, which begins it.

            Above the stepper for the same reason nursing's tiles are — starting is the ordinary
            case and typing a finished session is the exception, so the panel should open on the
            thing most people came to press. A start writes nothing; the entry appears on COMPLETE.
          */}
          {shape.stopwatch && !editing && (
            <>
              <Label label="Start a timer" note="Ends when you complete it" />
              <button
                type="button"
                className="ml-caresheet__begin"
                onClick={() => onStart?.({})}
                disabled={saving}
              >
                <span className="ml-caresheet__beginlabel">Start {careTitle(type).toLowerCase()}</span>
                <span className="ml-caresheet__beginnote">Counts up until you stop it</span>
              </button>
            </>
          )}

          {/* Nursing's two routes: start a timer, or type one that already finished. */}
          {shape.timer && !editing && (
            <>
              <Label label="Start a timer" note={`${choices.side ?? 'left'} is next`} />
              <div className="ml-caresheet__starts">
                {['left', 'right'].map((side) => {
                  const next = (choices.side ?? 'left') === side
                  return (
                    <button
                      key={side}
                      type="button"
                      className={'ml-caresheet__start' + (next ? ' ml-caresheet__start--primary' : '')}
                      // A start writes nothing — it opens a session, which becomes an entry only on
                      // COMPLETE.
                      onClick={() => onStart?.({ side })}
                    >
                      {/* The side that was used last is tagged, so the offered one is a suggestion
                          rather than an unexplained default. */}
                      {last?.side === side && <span className="ml-caresheet__tag">Last side</span>}
                      <span className="ml-caresheet__play" aria-hidden="true">▶</span>
                      <span className="ml-caresheet__startname">{side}</span>
                    </button>
                  )
                })}
              </div>
            </>
          )}

          {/*
            WHAT — the medicines given before, then anything else.

            <b>Every row is the same row.</b> The last one given used to be a bordered card and the
            rest plain lines, which made one option look like a different kind of thing rather than
            like the one currently chosen. Selection is carried by the fill and the brass, so it
            still reads at a glance without a box drawn round a single entry.
          */}
          {shape.medicines && (
            /*
              No WHAT heading over the list.

              The rows are medicine names with their doses beside them, on the one panel reached by
              tapping MEDICINE — there is no question about what they are, and a word in brass small
              caps asking it was answering nobody. `From last entry` went with it: the ordering
              already says so (what was given most recently leads), and the note claimed the whole
              list was carried over when only the first row is.

              The margin the heading used to contribute moves onto the list itself, so the section
              still sits apart from the dose above it.
            */
            <div className="ml-caresheet__meds">
              {medicines.map((med) => (
                <button
                  key={med.name}
                  type="button"
                  className={'ml-caresheet__med' + (choices.kind === med.name ? ' ml-caresheet__med--on' : '')}
                  onClick={() => {
                    setChoices((c) => ({ ...c, kind: med.name }))
                    if (med.amount != null) setAmount(med.amount)
                  }}
                >
                  <span className="ml-caresheet__medname">{med.name}</span>
                  <span className="ml-caresheet__meddose">
                    {med.amount != null ? `${med.amount} ${med.unit ?? 'ml'}` : ''}
                  </span>
                </button>
              ))}

              {/* Anything the household has not given before. A last resort, but a reachable one —
                  it was inert, so the first dose of anything new could not be logged at all. */}
              {typing === null ? (
                <button
                  type="button"
                  className={'ml-caresheet__med' + (custom ? ' ml-caresheet__med--on' : '')}
                  onClick={() => setTyping(custom ?? '')}
                >
                  <span className={'ml-caresheet__medname' + (custom ? '' : ' ml-caresheet__medname--none')}>
                    {custom ?? 'Something else'}
                  </span>
                  <span className="ml-caresheet__meddose">{custom ? 'Change ▸' : 'Type ▸'}</span>
                </button>
              ) : (
                <div className="ml-caresheet__med">
                  <input
                    className="ml-caresheet__medinput"
                    autoFocus
                    value={typing}
                    maxLength={40}
                    placeholder="Name it"
                    aria-label="Which medicine"
                    onChange={(e) => setTyping(e.target.value)}
                    onBlur={commitCustom}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitCustom()
                      if (e.key === 'Escape') setTyping(null)
                    }}
                  />
                </div>
              )}
            </div>
          )}

          {/*
            Both ends of a feed, and the subtraction between them.

            TAKEN is not a control — it is a strip, and the only verdigris numeral on the panel,
            because it is the only figure being written. Offered and left are the panel's arithmetic.
          */}
          {shape.bottle && (
            <>
              {/*
                The bottle itself — option 1B, the one the exploration locked in.

                <b>Consumed is read off the bottle rather than stated twice.</b> The earlier layout
                put two full steppers above a strip that repeated the subtraction in words; this
                draws the bottle: a bar the length of what was offered, filled to what was taken,
                the remainder standing for what came back. The figure leads because it is the only
                one written to the log, and it is the only verdigris on the panel for the same
                reason. The two steppers become compact rows beneath, each labelled with the figure
                it moves.
              */}
              <div className="ml-bottle__hero">
                <span className="ml-bottle__consumed">
                  <span className="serif">{consumed ?? '—'}</span>
                  <span className="ml-bottle__consumedlabel">oz consumed</span>
                </span>
                <span className="ml-bottle__of">Of {offered ?? 0} offered</span>
              </div>

              {/*
                Proportional to what was offered. A bottle nobody has dialled an amount into has
                nothing to divide, so the gauge stays empty rather than showing a full bar.

                <b>The two ends are modifiers, because a flex share of 0 is not a width of 0.</b>
                `flex: 0` zeroes the basis and lets the item shrink, but padding and borders are not
                shrinkable — so an emptied bottle still reserved the rest's 14px of right padding and
                drew the fill's level marker just inside the gauge, leaving a dark gap and a bright
                line where the bar should simply have ended. Four ounces of four offered read as
                *nearly* all of it, which on the one figure being written is the wrong answer.
                The same in reverse at the other end: an untouched bottle showed a stub of verdigris
                made of nothing but the fill's own padding and border.
              */}
              <div className="ml-bottle__gauge" aria-hidden="true">
                <span
                  className={'ml-bottle__fill'
                    + (consumedShare >= 1 ? ' ml-bottle__fill--full' : '')
                    + (consumedShare <= 0 ? ' ml-bottle__fill--none' : '')}
                  style={{ flex: consumedShare }}
                >
                  {consumedShare > 0.28 && <span className="ml-bottle__fillword">Consumed</span>}
                </span>
                <span
                  className={'ml-bottle__rest' + (consumedShare >= 1 ? ' ml-bottle__rest--none' : '')}
                  style={{ flex: 1 - consumedShare }}
                >
                  {left != null && left > 0 && 1 - consumedShare > 0.22 && (
                    <span className="ml-bottle__restword">{left} remaining</span>
                  )}
                </span>
              </div>

              <BottleRow
                label="Offered"
                note="Ounces"
                value={offered}
                onStep={(d) => setOffered(bump(offered, d))}
              />
              <BottleRow
                label="Remaining"
                note="None unless set"
                value={left}
                ruled
                onStep={(d) => setLeft(bump(left, d))}
              />
            </>
          )}

          {/*
            OR LOG ONE YOU FINISHED — the pump's second route.

            <b>The one place on this panel where an amount may be typed, because here the session is
            already over.</b> A session started from the button above carries no amount and cannot
            be given one until it ends; this route is for the pump done away from the panel, where
            the figure is in hand before anybody opens the app. The two routes sit under separate
            labels, and the review line names which one SAVE belongs to.

            Two compact rows in the phases' own form rather than the full-height stepper: the
            stepper is the shape of a panel that is *asking* for a measurement, and asking is what
            this panel must not do until the session has run.
          */}
          {shape.typed && shape.measure && (
            <>
              <Label label="Or log one you finished" note="Amount known" />
              <PhaseRow
                name="Length" which="Minutes" unit="min"
                value={length} onChange={(v) => setLength(Math.max(1, v ?? 1))}
              />
              <PhaseRow
                name="Amount" which={`${shape.measure.unit} · blank if not measured`}
                unit={shape.measure.unit} step={shape.measure.step}
                value={amount} onChange={setAmount}
              />
            </>
          )}

          {shape.measure && !shape.typed && (
            <>
              <Label label={shape.measure.label} note={shape.measure.note} />
              <div className="ml-caresheet__stepper">
                {/* Named for assistive tech, which otherwise announces a bare minus sign. The same
                    labelling the bottle's pair carries. */}
                <button
                  type="button"
                  className="ml-caresheet__step"
                  onClick={() => step(-shape.measure!.step)}
                  disabled={amount == null}
                  aria-label={`Less ${shape.measure.label.toLowerCase()}`}
                >
                  −
                </button>
                <span className="ml-caresheet__value">
                  {/* An em dash, not a zero: nothing was measured, and a zero would state a
                      measurement nobody took. */}
                  <span className="serif">{amount ?? '—'}</span>
                  <span className="ml-caresheet__unit">
                    {amount == null ? 'Not measured' : shape.measure.caption}
                  </span>
                </span>
                <button
                  type="button"
                  className="ml-caresheet__step"
                  onClick={() => step(shape.measure!.step)}
                  aria-label={`More ${shape.measure.label.toLowerCase()}`}
                >
                  +
                </button>
              </div>
              <div className="ml-caresheet__grid" style={cols(shape.measure.columns)}>
                {shape.optionalAmount && (
                  <button
                    type="button"
                    className={'ml-carechip' + (amount === null ? ' ml-carechip--on' : '')}
                    onClick={() => setAmount(null)}
                  >
                    None
                  </button>
                )}
                {shape.measure.quick.map((q) => (
                  <button
                    key={q}
                    type="button"
                    className={'ml-carechip' + (amount === q ? ' ml-carechip--on' : '')}
                    onClick={() => setAmount(q)}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </>
          )}

          {rows.map((row) => {
            const values = row === kindRow && shape.mode ? shape.mode.then[mode] : row.values
            return (
              <div key={row.label}>
                <Label label={row.label} note={row.note} />
                <div
                  className={
                    'ml-caresheet__grid'
                    + (row.swatches ? ' ml-caresheet__grid--swatches' : '')
                    + (row.align === 'right' ? ' ml-caresheet__grid--right' : '')
                  }
                  style={cols(row.columns)}
                >
                  {values.map((v) => (row.swatches ? (
                    <button
                      key={v}
                      type="button"
                      className={'ml-caresheet__swatch' + (choices[row.field] === v ? ' ml-caresheet__swatch--on' : '')}
                      onClick={() => pick(row.field, v)}
                    >
                      {/* The block *is* the value. Its fill never changes — the frame is the
                          selection — because a swatch that recolours to say "chosen" has stopped
                          reporting the colour it was put there to report. */}
                      <span className="ml-caresheet__block" style={{ background: SWATCHES[v] }} aria-hidden="true" />
                      <span className="ml-caresheet__swatchname">{v}</span>
                    </button>
                  ) : (
                    <button
                      key={v}
                      type="button"
                      className={'ml-carechip' + (choices[row.field] === v ? ' ml-carechip--on' : '')}
                      onClick={() => pick(row.field, v)}
                    >
                      {word(v)}
                    </button>
                  )))}
                </div>
              </div>
            )
          })}

          {type === 'Diaper' && (
            <button
              type="button"
              className={'ml-caresheet__toggle' + (rash ? ' ml-caresheet__toggle--on' : '')}
              onClick={() => setRash((r) => !r)}
              aria-pressed={rash}
            >
              <span>Diaper rash</span>
              <span className="ml-caresheet__track" aria-hidden="true"><span className="ml-caresheet__knob" /></span>
            </button>
          )}

          {/* When — buildable at last. Every write on the old path logged at the moment of the call,
              so this row had nothing behind it until the log became HomeHub's own. */}
          <button
            type="button"
            className="ml-caresheet__when"
            onClick={() => { when.open(startedAt); setPicking(true) }}
          >
            <span>
              {/* `Started`, not `When`, on both routes that write a session that already ran — what
                  is being recorded is a length, and a length has a beginning rather than a moment. */}
              {shape.timer || shape.typed ? 'Started' : 'When'}
              <span className="ml-caresheet__note">
                {whenNote(startedAt, timeSet, shape.timer || shape.typed, shape.typed ? length : amount)}
              </span>
            </span>
            <span className="ml-caresheet__whenright">
              <span className="serif ml-caresheet__whenvalue">{clockLabel(startedAt)}</span>
              <span className="ml-caresheet__chev" aria-hidden="true">▸</span>
            </span>
          </button>
        </>
      )}
    </CarePanel>
  )
}

/**
 * A named figure with an inline stepper: the pump's phases, and the typed route's length and amount.
 *
 * <b>One row form for all four, because they are the same control.</b> The phases decide how long a
 * session will run; length and amount say how long one did and how much it gave. Drawing the typed
 * pair as the full-height stepper instead would make them read as the panel's headline measurement,
 * which on a panel whose whole argument is that the amount comes last is the wrong emphasis.
 */
function PhaseRow({
  name, which, value, onChange, min = 1, unit = 'min', step = 1,
}: {
  name: string
  which: string
  /** Null is `—`: not measured, which is a different fact from zero and only the amount has it. */
  value: number | null
  onChange: (value: number | null) => void
  /** A phase of no minutes is not a phase. The callers clamp to this too; this is what shows it. */
  min?: number
  unit?: string
  step?: number
}) {
  /* Stepping below the floor clears the figure rather than pinning it there — an optional amount
     has to be un-fillable, and `—` is what "not measured" looks like everywhere in this log. */
  const bumped = (delta: number) => {
    const next = Math.round(((value ?? 0) + delta) * 100) / 100
    return next < min ? null : next
  }

  return (
    <div className="ml-caresheet__phase">
      <span className="ml-caresheet__phasebody">
        <span className="ml-caresheet__phasename">{name}</span>
        <span className="ml-caresheet__phasewhich">{which}</span>
      </span>
      <span className="ml-caresheet__phasestep">
        {/*
          Dimmed at the floor, where it stops.

          The clamp was already there — `Math.max(1, …)` where the phases are set — but only at the
          call site, so the button fired, was clamped back to where it started, and looked as live
          as ever. That is the third place on this sheet with the same shape of problem, after the
          bottle's pair and the dose stepper: a control that refuses without saying it is refusing.

          The amount row has one more step below the floor than the phases do — down to `—`, which
          is a value in its own right — so it goes dim only once it is already there.
        */}
        <button
          type="button"
          className="ml-caresheet__phasebtn"
          onClick={() => onChange(bumped(-step))}
          disabled={value == null}
          aria-label={`Shorten ${name.toLowerCase()}`}
        >
          −
        </button>
        <span className="ml-caresheet__phasevalue">
          <span className={'serif' + (value == null ? ' ml-caresheet__phasenone' : '')}>{value ?? '—'}</span>
          {/* The unit is dropped with the figure: `— MIN` reads as a measurement of nothing. */}
          {value != null && <span className="ml-caresheet__phaseunit">{unit}</span>}
        </span>
        <button
          type="button"
          className="ml-caresheet__phasebtn"
          onClick={() => onChange(Math.round(((value ?? 0) + step) * 100) / 100)}
          aria-label={`Lengthen ${name.toLowerCase()}`}
        >
          +
        </button>
      </span>
    </div>
  )
}

/** A section label with its optional right-hand note. */
function Label({ label, note }: { label: string; note?: string }) {
  return (
    <div className="ml-caresheet__label">
      {label}
      {note && <span className="ml-caresheet__note">{note}</span>}
    </div>
  )
}

/**
 * One bottle figure: what it is, and the pair of buttons that move it.
 *
 * Compact rows rather than the full-width stepper the amount used to get — the bar above is now
 * carrying the reading, so these are adjustments to it rather than the headline.
 */
function BottleRow({ label, note, value, ruled, onStep }: {
  label: string
  note: string
  value: number | null
  /** A rule above, separating the second figure from the first. */
  ruled?: boolean
  onStep: (delta: number) => void
}) {
  return (
    <div className={'ml-bottle__row' + (ruled ? ' ml-bottle__row--ruled' : '')}>
      <span className="ml-bottle__rowbody">
        <span className="ml-bottle__rowlabel">{label}</span>
        <span className="ml-bottle__rownote">{note}</span>
      </span>
      <span className="ml-bottle__set">
        {/*
          The minus goes dim at the floor rather than staying lit and doing nothing.

          `bump` stops at nothing — a bottle cannot hold less than none — so once the figure reads
          `—` the button is inert. Leaving it looking pressable is a small lie the panel tells
          repeatedly: somebody dialling a bottle down past zero at 3am gets no movement and no
          reason, and the natural read is that the panel has stopped responding rather than that it
          has reached the end. `disabled` also takes it out of the tab order, so it is not offered
          to a keyboard or a screen reader as something to do either.

          Note the floor is *below* the last real value: at 0.25 the minus still works, because it
          has somewhere to go — 0.25 less is "not set", which is a different fact from 0.25.
        */}
        <button
          type="button"
          className="ml-bottle__step"
          onClick={() => onStep(-0.25)}
          disabled={value == null}
          aria-label={`Less ${label.toLowerCase()}`}
        >
          −
        </button>
        <span className="ml-bottle__value serif">{value ?? '—'}</span>
        <button
          type="button"
          className="ml-bottle__step"
          onClick={() => onStep(0.25)}
          aria-label={`More ${label.toLowerCase()}`}
        >
          +
        </button>
      </span>
    </div>
  )
}

/** Both bottle steppers move in 0.25, and neither goes below nothing. */
function bump(value: number | null, delta: number): number | null {
  const next = Math.round(((value ?? 0) + delta) * 100) / 100
  return next <= 0 ? null : next
}

/** The grid column count, as a custom property the stylesheet reads. */
function cols(n: number): React.CSSProperties {
  return { '--cols': n } as React.CSSProperties
}

/**
 * A chip's face — `breast_milk` → `breast milk`, `breast_formula` → `breast / formula`.
 *
 * <b>Deferred to `kindLabel` rather than re-implementing it.</b> This held its own copy of the
 * `both` → `mixed` rule, which is the two-vocabularies problem the log warns about elsewhere: the
 * sheet and the row beside it were one edit away from disagreeing about the same value, and the
 * sixth bottle content was the edit that would have done it. The chip is uppercased by CSS, so the
 * capitalisation `kindLabel` applies is thrown away here and only the wording is kept.
 */
function word(value: string): string {
  return (kindLabel(value) ?? value).toLowerCase()
}

/** `NOW — TAP TO CHANGE`, or what the row actually says once it is not now. */
function whenNote(at: Date, timeSet: boolean, timer?: boolean, minutes?: number | null): string {
  if (!timeSet && timer && minutes != null) return `${minutes} minutes before now`
  const drift = at.getTime() - Date.now()
  if (Math.abs(drift) < 60_000) return 'Now — tap to change'
  // `elapsedLabel` floors at zero, so a time ahead of now would read `0M ago` — the one thing this
  // row must not say about a timestamp somebody deliberately moved.
  if (drift > 0) return 'Ahead of now — tap to change'
  return `${elapsedLabel(at.toISOString()).value} ago — tap to change`
}

/** `LAST · 3.5 OZ BREAST MILK · 34M AGO` — the line under the title. */
function lastLine(last: CareEntryDto | undefined) {
  if (!last) return null
  // An em dash is right in a numeral column and wrong in a sentence: `LAST · — · 2H AGO` reads as
  // a value that failed to load. In words, "no amount" is the fact.
  const measured = valueLabel(last) === '—' ? 'No amount' : valueLabel(last)
  const detail = last.type === 'Bottle'
    // Only the consumed figure survives a round trip today, so the line reports that rather than
    // claiming an offered amount it cannot know.
    ? `${measured} consumed`
    : [measured, last.kind ? word(last.kind) : null].filter(Boolean).join(' ')
  return (
    <>
      Last · <span className="ml-carepanel__lastvalue">{detail}</span>
      {' · '}{elapsedLabel(last.atUtc).value} ago
    </>
  )
}

/**
 * `BOTTLE · 3.5 OZ` — what the picker shows where the child's name normally sits.
 *
 * The picker takes the whole panel over, so without this there is nothing on screen saying which
 * entry the time belongs to, and SET would be applying a time to something invisible.
 */
function callerLabel(type: CareEntryTypeName, input: CareEntryInput): string {
  const value = input.amount != null
    ? `${input.amount} ${input.unit ?? ''}`.trim()
    : input.durationMinutes != null
      ? `${input.durationMinutes} min`
      : input.kind ? word(input.kind) : ''
  return `${CARE_LABELS[type]}${value ? ` · ${value}` : ''}`.toUpperCase()
}

/**
 * What the stepper opens on.
 *
 * The last entry of this kind, because that is what a household repeats — except where the last
 * value would be a lie: a pump amount is usually absent, and opening on the previous session's
 * ounces would invite somebody to save a number they never measured.
 */
function openingAmount(type: CareEntryTypeName, last: CareEntryDto | undefined, shape: SheetShape): number | null {
  if (type === 'Pump') return null
  if (shape.measure?.unit === 'min') return last?.durationMinutes ?? shape.measure.quick[1] ?? null
  return last?.amount ?? shape.measure?.quick[2] ?? null
}
