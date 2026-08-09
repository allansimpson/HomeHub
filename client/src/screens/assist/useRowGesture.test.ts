import { describe, expect, it } from 'vitest'
import { actionFor, commits, decideAxis } from './useRowGesture'

/**
 * The row gesture's decisions (ASSIST.md · `1f`).
 *
 * What is worth testing here is not that a pointer moves a div — it is the three judgements the
 * hook makes about what a press *meant*, because getting them wrong archives conversations for
 * people who were scrolling.
 */

/** 118px at the default root size — what the hook measures on a press. */
const PANEL = 118

describe('decideAxis', () => {
  it('decides nothing until the press has travelled far enough', () => {
    expect(decideAxis(0, 0)).toBeNull()
    expect(decideAxis(9, 9)).toBeNull()
    expect(decideAxis(-9, 4)).toBeNull()
  })

  it('claims a horizontal drag in either direction', () => {
    expect(decideAxis(14, 3)).toBe('x')
    expect(decideAxis(-14, 3)).toBe('x')
  })

  it('gives a vertical drag back to the list', () => {
    expect(decideAxis(3, 14)).toBe('y')
    expect(decideAxis(3, -14)).toBe('y')
  })

  it('gives a diagonal to the list rather than to the swipe', () => {
    // A tie is the ambiguous case, and scrolling wrongly costs nothing where archiving wrongly
    // files a conversation away.
    expect(decideAxis(20, 20)).toBe('y')
    expect(decideAxis(-20, 20)).toBe('y')
  })

  it('measures each axis independently, so a long diagonal still resolves', () => {
    // Y is past the threshold, X is not — the press is a scroll even though X is the larger of the
    // two would-be movers had both counted.
    expect(decideAxis(8, 40)).toBe('y')
  })
})

describe('commits', () => {
  it('springs back short of the threshold', () => {
    expect(commits(-30, PANEL)).toBe(false)
    expect(commits(30, PANEL)).toBe(false)
  })

  it('commits past the threshold in either direction', () => {
    expect(commits(-70, PANEL)).toBe(true)
    expect(commits(70, PANEL)).toBe(true)
  })

  it('commits exactly at the threshold', () => {
    expect(commits(PANEL * 0.55, PANEL)).toBe(true)
  })

  it('never commits before the panel has been measured', () => {
    // The panel is zero until the first press reads the root font size. Without this guard a row at
    // rest reports itself armed, and the panel would paint as though releasing would act.
    expect(commits(0, 0)).toBe(false)
    expect(commits(50, 0)).toBe(false)
  })
})

describe('actionFor', () => {
  it('maps left to archive and right to pin', () => {
    expect(actionFor(-80)).toBe('archive')
    expect(actionFor(80)).toBe('pin')
  })
})
