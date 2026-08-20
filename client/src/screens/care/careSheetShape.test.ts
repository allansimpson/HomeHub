import { describe, expect, it } from 'vitest'
import { SHAPES } from './CareSheet'
import { CARE_TILES, TIMED_TYPES } from '../../app/care'

/**
 * The two lists that have to agree with each other.
 *
 * `TIMED_TYPES` decides that saving with no duration opens a session instead of writing a row.
 * `SHAPES` decides whether the panel has anything to press to open one. Sleep sat in the first list
 * and had no affordance in the second for the whole life of the care log: the tile advertised
 * `TIMER`, the sheet offered a stepper and a SAVE, and the session could not be started at all.
 *
 * Neither half looks wrong on its own, which is why reading the code did not catch it and why this
 * is a test rather than a comment.
 */

/** The three ways a panel can begin a session: nursing's sides, pump's phases, a plain stopwatch. */
const STARTS = ['timer', 'phases', 'stopwatch'] as const

describe('sheet shapes', () => {
  it('gives every timed type a way to start one', () => {
    for (const type of TIMED_TYPES) {
      const shape = SHAPES[type]
      expect(shape, `${type} has no sheet shape`).toBeDefined()
      expect(
        STARTS.some((flag) => shape?.[flag]),
        `${type} is in TIMED_TYPES but its sheet offers no way to start a session`,
      ).toBe(true)
    }
  })

  /* The inverse, so a start button cannot appear on a panel whose save writes a row instead. */
  it('offers a start only on a timed type', () => {
    for (const type of CARE_TILES) {
      const shape = SHAPES[type]
      if (!shape || !STARTS.some((flag) => shape[flag])) continue
      expect(TIMED_TYPES, `${type} offers a start but is not a timed type`).toContain(type)
    }
  })

  /* Sleep and tummy time are the plain ones — no side to choose, no phases to set. */
  it('starts sleep and tummy time as plain stopwatches', () => {
    expect(SHAPES.Sleep?.stopwatch).toBe(true)
    expect(SHAPES.TummyTime?.stopwatch).toBe(true)
    expect(SHAPES.Sleep?.timer).toBeUndefined()
    expect(SHAPES.Sleep?.phases).toBeUndefined()
  })

  /* Nursing and pump keep the affordances their sessions actually need. */
  it('leaves nursing and pump on their own starts', () => {
    expect(SHAPES.Nursing?.timer).toBe(true)
    expect(SHAPES.Pump?.phases).toBe(true)
  })
})
