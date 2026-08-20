import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_ATTEMPTS, canExecuteQueuedOp, executeDurably, isRetryable, keepMine, persistAhead,
  queueForProfile, removeOp, replayQueue, setQueueIdentity, updateOp,
} from './writeQueue'
import type { DroppedOp, QueueStore, QueuedOp } from './writeQueue'

const op = (id: string, ownerProfileId?: number, extra: Partial<QueuedOp> = {}): QueuedOp => ({
  id,
  ownerProfileId,
  domain: 'task',
  method: 'POST',
  path: '/tasks',
  label: id,
  createdAt: 1,
  ...extra,
} as QueuedOp)

/** The durable side, in memory — same contract as localStorage, no DOM required. */
function memStore(initial: QueuedOp[] = []): QueueStore & { ops: QueuedOp[]; gone: DroppedOp[] } {
  let ops = [...initial]
  let gone: DroppedOp[] = []
  return {
    read: () => [...ops],
    write: (next) => { ops = [...next] },
    readDropped: () => [...gone],
    writeDropped: (next) => { gone = [...next] },
    get ops() { return ops },
    get gone() { return gone },
  }
}

type Reply = { status: number; body?: unknown; network?: false } | { network: true }

/** Answers requests in order, recording the paths asked for. */
function stubFetch(replies: Reply[]): { paths: string[] } {
  const paths: string[] = []
  let i = 0
  vi.stubGlobal('fetch', async (url: string) => {
    paths.push(url)
    const reply = replies[Math.min(i++, replies.length - 1)]
    if ('network' in reply && reply.network) throw new Error('offline')
    const { status, body } = reply as { status: number; body?: unknown }
    const text = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body)
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: `status ${status}`,
      text: async () => text,
      json: async () => JSON.parse(text) as unknown,
    } as unknown as Response
  })
  return { paths }
}

afterEach(() => {
  vi.unstubAllGlobals()
  setQueueIdentity(null)
})

describe('offline queue identity boundary', () => {
  it('returns only operations created by the authenticated profile', () => {
    const queued = [op('mine', 2), op('theirs', 3)]

    expect(queueForProfile(queued, 2).map((item) => item.id)).toEqual(['mine'])
  })

  it('quarantines legacy unowned operations and exposes nothing while signed out', () => {
    const queued = [op('legacy'), op('mine', 2)]

    expect(queueForProfile(queued, 2).map((item) => item.id)).toEqual(['mine'])
    expect(queueForProfile(queued, null)).toEqual([])
  })

  it('closes execution before a profile transition can change the session cookie', () => {
    const mine = op('mine', 2)
    setQueueIdentity(2)
    expect(canExecuteQueuedOp(mine)).toBe(true)

    setQueueIdentity(null)
    expect(canExecuteQueuedOp(mine)).toBe(false)
  })

  it('refuses to persist another profile\'s operation into this store', async () => {
    const store = memStore()
    setQueueIdentity(2)
    stubFetch([{ status: 200 }])

    const { outcome, settled } = await executeDurably(store, op('theirs', 3))

    expect(outcome).toMatchObject({ kind: 'error', status: 401 })
    expect(settled).toBe(false)
    expect(store.ops).toEqual([])
  })
})

describe('durable storage rules', () => {
  it('upserts in place so a re-persist keeps its position in the queue', () => {
    const store = memStore([op('a', 2), op('b', 2), op('c', 2)])

    persistAhead(store, op('b', 2, { label: 'amended' }))

    expect(store.ops.map((o) => o.id)).toEqual(['a', 'b', 'c'])
    expect(store.ops[1].label).toBe('amended')
  })

  it('appends an operation it has not seen before', () => {
    const store = memStore([op('a', 2)])

    persistAhead(store, op('b', 2))

    expect(store.ops.map((o) => o.id)).toEqual(['a', 'b'])
  })

  it('re-reads before removing, so a concurrent enqueue is not overwritten', () => {
    const store = memStore([op('a', 2)])
    persistAhead(store, op('b', 2))

    removeOp(store, 'a')

    expect(store.ops.map((o) => o.id)).toEqual(['b'])
  })

  it('reports whether there was an operation to amend', () => {
    const store = memStore([op('a', 2)])

    expect(updateOp(store, 'a', { label: 'new' })).toBe(true)
    expect(updateOp(store, 'missing', { label: 'new' })).toBe(false)
    expect(store.ops[0].label).toBe('new')
  })
})

describe('write-ahead execution', () => {
  it('persists the operation before the request goes out', async () => {
    const store = memStore()
    setQueueIdentity(2)
    let durableMidFlight: string[] = []
    vi.stubGlobal('fetch', async () => {
      durableMidFlight = store.read().map((o) => o.id)
      return { ok: true, status: 200, statusText: 'OK', text: async () => '' } as unknown as Response
    })

    await executeDurably(store, op('a', 2))

    expect(durableMidFlight).toEqual(['a'])
  })

  it('removes an operation only once the server has answered', async () => {
    const store = memStore()
    setQueueIdentity(2)
    stubFetch([{ status: 200 }])

    const { outcome, settled } = await executeDurably(store, op('a', 2))

    expect(outcome.kind).toBe('ok')
    expect(settled).toBe(true)
    expect(store.ops).toEqual([])
  })

  it('treats a vanished row as terminal', async () => {
    const store = memStore()
    setQueueIdentity(2)
    stubFetch([{ status: 404 }])

    const { outcome, settled } = await executeDurably(store, op('a', 2))

    expect(outcome.kind).toBe('gone')
    expect(settled).toBe(true)
    expect(store.ops).toEqual([])
  })

  it('retains an offline write exactly once, without charging the retry budget', async () => {
    const store = memStore()
    setQueueIdentity(2)
    stubFetch([{ network: true }])

    const { outcome, settled } = await executeDurably(store, op('a', 2))

    expect(outcome.kind).toBe('offline')
    expect(settled).toBe(false)
    expect(store.ops.map((o) => o.id)).toEqual(['a'])
    expect(store.ops[0].attempts).toBeUndefined()
  })

  it('persists a conflict with the server value so a reload keeps the question', async () => {
    const store = memStore()
    setQueueIdentity(2)
    stubFetch([{ status: 409, body: { id: 5, version: 9 } }])

    const { outcome, settled } = await executeDurably(store, op('a', 2, { baseVersion: 3 }))

    expect(outcome).toMatchObject({ kind: 'conflict' })
    expect(settled).toBe(false)
    expect(store.ops[0].conflict?.current).toEqual({ id: 5, version: 9 })
  })
})

describe('error policy', () => {
  it('classifies transient statuses as retryable and deterministic ones as terminal', () => {
    expect([408, 429, 500, 502, 503].every(isRetryable)).toBe(true)
    expect([400, 401, 403, 422].some(isRetryable)).toBe(false)
  })

  it('sets a deterministic refusal aside, carrying the server\'s own sentence', async () => {
    const store = memStore()
    setQueueIdentity(2)
    stubFetch([{ status: 400, body: 'That barcode already belongs to Olive oil.' }])

    const { settled, dropped } = await executeDurably(store, op('a', 2))

    expect(settled).toBe(true)
    expect(store.ops).toEqual([])
    expect(dropped).toMatchObject({
      reason: 'rejected', message: 'That barcode already belongs to Olive oil.',
    })
    expect(store.gone).toHaveLength(1)
  })

  it('retries a transient failure under a bound, then sets it aside', async () => {
    const store = memStore()
    setQueueIdentity(2)
    stubFetch([{ status: 503 }])

    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const { settled } = await executeDurably(store, store.read()[0] ?? op('a', 2))
      expect(settled).toBe(false)
      expect(store.ops[0].attempts).toBe(i)
    }

    const { settled, dropped } = await executeDurably(store, store.read()[0])

    expect(settled).toBe(true)
    expect(dropped?.reason).toBe('retry-exhausted')
    expect(store.ops).toEqual([])
  })
})

describe('replay', () => {
  it('re-reads storage each turn, so work queued mid-replay is not erased', async () => {
    const store = memStore([op('a', 2)])
    setQueueIdentity(2)
    let queuedDuringFlight = false
    vi.stubGlobal('fetch', async () => {
      if (!queuedDuringFlight) {
        // Somebody taps something else while the first replayed write is in the air.
        persistAhead(store, op('b', 2))
        queuedDuringFlight = true
      }
      return { ok: true, status: 200, statusText: 'OK', text: async () => '' } as unknown as Response
    })

    const result = await replayQueue(store, 2)

    expect(result.changed).toBe(true)
    expect(store.ops).toEqual([])
  })

  it('does not let one refused write hold every write behind it', async () => {
    const store = memStore([op('bad', 2), op('good', 2, { path: '/tasks/9' })])
    setQueueIdentity(2)
    const { paths } = stubFetch([{ status: 400, body: 'no' }, { status: 200 }])

    const result = await replayQueue(store, 2)

    expect(paths).toEqual(['/api/tasks', '/api/tasks/9'])
    expect(result.dropped.map((d) => d.id)).toEqual(['bad'])
    expect(store.ops).toEqual([])
  })

  it('stops at the network boundary and keeps the rest queued', async () => {
    const store = memStore([op('a', 2), op('b', 2)])
    setQueueIdentity(2)
    stubFetch([{ network: true }])

    const result = await replayQueue(store, 2)

    expect(result.stoppedOffline).toBe(true)
    expect(store.ops.map((o) => o.id)).toEqual(['a', 'b'])
  })

  it('steps over a conflict rather than deciding it', async () => {
    const store = memStore([
      op('held', 2, { conflict: { current: {}, at: 1 } }),
      op('next', 2, { path: '/tasks/9' }),
    ])
    setQueueIdentity(2)
    const { paths } = stubFetch([{ status: 200 }])

    await replayQueue(store, 2)

    expect(paths).toEqual(['/api/tasks/9'])
    expect(store.ops.map((o) => o.id)).toEqual(['held'])
  })

  it('sets legacy unowned records aside and never sends them', async () => {
    const store = memStore([op('legacy'), op('mine', 2)])
    setQueueIdentity(2)
    const { paths } = stubFetch([{ status: 200 }])

    const result = await replayQueue(store, 2)

    expect(paths).toEqual(['/api/tasks'])
    expect(result.dropped).toMatchObject([{ id: 'legacy', reason: 'legacy-orphaned' }])
    expect(store.ops).toEqual([])
  })

  it('leaves another profile\'s queued work untouched', async () => {
    const store = memStore([op('theirs', 3), op('mine', 2)])
    setQueueIdentity(2)
    stubFetch([{ status: 200 }])

    await replayQueue(store, 2)

    expect(store.ops.map((o) => o.id)).toEqual(['theirs'])
  })
})

describe('keep-mine', () => {
  it('clears the version so the resolution is not asked about twice', () => {
    const forced = keepMine(op('a', 2, {
      baseVersion: 3, conflict: { current: {}, at: 1 }, attempts: 2,
    }))

    expect(forced.baseVersion).toBeUndefined()
    expect(forced.conflict).toBeUndefined()
    expect(forced.attempts).toBe(0)
  })

  it('survives being chosen while offline instead of vanishing', async () => {
    const store = memStore([op('a', 2, { baseVersion: 3, conflict: { current: {}, at: 1 } })])
    setQueueIdentity(2)
    stubFetch([{ network: true }])

    const forced = keepMine(store.read()[0])
    persistAhead(store, forced)
    const { outcome } = await executeDurably(store, forced)

    expect(outcome.kind).toBe('offline')
    expect(store.ops).toHaveLength(1)
    expect(store.ops[0].conflict).toBeUndefined()
    expect(store.ops[0].baseVersion).toBeUndefined()
  })
})
