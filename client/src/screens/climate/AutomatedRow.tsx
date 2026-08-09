import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClimateZoneDto, ZoneStateName } from '../../api/types'
import { reading, zoneStatus } from './climateCopy'

/** The gesture's range. A room is not asked to be 55° or 90°, and the rail says so at both ends. */
const MIN_F = 64
const MAX_F = 80

/** The band is relative: the target sits at centre and eight degrees fills half of it, each way. */
const HALF_SPAN_F = 8

/** Stationary this long, within a degree, and the loan becomes an offer to keep. */
const ARM_MS = 600
const ARM_TOLERANCE_F = 1

/** Past this far above or below the row, the thumb has left and nothing is written. */
const CANCEL_MARGIN_PX = 60

type Phase =
  | { kind: 'rest' }
  | { kind: 'sliding'; value: number; armed: boolean; cancelling: boolean }

interface AutomatedRowProps {
  zone: ClimateZoneDto
  state: ZoneStateName
  now: number
  /** False while the panel is too far out of date to slide against — see `gestureLive`. */
  gestureLive: boolean
  onOpen: () => void
  onBorrow: (targetF: number) => void
  /** 3a passes nothing (promote the live loan); 3b passes the value the thumb lifted on. */
  onKeep: (targetF?: number) => void
  onUndo: () => void
}

/**
 * A room the loop holds: name and reading, the deviation band, and what the loop is doing about it.
 *
 * **At rest the row is pure status** — current temperature, the target notched, the probe sitting
 * where it actually is. The control has no resting footprint at all; the band *is* the control, and
 * the gesture happens on the exact graphic that shows the problem, so you push the dot toward the
 * notch (DECISIONS §9).
 */
export function AutomatedRow({
  zone, state, now, gestureLive, onOpen, onBorrow, onKeep, onUndo,
}: AutomatedRowProps) {
  const status = zoneStatus(zone, state, now)
  const gesture = useBandGesture(zone, gestureLive, onBorrow, onKeep)
  const sliding = gesture.phase.kind === 'sliding' ? gesture.phase : null

  const borrowed = state === 'borrowed' && zone.override != null

  return (
    <div className={'ml-czone' + (sliding ? ' ml-czone--pressed' : '')}>
      <div className="ml-czone__head">
        {/* The name is the drill-in's door; the band underneath is the gesture's. Two targets, so a
            slide can never be a mis-tap into another screen. */}
        <button type="button" className="ml-czone__name" onClick={onOpen}>{zone.name}</button>
        <span className={`ml-czone__reading serif ml-ctone--${readingTone(zone, state)}`}>
          {reading(zone.readingF, true)}
        </span>
      </div>

      <div
        className="ml-czone__hit"
        ref={gesture.hitRef}
        onPointerDown={gesture.onPointerDown}
        onPointerMove={gesture.onPointerMove}
        onPointerUp={gesture.onPointerUp}
        onPointerCancel={gesture.onCancel}
      >
        {sliding
          ? <SlidingBand zone={zone} phase={sliding} railRef={gesture.railRef} />
          : <RestingBand zone={zone} state={state} railRef={gesture.railRef} />}
      </div>

      <div className="ml-czone__foot">
        <span className={`ml-czone__status ml-ctone--${sliding ? slidingTone(sliding) : status.tone}`}>
          {sliding ? slidingSentence(sliding) : status.text}
          {!sliding && status.undo && (
            <>
              {' · '}
              <button type="button" className="ml-czone__undo" onClick={onUndo}>UNDO</button>
            </>
          )}
        </span>

        {sliding ? (
          // Two hints, and which one shows is the tell that the gesture has changed under the thumb:
          // before arming it says there is more here, after arming it says how to get out.
          <span className={'ml-czone__hint ml-ctone--' + (sliding.armed ? 'disabled' : 'brassmeta')}>
            {sliding.armed ? 'SLIDE OFF TO CANCEL' : 'STAY FOR MORE'}
          </span>
        ) : borrowed ? (
          // 3a — asked afterwards. The `HOLD` label is *replaced* by the control, so the row gains a
          // way to keep the borrowed number without gaining a permanent button.
          <button type="button" className="ml-czone__keep" onClick={() => onKeep()}>
            KEEP {Math.round(zone.override!.targetF)}°
          </button>
        ) : (
          <span className={'ml-czone__hold ml-ctone--' + (holdDim(zone, state) ? 'disabled' : 'brass')}>
            {zone.standingTargetF == null ? '' : `HOLD ${Math.round(zone.standingTargetF)}°`}
          </span>
        )}
      </div>
    </div>
  )
}

/** The reading goes amber when the room has been outside tolerance a while, and grey when unread. */
function readingTone(zone: ClimateZoneDto, state: ZoneStateName): string {
  if (zone.readingF == null) return 'disabled'
  if (state === 'cantHold') return 'alert'
  if ((zone.outsideMinutes ?? 0) > 30) return 'alert'
  return 'primary'
}

/** A room nobody is holding does not get a brass number: there is no promise to render. */
function holdDim(zone: ClimateZoneDto, state: ZoneStateName): boolean {
  return zone.isPaused || state === 'probeLost' || state === 'noProbe' || state === 'unitOff'
}

// ---------------------------------------------------------------------------
// The band at rest — the deviation graphic
// ---------------------------------------------------------------------------

/**
 * The target is always centre and the scale is relative, ±8° across the full width. The band answers
 * "how far off is this room, and which way" without asking anyone to read a number off an axis.
 */
function RestingBand({
  zone, state, railRef,
}: {
  zone: ClimateZoneDto
  state: ZoneStateName
  railRef: React.RefObject<HTMLDivElement | null>
}) {
  const target = zone.targetF
  const probe = zone.readingF

  // No probe, or a silent one: an empty band. Not a dot at the last place it was seen — a
  // temperature without a fresh timestamp is a lie told confidently.
  if (target == null || probe == null) {
    return <div className="ml-cband" ref={railRef} />
  }

  const delta = probe - target
  const pegged = Math.abs(delta) > HALF_SPAN_F
  const pct = 50 + (Math.max(-HALF_SPAN_F, Math.min(HALF_SPAN_F, delta)) / HALF_SPAN_F) * 50
  const inside = Math.abs(delta) <= zone.toleranceF
  const stuck = state === 'cantHold'
  const dotTone = inside ? 'live' : stuck ? 'alert' : 'brass'

  // During a loan the band shows what you are borrowing *from*: the standing target keeps a dim tick
  // at its true offset from the borrowed one, which is now the centre.
  const standingPct = zone.override != null && zone.standingTargetF != null
    ? 50 + (Math.max(-HALF_SPAN_F, Math.min(HALF_SPAN_F, zone.standingTargetF - target)) / HALF_SPAN_F) * 50
    : null

  return (
    <div className="ml-cband" ref={railRef}>
      {!inside && (
        <span
          className={'ml-cband__fill ml-cband__fill--' + (stuck ? 'stuck' : 'correcting')}
          style={{ left: `${Math.min(50, pct)}%`, width: `${Math.abs(pct - 50)}%` }}
          aria-hidden="true"
        />
      )}
      {standingPct != null && (
        <span className="ml-cband__standing" style={{ left: `${standingPct}%` }} aria-hidden="true" />
      )}
      <span
        className={'ml-cband__notch' + (zone.override != null ? ' ml-cband__notch--borrowed' : '')}
        aria-hidden="true"
      />
      {pegged
        ? <span className={'ml-cband__peg ml-cband__peg--' + (delta > 0 ? 'high' : 'low')} aria-hidden="true" />
        : null}
      <span
        className={`ml-cband__dot ml-cdot--${dotTone}`}
        style={{ left: `${pct}%` }}
        aria-hidden="true"
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// The band under a thumb
// ---------------------------------------------------------------------------

/**
 * Mid-gesture the band stops being relative and becomes the thing you are choosing on: an absolute
 * 64–80° rail with the standing target marked where it really sits, so the number under the thumb
 * and the number you are moving away from can be compared at a glance (CLIMATE_SCREEN §4).
 */
function SlidingBand({
  zone, phase, railRef,
}: {
  zone: ClimateZoneDto
  phase: Extract<Phase, { kind: 'sliding' }>
  railRef: React.RefObject<HTMLDivElement | null>
}) {
  const pct = ((phase.value - MIN_F) / (MAX_F - MIN_F)) * 100
  const standing = zone.standingTargetF
  const standingPct = standing == null ? null : ((standing - MIN_F) / (MAX_F - MIN_F)) * 100

  return (
    <div className="ml-cslider">
      <div className="ml-cslider__rail" ref={railRef}>
        {/* Travelled rail: only once armed, because until then the gesture has not committed to
            anything that needs showing where it came from. */}
        {phase.armed && <span className="ml-cslider__travelled" style={{ width: `${pct}%` }} aria-hidden="true" />}
      </div>
      {standingPct != null && (
        <>
          <span className="ml-cslider__standing" style={{ left: `${standingPct}%` }} aria-hidden="true" />
          <span className="ml-cslider__standinglabel" style={{ left: `${standingPct}%` }}>
            {Math.round(standing!)}° STANDING
          </span>
        </>
      )}
      <span
        className={'ml-cslider__thumb' + (phase.armed ? ' ml-cslider__thumb--armed' : '')}
        style={{ left: `${pct}%` }}
        aria-hidden="true"
      />
      <span
        className={'ml-cslider__readout' + (phase.armed ? ' ml-cslider__readout--armed' : '')}
        style={{ left: `${pct}%` }}
      >
        <span className="serif">{phase.value}°</span>
        {phase.armed && <span className="ml-cslider__keep">KEEP</span>}
      </span>
      <span className="ml-cslider__end ml-cslider__end--min">{MIN_F}°</span>
      <span className="ml-cslider__end ml-cslider__end--max">{MAX_F}°</span>
    </div>
  )
}

function slidingSentence(phase: Extract<Phase, { kind: 'sliding' }>): string {
  if (phase.cancelling) return 'RELEASE TO CANCEL'
  return phase.armed
    ? `LIFT NOW AND ${phase.value}° BECOMES STANDING`
    : `RELEASE TO HOLD ${phase.value}° FOR TWO HOURS`
}

function slidingTone(phase: Extract<Phase, { kind: 'sliding' }>): string {
  if (phase.cancelling) return 'disabled'
  return phase.armed ? 'bright' : 'brass'
}

// ---------------------------------------------------------------------------
// The gesture
// ---------------------------------------------------------------------------

/**
 * Press, slide, and either lift or stay.
 *
 * Two intents live in one gesture. Lifting on a value borrows the room for two hours — forgiving,
 * and therefore safe to use casually. Holding still for a beat first turns the same lift into a
 * permanent change, which is the fast path for someone who already knows the number they want.
 * Moving again disarms it back to the loan, so the slower intent is never a trap.
 *
 * A slider is also the only control that *has* a notion of "still holding", which is why the design
 * chose the band over steppers: 3b has nowhere to live on a pair of buttons (DECISIONS §9).
 */
function useBandGesture(
  zone: ClimateZoneDto,
  gestureLive: boolean,
  onBorrow: (targetF: number) => void,
  onKeep: (targetF?: number) => void,
) {
  const [phase, setPhase] = useState<Phase>({ kind: 'rest' })
  const hitRef = useRef<HTMLDivElement>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const armTimer = useRef(0)
  const armedFrom = useRef(0)

  const disabled = !gestureLive
    || zone.class !== 'Automated'
    || zone.isPaused
    || zone.readingF == null
    || zone.standingTargetF == null
    || zone.state === 'probeLost'
    || zone.state === 'noProbe'

  const clearArm = useCallback(() => {
    window.clearTimeout(armTimer.current)
    armTimer.current = 0
  }, [])

  useEffect(() => clearArm, [clearArm])

  const valueAt = useCallback((clientX: number) => {
    const rail = railRef.current
    if (!rail) return zone.standingTargetF ?? MIN_F
    const rect = rail.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    // Whole degrees only. A room is not asked for a tenth, and snapping is what makes the value
    // under a thumb the same value that gets written.
    return Math.round(MIN_F + ratio * (MAX_F - MIN_F))
  }, [zone.standingTargetF])

  const armLater = useCallback((from: number) => {
    clearArm()
    armedFrom.current = from
    armTimer.current = window.setTimeout(() => {
      setPhase((p) => {
        if (p.kind !== 'sliding' || p.armed || p.cancelling) return p
        // One light tick at the moment it arms — the only haptic in the section, and it is doing the
        // work of telling a thumb that the offer under it has changed without asking the eye to check.
        navigator.vibrate?.(10)
        return { ...p, armed: true }
      })
    }, ARM_MS)
  }, [clearArm])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const value = valueAt(e.clientX)
    setPhase({ kind: 'sliding', value, armed: false, cancelling: false })
    armLater(value)
  }, [disabled, valueAt, armLater])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    setPhase((p) => {
      if (p.kind !== 'sliding') return p
      const rect = hitRef.current?.getBoundingClientRect()
      const cancelling = rect != null
        && (e.clientY < rect.top - CANCEL_MARGIN_PX || e.clientY > rect.bottom + CANCEL_MARGIN_PX)
      const value = valueAt(e.clientX)
      // A move of more than a degree disarms: someone still choosing has not chosen, and lifting
      // there must cost them two hours rather than a room's definition.
      if (Math.abs(value - armedFrom.current) > ARM_TOLERANCE_F) armLater(value)
      return { ...p, value, cancelling, armed: cancelling ? false : p.armed }
    })
  }, [valueAt, armLater])

  const onPointerUp = useCallback(() => {
    clearArm()
    setPhase((p) => {
      if (p.kind === 'sliding' && !p.cancelling) {
        // Armed means the thumb has been offered `KEEP` and stayed. Lifting there writes the standing
        // target directly — the value goes with it, because no loan was ever released to promote.
        if (p.armed) onKeep(p.value)
        else onBorrow(p.value)
      }
      return { kind: 'rest' }
    })
  }, [clearArm, onBorrow, onKeep])

  const onCancel = useCallback(() => {
    clearArm()
    setPhase({ kind: 'rest' })
  }, [clearArm])

  return { phase, hitRef, railRef, onPointerDown, onPointerMove, onPointerUp, onCancel }
}
