import { describe, expect, it } from 'vitest'
import {
  APPLIED_VISIBLE_MS, HANDOFF_KEY, HANDOFF_STALE_MS,
  appliedAt, clearHandoff, outcomeOf, readHandoff, shortVersion, writeHandoff,
  type HandoffStore, type UpdateHandoff,
} from './appUpdate'

function store(seed: Record<string, string> = {}): HandoffStore & { seen: Record<string, string> } {
  const seen = { ...seed }
  return {
    seen,
    getItem: (k) => seen[k] ?? null,
    setItem: (k, v) => { seen[k] = v },
    removeItem: (k) => { delete seen[k] },
  }
}

const NOW = Date.UTC(2026, 7, 18, 12, 0, 0)

describe('shortVersion', () => {
  it('takes the commit out of a full stamp', () => {
    expect(shortVersion('3fc6323 · 2026-08-18 02:59Z')).toBe('3fc6323')
  })

  it('keeps the dirty mark, which is the part somebody will need to recognise', () => {
    expect(shortVersion('3fc6323+ · 2026-08-18 02:59Z')).toBe('3fc6323+')
  })

  it('falls back to the date when the build had no git to ask', () => {
    expect(shortVersion('2026-08-18 02:59Z')).toBe('2026-08-18')
  })
})

describe('outcomeOf', () => {
  const handoff: UpdateHandoff = { expect: 'bbb2222', from: 'aaa1111', at: NOW - 4_000 }

  it('says nothing when no update was ever pressed', () => {
    expect(outcomeOf(null, 'aaa1111', NOW)).toBeNull()
  })

  it('reports applied when the build changed', () => {
    expect(outcomeOf(handoff, 'bbb2222', NOW)).toEqual({
      status: 'applied', version: 'bbb2222', from: 'aaa1111', at: NOW - 4_000,
    })
  })

  it('reports failed when the panel came back on exactly what it left', () => {
    expect(outcomeOf(handoff, 'aaa1111', NOW)?.status).toBe('failed')
  })

  it('counts a third build that landed in between as applied, not failed', () => {
    // A second deploy between the press and the reload leaves the panel on newer code than it went
    // looking for. That is the update working, and the plate must not call it a failure.
    expect(outcomeOf(handoff, 'ccc3333', NOW)?.status).toBe('applied')
  })

  it('ignores a note that outlived its reload', () => {
    const old = { ...handoff, at: NOW - HANDOFF_STALE_MS - 1 }
    expect(outcomeOf(old, 'bbb2222', NOW)).toBeNull()
  })

  it('holds a note that is merely a slow reload old', () => {
    const slow = { ...handoff, at: NOW - HANDOFF_STALE_MS + 1_000 }
    expect(outcomeOf(slow, 'bbb2222', NOW)?.status).toBe('applied')
  })
})

describe('the handoff note', () => {
  it('round-trips', () => {
    const s = store()
    const note: UpdateHandoff = { expect: 'bbb2222', from: 'aaa1111', at: NOW }
    writeHandoff(s, note)
    expect(readHandoff(s)).toEqual(note)
    clearHandoff(s)
    expect(readHandoff(s)).toBeNull()
  })

  it('reads nothing from a device with no storage at all', () => {
    expect(readHandoff(null)).toBeNull()
  })

  it('refuses a note that is not one, rather than throwing at startup', () => {
    expect(readHandoff(store({ [HANDOFF_KEY]: 'not json' }))).toBeNull()
    expect(readHandoff(store({ [HANDOFF_KEY]: '{"expect":"b"}' }))).toBeNull()
    expect(readHandoff(store({ [HANDOFF_KEY]: '{"expect":"b","from":"a","at":"soon"}' }))).toBeNull()
  })

  it('survives storage that throws on every call', () => {
    const hostile: HandoffStore = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
      removeItem: () => { throw new Error('denied') },
    }
    expect(readHandoff(hostile)).toBeNull()
    expect(() => writeHandoff(hostile, { expect: 'b', from: 'a', at: NOW })).not.toThrow()
    expect(() => clearHandoff(hostile)).not.toThrow()
  })
})

describe('appliedAt', () => {
  it('reads as a clock the panel would say out loud — twelve-hour, zero-padded on the minutes', () => {
    const at = new Date(2026, 7, 18, 16, 57).getTime()
    expect(appliedAt(at)).toBe('4:57 PM')
    expect(appliedAt(new Date(2026, 7, 18, 9, 5).getTime())).toBe('9:05 AM')
    // Noon and midnight are the two the arithmetic gets wrong: `12 % 12` is 0.
    expect(appliedAt(new Date(2026, 7, 18, 12, 0).getTime())).toBe('12:00 PM')
    expect(appliedAt(new Date(2026, 7, 18, 0, 30).getTime())).toBe('12:30 AM')
  })
})

describe('the timings the plate depends on', () => {
  it('stands the applied plate for a few minutes, and expires a note well after that', () => {
    expect(APPLIED_VISIBLE_MS).toBeLessThan(HANDOFF_STALE_MS)
  })
})
