import { describe, expect, it } from 'vitest'
import { NEVER, RETENTION_OPTIONS, retentionLabel } from './assistPrefs'

/**
 * The retention windows Config offers, and how they read.
 *
 * Worth pinning because the value that means "never" is `0`, and a `0` in a field called *days* is
 * one careless render away from saying the opposite of what it means. The chip, the Config index's
 * meta line and the sweep all have to agree that it is a policy rather than an absence.
 */
describe('retentionLabel', () => {
  it('names a window in days', () => {
    expect(retentionLabel(7)).toBe('7 days')
    expect(retentionLabel(30)).toBe('30 days')
  })

  it('names the never window in words, not as a zero', () => {
    expect(retentionLabel(NEVER)).toBe('Never')
  })

  /** Defensive: a negative can only arrive from a corrupted row, and it is still not "-3 days". */
  it('reads anything at or below zero as never', () => {
    expect(retentionLabel(-3)).toBe('Never')
  })
})

describe('RETENTION_OPTIONS', () => {
  it('offers never as the far end of the same scale', () => {
    // Last, and only once: NEVER is where the windows run out, not a separate kind of answer, and
    // the chip row is ordered so it reads that way.
    expect(RETENTION_OPTIONS[RETENTION_OPTIONS.length - 1]).toBe(NEVER)
    expect(RETENTION_OPTIONS.filter((d) => d === NEVER)).toHaveLength(1)
  })

  it('keeps every other window a real number of days', () => {
    // A second zero would be indistinguishable from NEVER on the server, where the sweep reads the
    // number and nothing else.
    expect(RETENTION_OPTIONS.slice(0, -1).every((d) => d > 0)).toBe(true)
  })
})
