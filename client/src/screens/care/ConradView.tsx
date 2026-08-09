import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import { EmptyState, HoldButton, LedgerRow, SectionLabel } from '../../components'
import { Icon } from '../../icons/Icon'
import type { IconId } from '../../icons/Icon'
import { useBaby } from '../../app/BabyProvider'
import { useCareSubjects } from '../../app/careSubjects'
import { useNow } from '../../app/useNow'
import type { BabyStateDto, BottleTypeName, DiaperKindName } from '../../api/types'

/** 12-hour throughout Care — `8:35 AM`, never `08:35`. */
function clockTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** Coarse elapsed label for the tile meta lines: `12M AGO`, `3H AGO`, `2D AGO`. */
function since(iso: string | null, now: number): string {
  if (!iso) return 'No record'
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000))
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/**
 * The diaper tiles.
 *
 * All four `DiaperKindName` values, in the designed order. The 2-up grid puts **Wet** and **Dirty**
 * in the first screenful beside the bottle and the nursing timer — which is the four tiles CARE.md
 * draws — and lets `both` and `dry` follow in the same grid rather than being dropped. Losing two
 * of the four kinds would take away the only way to log them, and the design does not ask for that;
 * it asks for those four to be the ones you reach first.
 */
const DIAPERS: { kind: DiaperKindName; label: string }[] = [
  { kind: 'pee', label: 'Wet' },
  { kind: 'poo', label: 'Dirty' },
  { kind: 'both', label: 'Both' },
  { kind: 'dry', label: 'Dry' },
]

/**
 * Conrad — log first.
 *
 * Two upstream facts shape the whole view and neither is visible in the mockups:
 *
 * - **Every write is irreversible.** Huckleberry exposes no delete or edit service, so a mis-tap
 *   here cannot be undone by HomeHub — only in the app. That rules out the designed one-tap tiles
 *   and their 3-second undo toast; the tiles hold to confirm instead, and the section status says so
 *   out loud. `HOLD TO CONFIRM — NO UNDO` is not decoration.
 * - **Writes never queue.** A failed write fails visibly and stays failed, rather than being
 *   retried later against a system of record that can't delete a duplicate.
 *
 * There is also no retroactive logging upstream, so nothing here offers a time field: bottles and
 * diapers log *now*. Only the nursing timer carries a time basis.
 *
 * Rendered inside `CareScreen`'s frame — no shell, no header, no sync line of its own.
 */
export function ConradView() {
  const navigate = useNavigate()
  const { health, state, loading, error, writing, logBottle, logDiaper, timer, clearError } = useBaby()
  const { subjects } = useCareSubjects()
  const now = useNow(30_000)

  const mika = subjects.find((s) => s.id === 'mika')

  if (!loading && health && !health.configured) {
    return (
      <EmptyState
        label="Not connected"
        hint="Huckleberry reaches the panel through Home Assistant. Connect it in Config → Devices to log feeds and diapers here."
      />
    )
  }

  const controlsLive = health?.status === 'Ok' || health?.status === 'Stale'
  // The last bottle is the sensible default for another one — Huckleberry carries the amount and
  // the contents, and repeating them is the common case at 3am.
  const lastAmount = state?.bottleAmount ?? null
  /**
   * The unit of the last bottle, or null when Huckleberry didn't say.
   *
   * Deliberately *not* defaulted. `bottleUnit` comes straight from an HA attribute that is nullable
   * and unverified upstream, and the old `?? 'oz'` turned "unknown" into a specific claim: a 120 ml
   * bottle with no unit attribute displayed as "120 oz", and repeating it wrote a ~3.5 L feed that
   * HomeHub has no way to delete. On a log whose own label says entries can't be undone, guessing
   * the unit is the one thing this view must not do.
   */
  const lastUnits: 'ml' | 'oz' | null =
    state?.bottleUnit?.toLowerCase() === 'ml' ? 'ml'
    : state?.bottleUnit?.toLowerCase() === 'oz' ? 'oz'
    : null
  const canRepeatBottle = lastAmount != null && lastUnits != null
  const lastType = (state?.bottleType ?? '').toLowerCase().replace(/\s+/g, '_') as BottleTypeName
  const side = suggestedSide(state)

  return (
    <>
      {health?.detail && (health.status === 'HomeAssistantUnreachable' || health.status === 'IntegrationMissing') && (
        <div className="ml-baby__detail">{health.detail}</div>
      )}

      {error && (
        <div className="ml-baby__error" role="alert">
          <span className="ml-baby__errortext">{error}</span>
          <button type="button" className="ml-linkbtn" onClick={clearError}>Dismiss</button>
        </div>
      )}

      {state?.nursingRunning && <NursingBand state={state} writing={writing} onAction={timer} />}

      <SectionLabel
        label="Log"
        status={<span className="ml-care__warnstatus">Hold to confirm — no undo</span>}
      />
      <div className="ml-caretiles">
        <CareTile
          glyph="ico-bottle"
          name="Bottle again"
          disabled={!controlsLive || writing || !canRepeatBottle}
          // Brass when the meta is a *suggestion* to repeat, muted when it is merely a record, ghost
          // when there is nothing to repeat (CARE.md).
          tone={canRepeatBottle ? 'suggestion' : lastAmount == null ? 'none' : 'record'}
          meta={
            lastAmount == null
              ? 'No previous bottle to repeat'
              : lastUnits == null
                // Says what is wrong rather than showing a number with a unit nobody verified.
                ? 'Last bottle has no unit recorded — log it in Huckleberry'
                : `${lastAmount} ${lastUnits} · ${since(state?.lastBottleUtc ?? null, now)}`
          }
          onHold={() => {
            // Narrowed on the values themselves, not `canRepeatBottle` — the compiler has to see
            // that neither is null here, and that is the whole point of the guard.
            if (lastAmount != null && lastUnits != null) {
              void logBottle({ amount: lastAmount, type: lastType || 'formula', units: lastUnits })
            }
          }}
        />

        {DIAPERS.slice(0, 1).map((d) => (
          <DiaperTile key={d.kind} kind={d.kind} label={d.label} state={state} now={now}
            disabled={!controlsLive || writing} onHold={() => void logDiaper({ kind: d.kind })} />
        ))}

        {/* The nursing tile is replaced by the running band above, not disabled beside it — two
            controls for one timer is how you end up with two sessions. */}
        {!state?.nursingRunning && (
          <CareTile
            glyph="ico-nursing"
            name={`Nurse ${side}`}
            disabled={!controlsLive || writing}
            tone={state?.lastNursingUtc ? 'record' : 'none'}
            meta={
              state?.lastNursingUtc
                ? `Last ${state.nursingSide ?? ''} · ${since(state.lastNursingUtc, now)}`.replace('  ', ' ')
                : 'No record'
            }
            onHold={() => void timer('start', side)}
          />
        )}

        {DIAPERS.slice(1).map((d) => (
          <DiaperTile key={d.kind} kind={d.kind} label={d.label} state={state} now={now}
            disabled={!controlsLive || writing} onHold={() => void logDiaper({ kind: d.kind })} />
        ))}
      </div>

      <SectionLabel label="Today" />
      {/* CARE.md gives Feeds a muted `· 11.5 OZ` suffix. There is no such figure: `BabyStateDto`
          carries a feed *count* and the amount of the last bottle only, and a day's volume summed
          from what the panel happens to have seen would be a number it cannot source. The count
          stands alone rather than carrying a total nobody can vouch for. */}
      <LedgerRow title="Feeds" right={<span className="ml-care__value serif">{state?.feedsToday ?? '—'}</span>} />
      <LedgerRow title="Diapers" right={<span className="ml-care__value serif">{state?.diapersToday ?? '—'}</span>} />

      <SectionLabel label="Latest" />
      <LedgerRow
        title="Bottle"
        sub={state?.lastBottleUtc ? `${clockTime(state.lastBottleUtc)}${state.bottleType ? ` · ${state.bottleType}` : ''}` : 'No record'}
        right={
          <span className="ml-care__value serif">
            {/* The bare number when the unit is unknown: reporting an amount we have is honest,
                appending a unit we don't is what caused the 120 ml → "120 oz" misreading. */}
            {state?.bottleAmount == null
              ? '—'
              : <>{state.bottleAmount}{lastUnits && <span className="ml-care__unit">{lastUnits}</span>}</>}
          </span>
        }
      />
      <LedgerRow
        title="Diaper"
        sub={state?.lastDiaperUtc ? clockTime(state.lastDiaperUtc) : 'No record'}
        right={<span className="ml-care__value serif">{state?.diaperType ?? '—'}</span>}
      />
      <LedgerRow
        title="Nursing"
        sub={state?.lastNursingUtc ? `${clockTime(state.lastNursingUtc)}${state.nursingSide ? ` · ${state.nursingSide}` : ''}` : 'No record'}
        right={
          <span className="ml-care__value serif">
            {state?.lastNursingMinutes == null
              ? '—'
              : <>{Math.round(state.lastNursingMinutes)}<span className="ml-care__unit">m</span></>}
          </span>
        }
      />

      {/* Growth degrades to unknown row by row: the sensor reports `unknown` until something is
          logged, and two of its three attribute names are unverified upstream. Never synthesise a
          value here — an em-dash is the honest reading. */}
      <SectionLabel
        label="Growth"
        status={state?.growthMeasuredUtc
          ? new Date(state.growthMeasuredUtc).toLocaleDateString()
          : <span className="ml-care__nostatus">Not measured</span>}
      />
      <GrowthRow title="Weight" value={state?.weight} unit={state?.weightUnit} />
      <GrowthRow title="Length" value={state?.height} unit={state?.lengthUnit} />
      <GrowthRow title="Head" value={state?.headCircumference} unit={state?.lengthUnit} />

      {/* The other subject's state, so the section's second half is never out of sight entirely —
          this is the one place Conrad's view says anything about Mika. */}
      <div className="ml-care__footer">
        <span className={'ml-care__footnote' + (mika?.faulted ? ' ml-care__footnote--fault' : '')}>
          {mika ? `${mika.name} — ${mika.sync.text}` : ''}
        </span>
        <button type="button" className="ml-care__footlink" onClick={() => navigate('/care/history')}>
          Trends ▸
        </button>
      </div>
    </>
  )
}

/** One growth row, degrading independently of the other two. */
function GrowthRow({ title, value, unit }: { title: string; value?: number | null; unit?: string | null }) {
  return (
    <LedgerRow
      title={title}
      right={
        <span className={'ml-care__value serif' + (value == null ? ' ml-care__value--none' : '')}>
          {value == null ? '—' : <>{value}{unit && <span className="ml-care__unit">{unit}</span>}</>}
        </span>
      }
    />
  )
}

function DiaperTile({
  kind, label, state, now, disabled, onHold,
}: {
  kind: DiaperKindName
  label: string
  state: BabyStateDto | null
  now: number
  disabled: boolean
  onHold: () => void
}) {
  const isLast = state?.diaperType?.toLowerCase() === kind
  return (
    <CareTile
      glyph="ico-diaper"
      name={label}
      disabled={disabled}
      tone={isLast ? 'record' : 'none'}
      meta={isLast ? `Last · ${since(state?.lastDiaperUtc ?? null, now)}` : 'No record today'}
      onHold={onHold}
    />
  )
}

/**
 * One log tile: glyph, name, meta, hold track.
 *
 * A `HoldButton` underneath, because the hold is the whole point — releasing early cancels, and
 * nothing fires unless the track completes. `progressTrack` rather than the sweeping fill: a tile
 * whose background sweeps reads as *selected*, and these are writes that cannot be taken back.
 */
function CareTile({
  glyph, name, meta, tone, disabled, onHold,
}: {
  glyph: IconId
  name: string
  meta: string
  tone: 'suggestion' | 'record' | 'none'
  disabled: boolean
  onHold: () => void
}) {
  return (
    <HoldButton
      className={`ml-caretile ml-caretile--${tone}`}
      label={name}
      disabled={disabled}
      progressTrack
      meta={meta}
      onHold={onHold}
    >
      <span className="ml-caretile__glyph" aria-hidden="true"><Icon id={glyph} size="1.625rem" /></span>
      <span className="ml-caretile__name">{name}</span>
    </HoldButton>
  )
}

/**
 * The panel remembers the last side used and suggests the other one, mirroring Huckleberry's own
 * last-side memory so app and panel never disagree.
 */
function suggestedSide(state: BabyStateDto | null): 'left' | 'right' {
  return state?.nursingSide?.toLowerCase() === 'left' ? 'right' : 'left'
}

/**
 * The running nursing timer.
 *
 * Cancel and complete are offered separately and labelled for what they do, because upstream they
 * are not the same thing: cancel saves no interval, complete writes the session to history. (Nor is
 * either the same as toggling the HA switch entity, which silently performs a complete — which is
 * why timer control goes through the services.)
 */
function NursingBand({
  state, writing, onAction,
}: {
  state: BabyStateDto
  writing: boolean
  onAction: (action: 'pause' | 'resume' | 'cancel' | 'complete' | 'switchside') => void
}) {
  const now = useNow(1000) // MM:SS has to move every second to read as running
  const started = state.nursingStartedUtc ? new Date(state.nursingStartedUtc).getTime() : null
  const ticking = started != null ? Math.max(0, Math.floor((now - started) / 1000)) : null

  /**
   * The clock stops while paused.
   *
   * Elapsed is wall-clock since `nursingStartedUtc`, so left alone it keeps climbing through a
   * pause — the band reads "Paused" beside a number still counting up, and the figure shown when
   * Resume is pressed includes every paused minute. The last running value is held here instead.
   *
   * Honest limitation: Huckleberry exposes no pause timestamp and no elapsed of its own, so a
   * session that was paused *earlier* and resumed still counts that gap. Only the pause in progress
   * can be excluded, and only for as long as this view stays mounted — which is why a paused timer
   * that was already paused when the view opened shows "—" rather than a number nobody can vouch for.
   */
  const heldWhilePaused = useRef<number | null>(null)
  useEffect(() => {
    if (started != null && !state.nursingPaused) heldWhilePaused.current = ticking
  }, [ticking, started, state.nursingPaused])

  const elapsed = state.nursingPaused ? heldWhilePaused.current : ticking
  const mmss = elapsed == null
    ? '—'
    : `${Math.floor(elapsed / 60).toString().padStart(2, '0')}:${(elapsed % 60).toString().padStart(2, '0')}`

  return (
    <div className="ml-nursing">
      <div className="ml-nursing__status">
        {state.nursingPaused ? 'Paused' : 'Running'}
        {state.nursingSide ? ` · ${state.nursingSide} side` : ''}
      </div>
      <div className="ml-nursing__clock serif">{mmss}</div>
      <div className="ml-nursing__actions">
        <button
          type="button"
          className="ml-chip"
          disabled={writing}
          onClick={() => onAction(state.nursingPaused ? 'resume' : 'pause')}
        >
          {state.nursingPaused ? 'Resume' : 'Pause'}
        </button>
        <button type="button" className="ml-chip" disabled={writing} onClick={() => onAction('switchside')}>
          Switch side
        </button>
      </div>
      <div className="ml-nursing__finish">
        <HoldButton disabled={writing} onHold={() => onAction('complete')} meta="Writes the session to history">
          Save session
        </HoldButton>
        <HoldButton destructive disabled={writing} onHold={() => onAction('cancel')} meta="Discards it — nothing is saved">
          Discard
        </HoldButton>
      </div>
    </div>
  )
}
