import { describe, expect, it } from 'vitest'
import { pumpBoundaries, pumpMomentDue } from './pumpPhases'
import type { CareTimerDto } from '../../api/types'

/**
 * When the phone is allowed to buzz.
 *
 * The buzz is the only thing on this screen somebody feels without looking, so a wrong one is worse
 * than none: it says "switch now" about a session that is four minutes from switching, and the
 * household learns to distrust it. Every case below is one where alerting would be a lie.
 */

/** Three minutes of stimulation then seventeen of expression — the panel's own defaults. */
const pump = (over: Partial<CareTimerDto> = {}): CareTimerDto => ({
  type: 'Pump',
  side: null,
  startedUtc: '2026-08-17T04:00:00Z',
  paused: false,
  elapsedMinutes: 0,
  phaseOneMinutes: 3,
  phaseTwoMinutes: 17,
  phase: 1,
  phaseTwoAtMinutes: null,
  endedUtc: null,
  ...over,
})

/**
 * Expression gets its whole length from the switch, whenever the switch happens.
 *
 * This is the fix the household asked for by name. Nothing moves a pump session on: overrun
 * stimulation by four minutes at 4am and the old arithmetic — both phases measured from zero —
 * took those four minutes off the expression phase, which is the one that produces the milk.
 */
describe('pump boundaries', () => {
  it('plans the whole session while stimulation is still running', () => {
    /* Phase two has to be visible from inside phase one: the progress bar draws both. */
    expect(pumpBoundaries(pump())).toEqual({ switchAt: 180, endsAt: 1200 })
  })

  it('gives expression its full length however late the switch was', () => {
    /* Switched at 7:30 rather than 3:00 — four and a half minutes over, and expression still runs
       its seventeen: 450 + 1020. */
    const late = pump({ phase: 2, phaseTwoAtMinutes: 7.5 })
    expect(pumpBoundaries(late).endsAt).toBe(1470)
  })

  it('gives expression its full length when the switch was early', () => {
    /* The same statement in reverse. Pressing SWITCH NOW at 1:00 used to leave expression two
       minutes short, because the session still ended at three-plus-seventeen. */
    const early = pump({ phase: 2, phaseTwoAtMinutes: 1 })
    expect(pumpBoundaries(early).endsAt).toBe(1080)
  })

  /* A session already running when the server learned to stamp the switch has no mark to read.
     The old whole-session reading is the fallback: wrong by the overrun, but it is what that
     session was started under, and a guessed mark would be a countdown presented as a measurement. */
  it('falls back to the whole session when the switch was never marked', () => {
    expect(pumpBoundaries(pump({ phase: 2, phaseTwoAtMinutes: null })).endsAt).toBe(1200)
  })
})

describe('pump alert', () => {
  it('says nothing while stimulation is still running', () => {
    expect(pumpMomentDue(pump(), 0)).toBeNull()
    expect(pumpMomentDue(pump(), 179)).toBeNull()
  })

  it('calls the switch the moment stimulation runs out', () => {
    expect(pumpMomentDue(pump(), 180)).toBe('switch')
    /* Still due a tick later: the phase only changes when somebody presses SWITCH NOW, so the
       boundary stays crossed. Firing once is the hook's job, not this function's. */
    expect(pumpMomentDue(pump(), 181)).toBe('switch')
  })

  it('says nothing about the switch once the phase has moved on', () => {
    expect(pumpMomentDue(pump({ phase: 2 }), 200)).toBeNull()
  })

  it('calls the end of the session when expression runs out', () => {
    const switched = pump({ phase: 2, phaseTwoAtMinutes: 3 })
    expect(pumpMomentDue(switched, 1199)).toBeNull()
    expect(pumpMomentDue(switched, 1200)).toBe('done')
  })

  /* The buzz is counted from the switch too, or the household would be told the session was over
     four minutes before it was. */
  it('counts the end from the switch, not from the start', () => {
    const late = pump({ phase: 2, phaseTwoAtMinutes: 7.5 })
    expect(pumpMomentDue(late, 1200)).toBeNull()
    expect(pumpMomentDue(late, 1470)).toBe('done')
  })

  /* A paused session is not running out of anything. It buzzes after RESUME, not during. */
  it('holds its tongue while paused', () => {
    expect(pumpMomentDue(pump({ paused: true }), 600)).toBeNull()
    expect(pumpMomentDue(pump({ paused: true, phase: 2 }), 3600)).toBeNull()
  })

  /* A phase with no length has no boundary to reach. Zero would otherwise be "due immediately",
     which is a buzz at the instant of START. */
  it('needs a phase length before it will alert', () => {
    expect(pumpMomentDue(pump({ phaseOneMinutes: 0 }), 600)).toBeNull()
    expect(pumpMomentDue(pump({ phaseOneMinutes: null }), 600)).toBeNull()
    expect(pumpMomentDue(pump({ phase: 2, phaseTwoMinutes: null }), 6000)).toBeNull()
  })

  /* A held session has already ended. Buzzing about a phase running out would be announcing a
     boundary to somebody standing at the finish panel deciding on an amount. */
  it('says nothing about a session that has been finished', () => {
    const held = pump({ phase: 2, phaseTwoAtMinutes: 3, endedUtc: '2026-08-17T04:25:00Z' })
    expect(pumpMomentDue(held, 1200)).toBeNull()
    expect(pumpMomentDue(pump({ endedUtc: '2026-08-17T04:25:00Z' }), 600)).toBeNull()
  })

  /* Nursing and sleep run one clock to no fixed length. There is nothing to announce. */
  it('leaves every other type alone', () => {
    const nursing = pump({ type: 'Nursing', phase: null, phaseOneMinutes: null, phaseTwoMinutes: null })
    expect(pumpMomentDue(nursing, 99_999)).toBeNull()
    expect(pumpMomentDue(pump({ type: 'Sleep', phase: 1 }), 99_999)).toBeNull()
  })
})
