import { describe, expect, it } from 'vitest'
import { createSessionBoundary } from './sessionBoundary'

/**
 * A stale session refresh must not reopen a boundary the panel has already closed — HH-02.
 *
 * <b>These are written as the race rather than as the counter.</b> Asserting that a number goes up is
 * a test of arithmetic; what the finding is about is a flow that starts under one identity, sleeps
 * through a revocation, and then finishes by confirming the identity that was revoked. So each test
 * below is a suspended promise, a transition landing while it is suspended, and the question of what
 * happens when it is released — which is the same shape as the browser evidence the handoff asks for.
 *
 * The provider cannot be rendered in this Node harness, so the coordination is tested where it lives
 * and `SessionProvider` holds nothing but the wiring.
 */

/** A `getSession` the test releases by hand, so a transition can be made to land mid-read. */
function suspended<T>() {
  let release!: (value: T) => void
  return { promise: new Promise<T>((resolve) => { release = resolve }), release: (v: T) => release(v) }
}

describe('binding a flow to the generation it began in', () => {
  it('lets an uninterrupted flow finish', async () => {
    const boundary = createSessionBoundary()
    const read = suspended<{ profileId: number }>()

    const began = boundary.current()
    const confirmed: number[] = []
    const refresh = (async () => {
      const session = await read.promise
      if (!boundary.holds(began)) return
      confirmed.push(session.profileId)
    })()

    read.release({ profileId: 1 })
    await refresh

    expect(confirmed).toEqual([1])
  })

  /*
   * The finding itself. A refresh starts while unlocked, the panel locks, and the refresh resumes and
   * reopens the boundary from obsolete state — a private session the household has already revoked.
   */
  it('refuses a refresh that was in flight when the panel locked', async () => {
    const boundary = createSessionBoundary()
    const read = suspended<{ profileId: number }>()

    const began = boundary.current()
    const confirmed: number[] = []
    const refresh = (async () => {
      const session = await read.promise
      if (!boundary.holds(began)) return
      confirmed.push(session.profileId)
    })()

    boundary.begin() // lock
    read.release({ profileId: 1 })
    await refresh

    expect(confirmed).toEqual([])
  })

  it('refuses one that was in flight through a sign-out and a sign-in back to the same member', async () => {
    const boundary = createSessionBoundary()
    const read = suspended<{ profileId: number }>()

    const began = boundary.current()
    const confirmed: number[] = []
    const refresh = (async () => {
      const session = await read.promise
      if (!boundary.holds(began)) return
      confirmed.push(session.profileId)
    })()

    /*
     * The case a flag cannot answer and a counter can. The panel ends in the same state it started
     * in — unlocked, same member — so "is it locked now" says yes, carry on. It is still the wrong
     * answer: the cookie that authorised this read has been replaced twice, and the reply belongs to
     * a session that no longer exists.
     */
    boundary.begin() // sign out
    boundary.begin() // sign back in

    read.release({ profileId: 1 })
    await refresh

    expect(confirmed).toEqual([])
  })

  it('holds a flow to every await it makes, not merely its first', async () => {
    const boundary = createSessionBoundary()
    const first = suspended<string>()
    const second = suspended<string>()

    const began = boundary.current()
    const applied: string[] = []
    const refresh = (async () => {
      await first.promise
      if (!boundary.holds(began)) return
      applied.push('session')
      await second.promise
      // Each await is a fresh window. A guard only at the top would apply this one anyway.
      if (!boundary.holds(began)) return
      applied.push('settings')
    })()

    first.release('session')
    await Promise.resolve()
    boundary.begin() // the lock lands between the two reads
    second.release('settings')
    await refresh

    expect(applied).toEqual(['session'])
  })

  it('supersedes an earlier flow with a later one rather than the other way round', async () => {
    const boundary = createSessionBoundary()
    const stale = suspended<string>()
    const fresh = suspended<string>()

    const staleBegan = boundary.current()
    const applied: string[] = []
    const first = (async () => {
      const v = await stale.promise
      if (boundary.holds(staleBegan)) applied.push(v)
    })()

    // A transition, then the read that belongs to it.
    boundary.begin()
    const freshBegan = boundary.current()
    const second = (async () => {
      const v = await fresh.promise
      if (boundary.holds(freshBegan)) applied.push(v)
    })()

    // The stale one answers last, which is the ordering that makes this a race rather than a sequence.
    fresh.release('new identity')
    await Promise.resolve()
    stale.release('old identity')
    await Promise.all([first, second])

    expect(applied).toEqual(['new identity'])
  })
})

describe('the numbers themselves', () => {
  it('never reuses one, so a stale capture can only ever mismatch', () => {
    const boundary = createSessionBoundary()
    const seen = new Set([boundary.current()])

    for (let i = 0; i < 5; i += 1) seen.add(boundary.begin())

    expect(seen.size).toBe(6)
  })

  it('is current only for the generation running now', () => {
    const boundary = createSessionBoundary()
    const before = boundary.current()

    const after = boundary.begin()

    expect(boundary.holds(before)).toBe(false)
    expect(boundary.holds(after)).toBe(true)
  })
})
