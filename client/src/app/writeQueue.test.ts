import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { armSessionLostNotice, setPrivateNetworkConfirmed } from '../api/privateNetwork'
import {
  MAX_ATTEMPTS, canExecuteQueuedOp, closeQueueExecution, executeDurably, isPrivateDomain, isRetryable,
  keepMine, persistAhead, queueForProfile, removeOp, replayQueue, setQueueIdentity, updateOp,
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

beforeEach(() => {
  // These cover durability, retry and drain — all of which happen *after* the identity boundary — so
  // the boundary is opened for them. Left shut they never reach `fetch` at all, which is the boundary
  // working and would make every assertion below pass for the wrong reason.
  setPrivateNetworkConfirmed(true)
})

afterEach(() => {
  // Shut again between tests. A fresh panel is unconfirmed, and a test that leaked it open would
  // hide exactly the regression the boundary exists to catch.
  setPrivateNetworkConfirmed(false)
})

/**
 * The durable side, in memory — same contract as the sealed store, no DOM required.
 *
 * `refuse` makes the flush reject, which is how a store that cannot persist reports itself now that
 * sealing is asynchronous. It used to be a synchronous throw out of `localStorage.setItem`.
 */
function memStore(
  initial: QueuedOp[] = [], refuse = false,
): QueueStore & { ops: QueuedOp[]; gone: DroppedOp[] } {
  let ops = [...initial]
  let gone: DroppedOp[] = []
  return {
    read: () => [...ops],
    write: (next) => { ops = [...next] },
    readDropped: () => [...gone],
    writeDropped: (next) => { gone = [...next] },
    flush: () => refuse
      ? Promise.reject(new Error('The offline write could not be persisted.'))
      : Promise.resolve(),
    get ops() { return ops },
    get gone() { return gone },
  }
}

type Reply =
  | { status: number; body?: unknown; headers?: Record<string, string>; network?: false }
  | { network: true }

/** Answers requests in order, recording the paths asked for. */
function stubFetch(replies: Reply[]): { paths: string[] } {
  const paths: string[] = []
  let i = 0
  vi.stubGlobal('fetch', async (url: string) => {
    paths.push(url)
    const reply = replies[Math.min(i++, replies.length - 1)]
    if ('network' in reply && reply.network) throw new Error('offline')
    const { status, body, headers } = reply as {
      status: number; body?: unknown; headers?: Record<string, string>
    }
    const text = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body)
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: `status ${status}`,
      // Read by the transport to tell a refused credential from a lost session — see
      // `privateNetwork.noteAuthenticatedResponse`.
      headers: new Headers(headers ?? {}),
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

/**
 * Which domains may be carried on the device in the clear — HH-04.
 *
 * An allowlist rather than a list of private domains, and the direction is the whole of it: a domain
 * added later is private until somebody writes it down and says why. `care` was the domain that made
 * this matter, and it is the one that must never appear in it.
 */
describe('the plaintext allowlist', () => {
  it('treats care as private and the household-shared domains as not', () => {
    expect(isPrivateDomain('care')).toBe(true)
    for (const domain of ['task', 'calendar', 'climate', 'meal', 'recipe', 'pantry', 'grocery'] as const) {
      expect(isPrivateDomain(domain)).toBe(false)
    }
  })
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

  it('aborts and drains an in-flight durable request before a profile transition continues', async () => {
    const store = memStore()
    const mine = op('mine', 2)
    let requestSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      requestSignal = init?.signal ?? undefined
      requestSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })))
    setQueueIdentity(2)

    const sending = executeDurably(store, mine)
    await Promise.resolve()
    expect(store.ops.map((item) => item.id)).toEqual(['mine'])

    const closing = closeQueueExecution()
    expect(requestSignal?.aborted).toBe(true)
    await expect(sending).resolves.toMatchObject({ outcome: { kind: 'cancelled' }, settled: false })
    await expect(closing).resolves.toBeUndefined()
    expect(store.ops.map((item) => item.id)).toEqual(['mine'])
  })

  /*
   * A send with no end kept `run` from returning, and every screen awaiting it kept its controls
   * disabled for as long as the socket stayed open — which on a phone with no route to the server
   * is until the OS gives up, or never. The op is durable before the fetch starts, so the honest
   * end to that wait is to call it offline and leave it queued.
   */
  it('gives up on a send that is never answered, and keeps the op queued', async () => {
    vi.useFakeTimers()
    try {
      const store = memStore()
      vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })))
      setQueueIdentity(2)

      const sending = executeDurably(store, op('unanswered', 2))
      await vi.advanceTimersByTimeAsync(19_000)
      expect(store.ops.map((item) => item.id)).toEqual(['unanswered'])

      await vi.advanceTimersByTimeAsync(2_000)
      // `offline`, not `cancelled`: a deadline is a server that is not there, and a cancellation is
      // a profile transition. Both retain the op; only one of them is what happened.
      await expect(sending).resolves.toMatchObject({ outcome: { kind: 'offline' }, settled: false })
      expect(store.ops.map((item) => item.id)).toEqual(['unanswered'])
    } finally {
      vi.useRealTimers()
    }
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
  /*
   * A store that cannot persist must say so rather than let the write look queued.
   *
   * The refusal used to be a synchronous throw out of `localStorage.setItem`. Sealing the queue made
   * persistence asynchronous, so it is a rejected flush now — and `executeDurably` awaits that flush
   * before its fetch, which is where the write-ahead invariant now lives. The failure this prevents is
   * unchanged: a caller told its change is safely queued when nothing reached the device.
   */
  it('does not send, or report durability, when the store cannot persist the write', async () => {
    const store = memStore([], true)
    setQueueIdentity(2)
    const sent = vi.fn()
    vi.stubGlobal('fetch', sent)

    await expect(executeDurably(store, op('a', 2))).rejects.toThrow(/persist/i)
    expect(sent).not.toHaveBeenCalled()
  })

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

  /*
   * HH-03. A 401 used to fall through to the terminal branch — a 4xx describes the request, so the
   * request was discarded — and that reasoning is wrong for exactly this status.
   *
   * It says nothing about the operation and everything about the session carrying it. The write is
   * good and will land the moment its owner is confirmed again, so setting it aside punished the
   * household for a session timeout by deleting the entry they had made.
   */
  it('retains a write refused for the session rather than setting it aside', async () => {
    const store = memStore()
    setQueueIdentity(2)
    vi.stubGlobal('window', new EventTarget())
    stubFetch([{ status: 401 }])

    const { outcome, settled, dropped } = await executeDurably(store, op('a', 2))

    expect(outcome).toMatchObject({ kind: 'error', status: 401 })
    expect(settled).toBe(false)
    expect(dropped).toBeUndefined()
    expect(store.ops.map((o) => o.id)).toEqual(['a'])
    expect(store.gone).toEqual([])
  })

  /*
   * The other half of HH-03: a queued replay is one of the five authenticated transports, and it was
   * the one that never announced a lost session. An expired cookie first discovered here produced an
   * ordinary error, the pass broke out of its loop, and the panel stayed unlocked with the
   * household's private screens mounted behind no session at all.
   */
  it('announces the lost session when a replay is the first call to find out', async () => {
    const store = memStore([op('a', 2), op('b', 2)])
    setQueueIdentity(2)
    const target = new EventTarget()
    vi.stubGlobal('window', target)
    const seen: Event[] = []
    target.addEventListener('homehub:session-lost', (e) => seen.push(e))
    armSessionLostNotice()
    const { paths } = stubFetch([{ status: 401 }])

    const result = await replayQueue(store, 2)

    expect(seen).toHaveLength(1)
    // Stopped rather than ground against a cookie that is no longer this profile's, and nothing lost.
    expect(paths).toHaveLength(1)
    expect(result.dropped).toEqual([])
    expect(store.ops.map((o) => o.id)).toEqual(['a', 'b'])
  })

  it('does not announce a lost session for a credential the server marked as refused', async () => {
    const store = memStore()
    setQueueIdentity(2)
    const target = new EventTarget()
    vi.stubGlobal('window', target)
    const seen: Event[] = []
    target.addEventListener('homehub:session-lost', (e) => seen.push(e))
    armSessionLostNotice()
    stubFetch([{ status: 401, headers: { 'HomeHub-Auth': 'credential-rejected' } }])

    await executeDurably(store, op('a', 2))

    expect(seen).toHaveLength(0)
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


/**
 * The queue may not send before the server has confirmed who is asking.
 *
 * `WriteQueueProvider` already refuses to *replay* while locked or device-only. This is the other
 * door: a fresh write goes straight to `executeDurably`, so connectivity returning before
 * confirmation would have sent it under a cookie nobody had checked. Connectivity returning is not
 * authorization.
 */
describe('the identity boundary', () => {
  it('does not send while unconfirmed, and retains the operation', async () => {
    setPrivateNetworkConfirmed(false)
    // Owner-bound as well: `canExecuteQueuedOp` refuses an op whose owner is not the queue's current
    // identity, which is a second and independent gate this must not be mistaken for.
    setQueueIdentity(1)
    const sent = vi.fn()
    vi.stubGlobal('fetch', sent)
    const store = memStore()
    const queued = op('a', 1)
    persistAhead(store, queued)

    const { outcome } = await executeDurably(store, queued)

    // Nothing left the device.
    expect(sent).not.toHaveBeenCalled()
    // `offline` because that is what this is from the queue's point of view: not sent, still owed.
    // Any other outcome would be a new vocabulary for a condition the queue already handles.
    expect(outcome.kind).toBe('offline')
    expect(store.ops.map((o) => o.id)).toEqual(['a'])

    vi.unstubAllGlobals()
    setQueueIdentity(null)
  })

  it('sends once confirmation arrives, without the operation having been lost in between', async () => {
    setPrivateNetworkConfirmed(false)
    setQueueIdentity(1)
    const store = memStore()
    const queued = op('b', 1)
    persistAhead(store, queued)
    await executeDurably(store, queued)

    // The reconnect: the server answers, `SessionProvider` agrees the identity and its security
    // version, and only then may the retained write go.
    setPrivateNetworkConfirmed(true)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))

    const { outcome } = await executeDurably(store, queued)
    expect(outcome.kind).toBe('ok')

    vi.unstubAllGlobals()
    setQueueIdentity(null)
  })
})
