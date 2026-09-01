import { HoldButton } from '../../components'
import { careTitle, clockLabel, holdsToStop, otherSide } from '../../app/care'
import { CarePanel } from './CarePanel'
import { mmss, useRunningSeconds } from './runningClock'
import { pumpBoundaries } from './pumpPhases'
import type { CareTimerDto } from '../../api/types'

/**
 * A session in progress — nursing, pump or sleep.
 *
 * <b>The panel a running timer opens is not the panel that started it.</b> The idle one asks how
 * much and when; this one answers how long, and offers the two ways out. Reaching it is the point:
 * a session that could be started and then not looked at again is a timer the household cannot
 * trust, and the tile it came from used to be inert while one was running.
 *
 * <b>COMPLETE and CANCEL are never one control.</b> Upstream they are different acts — one writes
 * the session to history, the other throws it away — and the design puts them as two labelled cards
 * with a sentence each, in the footer where SAVE sits on every other panel, under a warning that
 * they are not the same.
 *
 * <b>On a pump, both are held rather than tapped.</b> The original reading was that neither needed
 * it: both are plainly labelled, and a nursing session ended by mistake can simply be logged again
 * from memory. A pump session cannot. It is twenty minutes of clock the panel measured and nobody
 * else did, and it is unrecoverable by hand — so a knee against a wall panel either throws it away
 * or stops it early, and there is nothing to type back in afterwards. Nursing and sleep keep the
 * plain buttons, because for those the tap is still cheaper than the guard.
 */
export function CareRunning({
  timer, saving, rise = true, onPause, onResume, onSwitchSide, onSwitchPhase, onComplete, onDiscard, onClose,
}: {
  timer: CareTimerDto
  saving: boolean
  /** False when this panel is taking over from the one that started the session. */
  rise?: boolean
  onPause: () => void
  onResume: () => void
  onSwitchSide: (side: string) => void
  onSwitchPhase: () => void
  /**
   * Ends the session.
   *
   * On a pump this is FINISH and writes nothing — it measures the session and hands it to the
   * finish panel, which is where the amount is asked for. Everywhere else it is COMPLETE and
   * writes the row. See the footer below.
   */
  onComplete: () => void
  onDiscard: () => void
  onClose: () => void
}) {
  const elapsed = useRunningSeconds(timer)

  const isPump = timer.type === 'Pump'
  /* The same arithmetic the alert buzzes on — expression counted from the switch, not from the
     start of the session. See `pumpBoundaries`. */
  const { switchAt, endsAt } = pumpBoundaries(timer)
  const inPhaseOne = isPump && timer.phase === 1
  /*
   * Past the switch and still in stimulation, the countdown counts *up*.
   *
   * It used to sit at 00:00 for as long as it took somebody to notice, which says "the switch is
   * due" and nothing about how long it has been due — and the session clock beside it is counting
   * the whole session, so there was no figure on the panel for the overrun itself. Now that
   * overrunning costs expression nothing, how far over is a thing worth being able to read rather
   * than a number to feel bad about.
   */
  const over = inPhaseOne && elapsed > switchAt
  // Phase one counts *down*, because the number wanted at 6am is how long until the switch.
  const countdown = inPhaseOne ? Math.abs(switchAt - elapsed) : Math.max(0, endsAt - elapsed)
  const progress = endsAt > 0 ? Math.min(1, elapsed / endsAt) : 0

  const side = timer.side ?? null

  return (
    <CarePanel
      title={careTitle(timer.type)}
      label={
        <span className="ml-carerunning__live">
          <span className="ml-carerunning__dot" aria-hidden="true" />
          {timer.paused ? 'Paused' : 'Running'}
        </span>
      }
      running
      rise={rise}
      onClose={onClose}
      footer={
        <>
          {/*
            The cautionary line, and which caution it is depends on how the cards behave.

            Where they are held, it says so. `These are not the same` was the right warning while
            both were one tap — the risk then was picking the wrong one of two adjacent controls. A
            held card cannot be picked by accident at all, so the thing worth saying in that slot is
            the gesture: somebody who taps and sees nothing happen needs to be told why, and this is
            the only line on the panel that can tell them. What the two cards *do* differently is
            still stated in full, in the sentence under each name.

            Where they are still tapped — nursing, sleep, tummy time — the original warning stands,
            because there the two-controls risk is exactly the live one.
          */}
          <div className="ml-carestop__head">
            <span className="ml-carestop__label">Stopping</span>
            <span className="ml-carestop__warn">
              {holdsToStop(timer.type) ? 'Hold either to confirm' : 'These are not the same'}
            </span>
          </div>
          {/*
            FINISH on a pump, COMPLETE everywhere else — and the difference is not wording.

            A nursing session is fully known when it stops: COMPLETE writes it. A pump session is
            not, because how much was expressed is knowable only once it is over, so FINISH stops
            the clock, holds the session, and asks. Nothing is written until SAVE on that panel.
            The card says which of the two is about to happen, in the sentence under its name.
          */}
          <StopCard
            name={isPump ? 'Finish' : 'Complete'}
            what={isPump
              ? 'Stops the timer and asks how much you got'
              : `Writes ${Math.floor(elapsed / 60)} minutes${side ? ` on the ${side}` : ''} to history`}
            hold={holdsToStop(timer.type)}
            onAct={onComplete}
            disabled={saving}
          />
          <StopCard
            name="Cancel"
            what={isPump
              ? 'Throws the session away without recording it'
              : 'Throws the session away, nothing is written'}
            hold={holdsToStop(timer.type)}
            discard
            onAct={onDiscard}
            disabled={saving}
          />
        </>
      }
    >
      {/* Verdigris is reserved for a live clock. Nothing else on the panel is this colour. */}
      <div className="ml-carerunning__card">
        {isPump ? (
          <>
            <div className="ml-carerunning__phases">
              <span className="ml-carerunning__col">
                <span className="ml-carerunning__caption">
                  {inPhaseOne
                    ? over ? 'Stimulation · over by' : 'Stimulation · switches in'
                    : 'Expression · ends in'}
                </span>
                <span className="ml-carerunning__clock serif">{mmss(countdown)}</span>
              </span>
              <span className="ml-carerunning__col ml-carerunning__col--right">
                <span className="ml-carerunning__caption ml-carerunning__caption--quiet">Session</span>
                <span className="ml-carerunning__total serif">{mmss(elapsed)}</span>
              </span>
            </div>
            {/* Weighted across the whole session, so phase two is visible from inside phase one. */}
            <div className="ml-carerunning__bar" aria-hidden="true">
              <span className="ml-carerunning__done" style={{ flex: progress }} />
              <span className="ml-carerunning__rest" style={{ flex: 1 - progress }} />
            </div>
            <div className="ml-carerunning__legend">
              <span>{timer.phaseOneMinutes} min stimulation</span>
              <span>{timer.phaseTwoMinutes} min expression</span>
            </div>
          </>
        ) : (
          <>
            <div className="ml-carerunning__clock ml-carerunning__clock--big serif">{mmss(elapsed)}</div>
            <div className="ml-carerunning__caption">
              {side ? `${side} side · ` : ''}started {clockLabel(new Date(timer.startedUtc))}
            </div>
          </>
        )}
      </div>

      <div className="ml-carerunning__label">While it runs</div>
      <div className="ml-carerunning__acts">
        {isPump && (
          <button type="button" className="ml-carerunning__act" onClick={onSwitchPhase} disabled={saving || !inPhaseOne}>
            Switch now
          </button>
        )}
        {timer.type === 'Nursing' && (
          <button
            type="button"
            className="ml-carerunning__act"
            onClick={() => onSwitchSide(otherSide(side) ?? 'left')}
            disabled={saving}
          >
            Switch to {otherSide(side) ?? 'left'}
          </button>
        )}
        <button
          type="button"
          className="ml-carerunning__act"
          onClick={timer.paused ? onResume : onPause}
          disabled={saving}
        >
          {timer.paused ? 'Resume' : 'Pause'}
        </button>
      </div>

      {/* Pushed to the foot of the body. A session completed from another room is honoured; this
          panel never completes one on anybody's behalf. */}
      <p className="ml-carerunning__note">
        Completing from another room writes the session too. The panel never completes one on your behalf.
      </p>
    </CarePanel>
  )
}

/**
 * One of the two ways out of a running session.
 *
 * The same card either way — a name and the sentence saying what it does — differing only in whether
 * it acts on a tap or on a hold. The hold adds no label and no banner telling you to hold: the fill
 * sweeping under the words is the affordance, and it is the one the panel already uses everywhere a
 * touch has to be deliberate. A card captioned `HOLD TO FINISH` would be the panel explaining its
 * own controls in the footer of a screen somebody is reading one-handed at 4am.
 */
function StopCard({
  name, what, hold, discard, onAct, disabled,
}: {
  name: string
  what: string
  /** Held rather than tapped — see the note on {@link CareRunning} for which sessions earn it. */
  hold: boolean
  discard?: boolean
  onAct: () => void
  disabled?: boolean
}) {
  const className = 'ml-carestop__card' + (discard ? ' ml-carestop__card--discard' : '')

  if (!hold) {
    return (
      <button type="button" className={className} onClick={onAct} disabled={disabled}>
        <span className="ml-carestop__name">{name}</span>
        <span className="ml-carestop__what">{what}</span>
      </button>
    )
  }

  return (
    <HoldButton
      className={`${className} ml-carestop__card--hold`}
      onHold={onAct}
      disabled={disabled}
      // Terracotta under the one that cannot be taken back, brass under the other. Both are the
      // section's standard 2s: two controls side by side that answered the same gesture at
      // different speeds would read as one of them being broken.
      destructive={discard}
      label={`${name} — hold to confirm`}
      meta={what}
    >
      {name}
    </HoldButton>
  )
}
