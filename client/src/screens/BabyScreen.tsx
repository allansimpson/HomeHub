import { useEffect, useMemo, useRef } from 'react'
import { DrillInHeader, EmptyState, HoldButton, LedgerRow, ScreenShell, ScrollArea, SectionLabel } from '../components'
import { useBaby } from '../app/BabyProvider'
import { useNow } from '../app/useNow'
import type { BabyHealthDto, BabyStateDto, BottleTypeName, DiaperKindName } from '../api/types'

/** 12-hour throughout the Baby section — `8:35 AM`, never `08:35`. */
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

function ageLabel(birthday: string | null, now: number): string | null {
  if (!birthday) return null
  const days = Math.floor((now - new Date(`${birthday}T00:00:00`).getTime()) / 86_400_000)
  if (days < 0) return null
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} old`
  const weeks = Math.floor(days / 7)
  return `${weeks} week${weeks === 1 ? '' : 's'} old`
}

/**
 * The sync line. Five states, deliberately distinguishable: "HA is down" and "the integration isn't
 * there" need different fixes, and `NotConfigured` is not an error.
 */
function syncLine(health: BabyHealthDto | null, state: BabyStateDto | null, now: number) {
  if (!health) return { text: 'Reading Huckleberry…', tone: 'muted' as const }
  switch (health.status) {
    case 'NotConfigured':
      return { text: 'Not connected', tone: 'muted' as const }
    case 'Ok':
      return { text: `Huckleberry · updated ${since(state?.fetchedUtc ?? null, now).toLowerCase()}`, tone: 'live' as const }
    case 'HomeAssistantUnreachable':
      return { text: 'Home Assistant unreachable', tone: 'bad' as const }
    case 'IntegrationMissing':
      return { text: 'Huckleberry integration not found', tone: 'bad' as const }
    case 'Stale':
      return { text: `Showing last known · ${since(state?.fetchedUtc ?? null, now).toLowerCase()}`, tone: 'warn' as const }
  }
}

const DIAPERS: { kind: DiaperKindName; label: string }[] = [
  { kind: 'pee', label: 'Wet' },
  { kind: 'poo', label: 'Dirty' },
  { kind: 'both', label: 'Both' },
  { kind: 'dry', label: 'Dry' },
]

/**
 * Baby Today — the tab root, and a quick-entry surface first.
 *
 * Two upstream facts shape the whole screen and neither is visible in the mockups:
 *
 * - **Every write is irreversible.** Huckleberry exposes no delete or edit service, so a mis-tap
 *   here cannot be undone by HomeHub — only in the app. That rules out the designed one-tap tiles
 *   and their 3-second undo toast; the tiles hold to confirm instead.
 * - **Writes never queue.** A failed write fails visibly and stays failed, rather than being
 *   retried later against a system of record that can't delete a duplicate.
 *
 * There is also no retroactive logging upstream, so nothing here offers a time field: bottles and
 * diapers log *now*. Only the nursing timer carries a time basis.
 */
export function BabyScreen() {
  const { health, child, state, loading, error, writing, logBottle, logDiaper, timer, clearError } = useBaby()
  const now = useNow(30_000)

  const sync = syncLine(health, state, now)
  const age = ageLabel(child?.birthday ?? null, now)

  const header = useMemo(
    () => (
      <DrillInHeader
        title={child?.name ?? 'Baby'}
        status={state ? `${state.feedsToday} feeds · ${state.diapersToday} diapers` : age ?? ''}
      />
    ),
    [child?.name, state, age],
  )

  if (!loading && health && !health.configured) {
    return (
      <ScreenShell header={header}>
        <EmptyState
          label="Not connected"
          hint="Huckleberry reaches the panel through Home Assistant. Connect it in Config to log feeds and diapers here."
        />
      </ScreenShell>
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
   * the unit is the one thing this screen must not do.
   */
  const lastUnits: 'ml' | 'oz' | null =
    state?.bottleUnit?.toLowerCase() === 'ml' ? 'ml'
    : state?.bottleUnit?.toLowerCase() === 'oz' ? 'oz'
    : null
  const canRepeatBottle = lastAmount != null && lastUnits != null
  const lastType = (state?.bottleType ?? '').toLowerCase().replace(/\s+/g, '_') as BottleTypeName

  return (
    <ScreenShell header={header}>
      <ScrollArea>
        <div className={`ml-syncline ml-syncline--${sync.tone}`}>
          <span className="ml-syncline__dot" aria-hidden="true" />
          <span className="ml-syncline__text">{sync.text}</span>
          {age && <span className="ml-syncline__meta">{age}</span>}
        </div>

        {health?.detail && sync.tone === 'bad' && <div className="ml-baby__detail">{health.detail}</div>}

        {error && (
          <div className="ml-baby__error" role="alert">
            <span className="ml-baby__errortext">{error}</span>
            <button type="button" className="ml-linkbtn" onClick={clearError}>Dismiss</button>
          </div>
        )}

        {state?.nursingRunning && <NursingBand state={state} writing={writing} onAction={timer} />}

        <SectionLabel label="Log" status="Hold to confirm — entries can't be undone" />
        <div className="ml-babygrid">
          <HoldButton
            disabled={!controlsLive || writing || !canRepeatBottle}
            meta={
              lastAmount == null
                ? 'No previous bottle to repeat'
                : lastUnits == null
                  // Says what is wrong rather than showing a number with a unit nobody verified.
                  ? `Last bottle has no unit recorded — log it in Huckleberry`
                  : `${lastAmount} ${lastUnits} · ${since(state?.lastBottleUtc ?? null, now)}`
            }
            onHold={() => {
              // Narrowed on the values themselves, not `canRepeatBottle` — the compiler has to see
              // that neither is null here, and that is the whole point of the guard.
              if (lastAmount != null && lastUnits != null) {
                void logBottle({ amount: lastAmount, type: lastType || 'formula', units: lastUnits })
              }
            }}
          >
            Bottle again
          </HoldButton>

          {DIAPERS.map((d) => (
            <HoldButton
              key={d.kind}
              disabled={!controlsLive || writing}
              meta={
                state?.diaperType?.toLowerCase() === d.kind
                  ? `Last · ${since(state?.lastDiaperUtc ?? null, now)}`
                  : undefined
              }
              onHold={() => void logDiaper({ kind: d.kind })}
            >
              {d.label}
            </HoldButton>
          ))}

          {!state?.nursingRunning && (
            <HoldButton
              disabled={!controlsLive || writing}
              meta={
                state?.lastNursingUtc
                  ? `Last ${state.nursingSide ?? ''} · ${since(state.lastNursingUtc, now)}`.replace('  ', ' ')
                  : 'No record'
              }
              onHold={() => void timer('start', suggestedSide(state))}
            >
              Nurse {suggestedSide(state) === 'right' ? 'right' : 'left'}
            </HoldButton>
          )}
        </div>

        <SectionLabel label="Today" />
        <LedgerRow title="Feeds" right={<span className="serif">{state?.feedsToday ?? '—'}</span>} />
        <LedgerRow title="Diapers" right={<span className="serif">{state?.diapersToday ?? '—'}</span>} />

        <SectionLabel label="Latest" />
        <LedgerRow
          title="Bottle"
          sub={state?.lastBottleUtc ? `${clockTime(state.lastBottleUtc)}${state.bottleType ? ` · ${state.bottleType}` : ''}` : 'No record'}
          right={
            <span className="serif">
              {/* The bare number when the unit is unknown: reporting an amount we have is honest,
                  appending a unit we don't is what caused the 120 ml → "120 oz" misreading. */}
              {state?.bottleAmount == null
                ? '—'
                : `${state.bottleAmount}${lastUnits ? ` ${lastUnits}` : ''}`}
            </span>
          }
        />
        <LedgerRow
          title="Diaper"
          sub={state?.lastDiaperUtc ? clockTime(state.lastDiaperUtc) : 'No record'}
          right={<span className="serif">{state?.diaperType ?? '—'}</span>}
        />
        <LedgerRow
          title="Nursing"
          sub={state?.lastNursingUtc ? `${clockTime(state.lastNursingUtc)}${state.nursingSide ? ` · ${state.nursingSide}` : ''}` : 'No record'}
          right={<span className="serif">{state?.lastNursingMinutes == null ? '—' : `${Math.round(state.lastNursingMinutes)}m`}</span>}
        />

        {/* Growth degrades to unknown row by row: the sensor reports `unknown` until something is
            logged, and two of its attribute names are unverified upstream. */}
        <SectionLabel label="Growth" status={state?.growthMeasuredUtc ? new Date(state.growthMeasuredUtc).toLocaleDateString() : 'Not measured'} />
        <LedgerRow
          title="Weight"
          right={<span className="serif">{state?.weight == null ? '—' : `${state.weight} ${state.weightUnit ?? ''}`.trim()}</span>}
        />
        <LedgerRow
          title="Length"
          right={<span className="serif">{state?.height == null ? '—' : `${state.height} ${state.lengthUnit ?? ''}`.trim()}</span>}
        />
        <LedgerRow
          title="Head"
          right={<span className="serif">{state?.headCircumference == null ? '—' : `${state.headCircumference} ${state.lengthUnit ?? ''}`.trim()}</span>}
        />
      </ScrollArea>
    </ScreenShell>
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
   * can be excluded, and only for as long as this screen stays mounted — which is why a paused timer
   * that was already paused when the screen opened shows "—" rather than a number nobody can vouch for.
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
