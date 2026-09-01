import { useEffect, useRef } from 'react'
import { useRunningSeconds } from './runningClock'
import type { CareTimerDto } from '../../api/types'

/**
 * The two moments a pump session has something to say.
 *
 * `switch` is the one this exists for: stimulation has run out and the phase has to be changed by
 * hand, because nothing switches it on anybody's behalf — the server holds `Phase` at 1 until
 * SWITCH NOW is pressed. Until now the only thing that announced it was a countdown reaching 00:00
 * on a panel somebody had to be looking at, which at 4am is precisely what they are not doing.
 *
 * `done` is expression running out, which means the session is over and wants COMPLETE. It is the
 * same problem one step later and costs nothing to answer at the same time.
 */
export type PumpMoment = 'switch' | 'done'

/**
 * What each moment feels like. Different from each other, and only one of them is short.
 *
 * <b>Two short pulses for the switch, three long ones for the end.</b> They are told apart by a
 * hand in the dark that is not going to look, so they cannot both be a generic buzz — one means
 * *do something now*, the other means *you are finished*. The end keeps the longer pulse it has
 * always had and now repeats it three times, which is the difference asked for by name: the switch
 * is felt by somebody mid-session with the pump in hand, while the end can arrive with the phone
 * set down, and one pulse asked to carry that is the easiest of the two to miss.
 *
 * <b>Only the end is allowed to run past a second.</b> The switch is still a tap on the shoulder
 * and stays exactly where it was; three 400ms pulses is a second and a half, which is a deliberate
 * exception rather than a drift away from the rule. The 150ms between them is wider than the
 * switch's 100ms on purpose — at this pulse length a shorter gap smears the three back into one
 * long buzz, and the count is the whole point.
 *
 * Longer than the 10ms tick `AutomatedRow` uses to confirm a press, and deliberately so. That one
 * is felt because a finger is already on the glass; this one has to be noticed by somebody who is
 * not touching the phone at all.
 *
 * Exported because the count is a requirement rather than a taste, and `pumpPhases.test.ts` pins
 * it — a three that quietly becomes a one is not a failure anything else would catch.
 */
export const PUMP_PATTERNS: Record<PumpMoment, number[]> = {
  switch: [200, 100, 200],
  done: [400, 150, 400, 150, 400],
}

/**
 * Where a pump session's two phases end, in seconds of elapsed session.
 *
 * <b>Expression is counted from the switch, not from the start of the session.</b> Both phases used
 * to be measured from zero, so expression ended at stimulation-plus-expression however long
 * stimulation actually ran — and since nothing switches a pump on anybody's behalf, overrunning it
 * by four minutes at 4am docked four minutes off the pumping. The phase that came up short was the
 * one that produces the milk. `phaseTwoAtMinutes` is the mark the server stamps at the switch, and
 * seventeen minutes of expression now means seventeen minutes of expression.
 *
 * <b>While stimulation is still running, `endsAt` is the plan</b> — where the session would finish
 * if the switch happened on time. That is what the progress bar needs in order to show phase two
 * from inside phase one, and it moves out to the truth the moment the switch is stamped.
 *
 * The fallback when the mark is missing is the old whole-session reading: a session that was
 * already running when the server learned to stamp it genuinely does not know when it turned over,
 * and a guess would be a countdown presented as a measurement.
 *
 * One function, used by the panel's countdown and by the alert below, so the buzz and the clock
 * somebody checks a second later cannot disagree.
 */
export function pumpBoundaries(timer: CareTimerDto): { switchAt: number; endsAt: number } {
  const switchAt = (timer.phaseOneMinutes ?? 0) * 60
  const expressionFrom = timer.phase === 2 && timer.phaseTwoAtMinutes != null
    ? timer.phaseTwoAtMinutes * 60
    : switchAt
  return { switchAt, endsAt: expressionFrom + (timer.phaseTwoMinutes ?? 0) * 60 }
}

/**
 * Which moment, if any, this session has just reached.
 *
 * Pure, and separate from the buzzing, because every clause is a case where alerting would be
 * wrong: a paused session is not running out of anything, a phase with no length configured has no
 * boundary to reach, and nothing but a pump has phases at all.
 */
export function pumpMomentDue(timer: CareTimerDto, elapsedSeconds: number): PumpMoment | null {
  // A held session has already ended, and being told so is no use to anybody: the household is
  // standing at the finish panel deciding on an amount, not waiting for a phase to run out.
  if (timer.type !== 'Pump' || timer.paused || timer.endedUtc != null) return null

  const { switchAt, endsAt } = pumpBoundaries(timer)

  if (timer.phase === 1) return timer.phaseOneMinutes && elapsedSeconds >= switchAt ? 'switch' : null
  if (timer.phase === 2) return timer.phaseTwoMinutes && elapsedSeconds >= endsAt ? 'done' : null
  return null
}

/**
 * Buzz the phone when a running pump session reaches one of its two boundaries.
 *
 * <b>It fires on the crossing, and only on a crossing it watched happen.</b> A moment that is
 * already past when this mounts is marked spent rather than announced — opening the Baby tab
 * twenty minutes into expression should not buzz about a switch that happened while the app was
 * closed, which is an alert for a decision already made and reads as a fault. The consequence is
 * the honest one: it can only alert while the app is running.
 *
 * <b>A crossing it watched, but could not announce, is kept rather than dropped.</b> The browser
 * refuses to vibrate a page that has had no tap and a page that is hidden, so the moment stays due
 * and is re-offered every tick until one lands or the household acts on it themselves. See the
 * call itself for why both refusals are worth waiting out.
 *
 * <b>A pause does not spend the moment.</b> While paused nothing is due, so a session paused past
 * its boundary and resumed buzzes on the next tick — it is still time to switch, and the pause is
 * the reason nobody has.
 *
 * Fires at most once per session per moment. `startedUtc` identifies the session: a cancelled and
 * restarted pump is a new one and gets its own alerts.
 */
export function usePumpAlert(timer: CareTimerDto): void {
  const seconds = useRunningSeconds(timer)
  /** Moments seen not-yet-due, and therefore worth announcing when they arrive. */
  const armed = useRef(new Set<string>())
  const fired = useRef(new Set<string>())

  useEffect(() => {
    const moment: PumpMoment | null = timer.phase === 1 ? 'switch' : timer.phase === 2 ? 'done' : null
    if (timer.type !== 'Pump' || moment === null) return

    const key = `${timer.startedUtc}:${moment}`
    if (fired.current.has(key)) return

    if (pumpMomentDue(timer, seconds) === null) {
      armed.current.add(key)
      return
    }
    if (!armed.current.has(key)) return

    /*
     * <b>A refused buzz does not spend the moment.</b> `vibrate` returns whether it will actually
     * happen, and it answers false for two reasons that are both temporary — which is the whole
     * reason to read it rather than call and hope.
     *
     * The one that bites here is <b>sticky activation</b>: the spec requires a real tap in this
     * document before the page is allowed to buzz anything, and `restoreLastTab` drops a relaunched
     * PWA straight onto this tab. So the 4am case is exactly the case where nobody has tapped —
     * Android killed the backgrounded app, the phone is picked up, the countdown is on screen and
     * crosses while it is watched, and the buzz is discarded without a sound. Which is what "the
     * vibration isn't working" turned out to be. The other is a hidden page, and it costs nothing
     * to answer at the same time.
     *
     * Marking the moment spent only on a true return turns both into a retry, and the effect
     * already re-runs every second, so no machinery is needed to hold one. What makes waiting safe
     * is that each retry re-asks `pumpMomentDue` above: the first touch anywhere grants activation
     * and the buzz lands within the second, a phone that comes back from hidden is the same story
     * one gate over, and a household that pressed SWITCH NOW rather than waiting is no longer due a
     * buzz and never hears about it. A late buzz is worth having; a buzz about a decision already
     * made is the kind this file exists to not send.
     *
     * `undefined` is not a refusal but an absence — iOS, where WebKit has never shipped the API at
     * all. Nothing is going to change there, so that moment is spent rather than retried once a
     * second for the rest of the session, and the device keeps the countdown it had before.
     */
    if (navigator.vibrate?.(PUMP_PATTERNS[moment]) !== false) fired.current.add(key)
  }, [timer, seconds])
}

/**
 * The alert as a mount rather than a call, so nothing ticks unless a pump is running.
 *
 * `usePumpAlert` needs a session and a per-second clock; conditionally *rendering* this is how the
 * day view asks for both only while there is one, since conditionally *calling* a hook is not a
 * thing. Renders nothing — it is here for the buzz.
 */
export function PumpAlert({ timer }: { timer: CareTimerDto }): null {
  usePumpAlert(timer)
  return null
}
