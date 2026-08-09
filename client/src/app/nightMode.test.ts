import { describe, expect, it } from 'vitest'
import { isWithinWindow, minutesOfDay, nextBoundary, shouldDim, toClock } from './nightMode'

/**
 * The night window, which is almost entirely about midnight.
 *
 * A dimming schedule that does not cross midnight is the unusual one, so the wrap is the main case
 * here rather than an edge. Everything takes `now` as an argument precisely so it can be tested at
 * 23:30 without waiting until 23:30.
 */

/** A local time today, so the tests read as clock times rather than as timestamps. */
const at = (hours: number, minutes = 0) => new Date(2026, 7, 6, hours, minutes, 0, 0)

describe('minutesOfDay', () => {
  it('reads the times a time input produces', () => {
    expect(minutesOfDay('00:00')).toBe(0)
    expect(minutesOfDay('21:30')).toBe(21 * 60 + 30)
    expect(minutesOfDay('9:05')).toBe(9 * 60 + 5)
  })

  it('refuses what is not a time, rather than guessing at it', () => {
    // "" is what a time input reports mid-edit, while somebody is retyping the hour.
    expect(minutesOfDay('')).toBeNull()
    expect(minutesOfDay('24:00')).toBeNull()
    expect(minutesOfDay('21:60')).toBeNull()
    expect(minutesOfDay('half nine')).toBeNull()
  })
})

describe('isWithinWindow', () => {
  it('covers a window that crosses midnight, which is the ordinary case', () => {
    expect(isWithinWindow(at(21, 0), '21:00', '07:00')).toBe(true)
    expect(isWithinWindow(at(23, 59), '21:00', '07:00')).toBe(true)
    expect(isWithinWindow(at(3, 0), '21:00', '07:00')).toBe(true)
    expect(isWithinWindow(at(6, 59), '21:00', '07:00')).toBe(true)
    expect(isWithinWindow(at(7, 0), '21:00', '07:00')).toBe(false)
    expect(isWithinWindow(at(20, 59), '21:00', '07:00')).toBe(false)
  })

  it('covers a window inside one day', () => {
    expect(isWithinWindow(at(13, 0), '12:00', '14:00')).toBe(true)
    expect(isWithinWindow(at(11, 59), '12:00', '14:00')).toBe(false)
    expect(isWithinWindow(at(14, 0), '12:00', '14:00')).toBe(false)
  })

  /**
   * Both readings of an equal start and end are defensible, and only one of them can strand
   * somebody with a permanently dark panel and no obvious way back.
   */
  it('treats an equal start and end as an empty window, never a full day', () => {
    expect(isWithinWindow(at(3, 0), '00:00', '00:00')).toBe(false)
    expect(isWithinWindow(at(22, 0), '22:00', '22:00')).toBe(false)
  })

  it('dims nothing when the window is unreadable', () => {
    // A dark screen from a malformed setting is a fault report waiting to happen; normal brightness
    // is the state that needs no explanation.
    expect(isWithinWindow(at(23, 0), '', '07:00')).toBe(false)
    expect(isWithinWindow(at(23, 0), '21:00', 'nope')).toBe(false)
  })
})

describe('nextBoundary', () => {
  it('finds the end of the window from inside it', () => {
    expect(toClock(nextBoundary(at(23, 0), '21:00', '07:00')!)).toBe('07:00')
  })

  it('finds the start of the window from outside it', () => {
    expect(toClock(nextBoundary(at(12, 0), '21:00', '07:00')!)).toBe('21:00')
  })

  it('rolls into tomorrow rather than returning a time already past', () => {
    const boundary = nextBoundary(at(23, 0), '21:00', '07:00')!
    expect(boundary.getTime()).toBeGreaterThan(at(23, 0).getTime())
    expect(boundary.getDate()).toBe(at(23, 0).getDate() + 1)
  })

  /** Otherwise an override set exactly on the hour would expire the instant it was set. */
  it('is strictly after now when a boundary lands on this very minute', () => {
    expect(toClock(nextBoundary(at(21, 0), '21:00', '07:00')!)).toBe('07:00')
  })

  it('has no boundary when there is no usable window', () => {
    expect(nextBoundary(at(23, 0), '22:00', '22:00')).toBeNull()
    expect(nextBoundary(at(23, 0), '', '07:00')).toBeNull()
  })
})

describe('shouldDim', () => {
  const window = { enabled: true, start: '21:00', end: '07:00' }

  it('follows the schedule when nothing is arguing with it', () => {
    expect(shouldDim(at(23, 0), window, null)).toBe(true)
    expect(shouldDim(at(12, 0), window, null)).toBe(false)
  })

  it('never dims by itself when the schedule is off', () => {
    expect(shouldDim(at(23, 0), { ...window, enabled: false }, null)).toBe(false)
  })

  /** The whole point of the override: brightness now, without giving up the schedule. */
  it('lets a live override win against the schedule in both directions', () => {
    const live = { dim: false, untilMs: at(23, 30).getTime() }
    expect(shouldDim(at(23, 0), window, live)).toBe(false)

    const early = { dim: true, untilMs: at(21, 0).getTime() }
    expect(shouldDim(at(20, 0), window, early)).toBe(true)
  })

  it('ignores a spent override rather than needing it swept up', () => {
    // Expiring by being read is what makes a missed tick harmless — there is no timer to miss.
    const spent = { dim: false, untilMs: at(22, 0).getTime() }
    expect(shouldDim(at(23, 0), window, spent)).toBe(true)
  })

  it('still overrides a schedule that is switched off', () => {
    const live = { dim: true, untilMs: Number.POSITIVE_INFINITY }
    expect(shouldDim(at(12, 0), { ...window, enabled: false }, live)).toBe(true)
  })
})
