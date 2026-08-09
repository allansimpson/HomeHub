import { describe, expect, it } from 'vitest'
import type { ClimateZoneDto } from '../../api/types'
import { duration, loopLine, range, reading, rowState, zoneStatus } from './climateCopy'

/**
 * The section's vocabulary, tested as copy.
 *
 * Every sentence here is locked design text with a colour attached, and both halves matter: a
 * `cantHold` line that reads correctly in verdigris is still wrong, because the tone is what says
 * whether the loop has the room. Testing the strings and the tones together is the only way the
 * pairing survives an edit.
 */

const NOW = new Date('2026-08-03T17:00:00Z').getTime()

function zone(over: Partial<ClimateZoneDto> = {}): ClimateZoneDto {
  return {
    id: 2,
    name: 'Master Bedroom',
    class: 'Automated',
    readingF: 74.6,
    humidity: 46,
    readingAtUtc: '2026-08-03T16:59:00Z',
    probeSilentMinutes: null,
    standingTargetF: 71,
    standingSetAtUtc: null,
    targetF: 71,
    toleranceF: 1,
    correction: 'Steady',
    quietFrom: '22:00',
    quietTo: '06:00',
    isPaused: false,
    pausedAtUtc: null,
    override: null,
    previousStandingTargetF: null,
    state: 'holding',
    steadySinceUtc: null,
    etaLocal: null,
    above: true,
    deviationF: null,
    outsideMinutes: null,
    unreachableSinceUtc: null,
    degraded: false,
    overrideEndedAtUtc: null,
    lowBattery: false,
    rangeLowF: null,
    rangeHighF: null,
    outOfRangeMinutes: null,
    ratePerHour: null,
    unitSetPointF: 68,
    unitMode: 'Cool',
    probeRef: 'sim-bedroom',
    unitRef: 'climate.master_bedroom',
    sensorZoneId: 5,
    lastWrite: null,
    ...over,
  }
}

describe('duration', () => {
  it('reads in hours and minutes, and never as zero', () => {
    expect(duration(200 * 60_000)).toBe('3H 20M')
    expect(duration(40 * 60_000)).toBe('40M')
    expect(duration(120 * 60_000)).toBe('2H')
    // Under a minute is still a minute: "STEADY 0M" says the loop just failed at something.
    expect(duration(10_000)).toBe('1M')
  })
})

describe('reading', () => {
  it('keeps a tenth in a room and drops it in an appliance', () => {
    expect(reading(71.84, true)).toBe('71.8°')
    expect(reading(37.4, false)).toBe('37°')
  })

  // A temperature without a fresh timestamp is a lie told confidently.
  it('renders a dash when there is nothing fresh to show', () => {
    expect(reading(null, true)).toBe('—')
  })
})

describe('range', () => {
  it('uses a minus sign rather than a hyphen below zero', () => {
    expect(range(34, 40)).toBe('34–40°')
    expect(range(-5, 5)).toBe('−5–5°')
  })
})

describe('zoneStatus', () => {
  it('speaks in verdigris while it has the room', () => {
    const s = zoneStatus(zone({ steadySinceUtc: '2026-08-03T13:40:00Z' }), 'holding', NOW)
    expect(s.text).toBe('HOLDING · STEADY 3H 20M')
    expect(s.tone).toBe('live')
  })

  // "PULLING DOWN" is what the loop is doing to the room — not what the set point is doing.
  it('names the direction it is pulling, and omits an estimate it does not have', () => {
    expect(zoneStatus(zone({ etaLocal: '5:24' }), 'correcting', NOW).text)
      .toBe('PULLING DOWN · 71° NEAR 5:24')
    expect(zoneStatus(zone({ etaLocal: null }), 'correcting', NOW).text).toBe('PULLING DOWN')
    expect(zoneStatus(zone({ above: false, etaLocal: '5:24' }), 'correcting', NOW).text)
      .toBe('PULLING UP · 71° NEAR 5:24')
  })

  it('goes amber when it has run out of room', () => {
    const s = zoneStatus(zone({ deviationF: 4, outsideMinutes: 40 }), 'cantHold', NOW)
    expect(s.text).toBe("CAN'T HOLD · 4° OVER FOR 40M")
    expect(s.tone).toBe('alert')
  })

  it('states what a loan borrowed and when it goes back', () => {
    const s = zoneStatus(
      zone({ override: { targetF: 69, startedAtUtc: '2026-08-03T17:04:00Z', expiresAtUtc: '2026-08-03T19:04:00Z' } }),
      'borrowed', NOW,
    )
    expect(s.text).toMatch(/^BORROWED 69° · BACK TO 71° AT \d{1,2}:\d{2}$/)
    expect(s.tone).toBe('brass')
  })

  /*
   * The handoff's one internal contradiction: CLIMATE_SCREEN §5a gives 3a's outcome without a way
   * back, while CLIMATE_BEHAVIOURS §6 says both promotion paths land here *and* keep UNDO. Resolved
   * toward the exit — a permanent change hidden in a gesture has to have one.
   */
  it('offers the way out after a promotion', () => {
    const s = zoneStatus(
      zone({ standingTargetF: 69, standingSetAtUtc: '2026-08-03T17:06:00Z', previousStandingTargetF: 71 }),
      'standing', NOW,
    )
    expect(s.text).toMatch(/^STANDING 69° SINCE \d{1,2}:\d{2}$/)
    expect(s.undo).toBe(true)
  })

  it('says the room is on its own sensor, in terracotta', () => {
    const s = zoneStatus(zone({ readingF: null, probeSilentMinutes: 22 }), 'probeLost', NOW)
    expect(s.text).toBe('PROBE SILENT 22M · UNIT ON ITS OWN SENSOR')
    expect(s.tone).toBe('danger')
  })

  // A probe that has never reported has no "how long", and "SILENT 1M" would misdescribe a room that
  // has been unread since the panel was installed.
  it('drops the duration when there has never been a reading', () => {
    const s = zoneStatus(zone({ readingF: null, probeSilentMinutes: null }), 'probeLost', NOW)
    expect(s.text).toBe('PROBE SILENT · UNIT ON ITS OWN SENSOR')
  })

  it('says what a paused room was left at', () => {
    const s = zoneStatus(zone({ isPaused: true, pausedAtUtc: '2026-08-03T16:00:00Z' }), 'paused', NOW)
    expect(s.text).toBe('PAUSED 1H AGO · UNIT LEFT AT 68°')
    expect(s.tone).toBe('muted')
  })

  it('says when the machine will start talking again', () => {
    expect(zoneStatus(zone(), 'quiet', NOW).text).toBe('QUIET · NO CHANGES UNTIL 6:00 AM')
  })

  it('tells a warm freezer apart from a warming one', () => {
    const climbing = zoneStatus(
      zone({ class: 'ColdStorage', readingF: 12, rangeLowF: -5, rangeHighF: 5, outOfRangeMinutes: 35, ratePerHour: 1.2 }),
      'outOfRange', NOW,
    )
    expect(climbing.text).toBe('ABOVE RANGE 35M · RISING 1.2°/H')
    expect(climbing.tone).toBe('danger')

    // Under 0.4°/h the server sends no rate, and the clause simply is not drawn.
    const stable = zoneStatus(
      zone({ class: 'ColdStorage', readingF: 12, rangeLowF: -5, rangeHighF: 5, outOfRangeMinutes: 35, ratePerHour: null }),
      'outOfRange', NOW,
    )
    expect(stable.text).toBe('ABOVE RANGE 35M')
  })
})

describe('loopLine', () => {
  const room = (over: Partial<ClimateZoneDto>) => zone(over)

  it('gives the instruction when nothing is out of the ordinary', () => {
    const line = loopLine([room({ state: 'holding' })], false, null)
    expect(line.lead).toBe('LOOP RUNNING')
    expect(line.clause).toBe('· PRESS A ROOM TO BORROW IT')
  })

  // Never a count of rooms that are fine — the clause states the one thing that is not ordinary.
  it('names the exception rather than the healthy rooms', () => {
    const line = loopLine([room({ state: 'probeLost' }), room({ id: 3, state: 'holding' })], false, null)
    expect(line.clause).toBe('· 1 ROOM ON ITS OWN SENSOR')
  })

  it('says the house is paused, in amber', () => {
    const line = loopLine([room({ state: 'paused' })], true, null)
    expect(line.lead).toBe('LOOP PAUSED')
    expect(line.leadTone).toBe('alert')
    expect(line.clause).toBe('· NO ROOM IS BEING HELD')
  })

  it('goes quiet only when every room that can be held is', () => {
    expect(loopLine([room({ state: 'quiet' })], false, null).lead).toBe('LOOP QUIET')
    // One bedroom on a different schedule is a row's business, not the section's.
    expect(loopLine([room({ state: 'quiet' }), room({ id: 3, state: 'holding' })], false, null).lead)
      .toBe('LOOP RUNNING')
  })

  it('appends its own age when the panel has stopped hearing back', () => {
    const line = loopLine([room({ state: 'holding' })], false, 4)
    expect(line.clause).toBe('· LAST HEARD 4 MIN AGO')
    expect(line.clauseTone).toBe('alert')
  })
})

describe('rowState', () => {
  it('raises `standing` only for a promotion this session with something to restore', () => {
    const promoted = zone({ previousStandingTargetF: 71 })
    expect(rowState(promoted, new Set([2]))).toBe('standing')
    // A different panel, or a reload: the house state is unchanged and the row goes back to plain.
    expect(rowState(promoted, new Set())).toBe('holding')
    // Nothing to restore means nothing to undo, so there is no state to raise.
    expect(rowState(zone({ previousStandingTargetF: null }), new Set([2]))).toBe('holding')
  })

  it('never overrides a state that means the loop has stopped', () => {
    const lost = zone({ state: 'probeLost', previousStandingTargetF: 71 })
    expect(rowState(lost, new Set([2]))).toBe('probeLost')
  })
})
