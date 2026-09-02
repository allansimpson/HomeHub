import { isPrivateNetworkAllowed } from '../api/privateNetwork'

/**
 * Offline write-queue (Stage 9b). User mutations that can't reach the server are persisted here
 * (localStorage, survives reload) and replayed in order on reconnect. Conditional writes carry the
 * version last seen so the server can 409 an edit-vs-edit conflict, which we surface rather than
 * silently overwrite (conservative policy). Climate set-points carry no version (last-write-wins).
 *
 * <b>The durability invariant.</b> A write exists durably in the owning profile's queue *before* its
 * fetch begins, and is removed only after a terminal server answer has been classified and that
 * removal persisted. Offline requests stay queued exactly once. The failure this prevents: a
 * mutation is sent, the panel ends mid-request (reload, kiosk restart, power cut, profile switch),
 * and the change is on screen with nothing durable left to replay.
 *
 * The rules below are pure functions over an injected {@link QueueStore} — storage is the single
 * source of truth and React state is only ever a mirror of it. That is deliberate: persistence that
 * waits for a render is not persistence, and the panel's tests run in a DOM-less node environment.
 */

export type WriteDomain =
  | 'task' | 'calendar' | 'climate' | 'meal' | 'recipe' | 'pantry' | 'grocery'
  /**
   * The care log — the one domain where a queued write is the point rather than a consolation.
   *
   * Its creates carry a `clientKey` in the body, so replaying one that already landed returns the
   * row rather than writing a second. Every other domain here can survive an ambiguous retry; a
   * feed log cannot, because the duplicate it would leave is indistinguishable from a real feed.
   */
  | 'care'

export interface QueuedOp {
  id: string
  /** Authenticated profile that created this operation. Missing legacy values are quarantined. */
  ownerProfileId: number
  domain: WriteDomain
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Path under /api, e.g. "/tasks/5/complete". */
  path: string
  body?: unknown
  /** Optimistic-concurrency token sent as ?baseVersion=; omitted → last-write-wins. */
  baseVersion?: number
  /** Human-readable description for the pending/conflict UI. */
  label: string
  createdAt: number
  /**
   * Retryable failures spent so far. Network trouble does not count — see {@link executeDurably}.
   * Absent means none.
   */
  attempts?: number
  /**
   * A 409 the household still owes an answer to, persisted with the server's value at the time.
   *
   * Held on the operation rather than beside it so that a reload while the resolution strip is on
   * screen loses neither the conflict nor the local edit. Replay steps over anything carrying one:
   * the queue must not decide a question that was asked of a person.
   */
  conflict?: { current: unknown; at: number }
}

export type ExecOutcome =
  | { kind: 'ok'; data: unknown }
  | { kind: 'conflict'; current: unknown }
  | { kind: 'gone' }
  | { kind: 'offline' }
  | { kind: 'cancelled' }
  | { kind: 'error'; status: number; message: string }

/**
 * Why a write was set aside instead of applied.
 *
 * Three different failures that all look identical to somebody standing at the panel — the entry
 * they made is not there. Naming them separately is what lets one notice explain all three.
 */
export type DropReason =
  /** Queued before the queue knew whose it was. Never replayed, never adopted. */
  | 'legacy-orphaned'
  /** Retryable, but the budget ran out. */
  | 'retry-exhausted'
  /** The server refused it deterministically — a 4xx that will refuse it again. */
  | 'rejected'

/** A write that will not be retried, kept so the household can be told and re-enter it. */
export interface DroppedOp {
  id: string
  label: string
  domain: WriteDomain
  /** Absent for legacy records, which is precisely why they were dropped. */
  ownerProfileId?: number
  reason: DropReason
  /** The server's sentence, where it wrote one. */
  message?: string
  at: number
}

/**
 * The durable side of the queue, injected so the rules can be tested without a DOM and so the
 * storage layer can change underneath them without touching a single rule.
 */
export interface QueueStore {
  read(): QueuedOp[]
  write(ops: QueuedOp[]): void
  readDropped(): DroppedOp[]
  writeDropped(ops: DroppedOp[]): void
}

const KEY = 'homehub.writequeue.v1'
const DROPPED_KEY = 'homehub.writequeue.dropped.v1'

/** Beyond this a set-aside notice is a wall of text nobody reads. Oldest fall off first. */
const MAX_DROPPED = 20

/** Retryable failures tolerated before a write is set aside. */
export const MAX_ATTEMPTS = 5

function readJson<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T[]) : []
  } catch {
    return []
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (cause) {
    // A write-ahead queue that silently ignores persistence failure is not durable. Callers must
    // retain their source data (notably a completed care timer) and surface the refusal.
    throw new Error('The offline write could not be persisted.', { cause })
  }
}

export const localQueueStore: QueueStore = {
  read: () => readJson<QueuedOp>(KEY),
  write: (ops) => writeJson(KEY, ops),
  readDropped: () => readJson<DroppedOp>(DROPPED_KEY),
  writeDropped: (ops) => writeJson(DROPPED_KEY, ops),
}

/** The only operations visible or replayable in the current authenticated profile. */
export function queueForProfile(ops: QueuedOp[], profileId: number | null): QueuedOp[] {
  if (profileId == null) return []
  return ops.filter((op) => op.ownerProfileId === profileId)
}

// In-memory execution gate. SessionProvider closes it synchronously before sign-out, lock, or a
// profile-changing sign-in can replace the HttpOnly cookie used by fetch.
let queueIdentity: number | null = null
const activeRequests = new Map<AbortController, Promise<void>>()

export function setQueueIdentity(profileId: number | null): void {
  queueIdentity = profileId
  if (profileId == null) {
    for (const controller of activeRequests.keys()) controller.abort()
  }
}

/** Close execution and wait until requests using the old session cookie have fully settled. */
export async function closeQueueExecution(): Promise<void> {
  queueIdentity = null
  const draining = [...activeRequests.values()]
  for (const controller of activeRequests.keys()) controller.abort()
  await Promise.allSettled(draining)
}

export function canExecuteQueuedOp(op: QueuedOp): boolean {
  return queueIdentity != null && op.ownerProfileId === queueIdentity
}

export function newId(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined
  if (c?.randomUUID) return c.randomUUID()
  return `op-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
}

/* ------------------------------------------------------------------ *
 * Durability rules — pure over an injected store, re-reading every time
 * ------------------------------------------------------------------ */

/**
 * Write an operation ahead of its fetch, in place.
 *
 * In place, and not appended, because re-persisting an op that is already queued must not shuffle
 * it behind writes made after it. FIFO is the whole contract of a replay queue; an op that loses
 * its place is an op that lands out of order.
 */
export function persistAhead(store: QueueStore, op: QueuedOp): void {
  const queue = store.read()
  const at = queue.findIndex((held) => held.id === op.id)
  if (at === -1) store.write([...queue, op])
  else store.write(queue.map((held, i) => (i === at ? op : held)))
}

/** Remove one operation, re-reading first so a concurrent enqueue is never overwritten. */
export function removeOp(store: QueueStore, opId: string): void {
  const queue = store.read()
  const without = queue.filter((op) => op.id !== opId)
  if (without.length !== queue.length) store.write(without)
}

/** Amend one operation in place, re-reading first. Returns whether one was found. */
export function updateOp(store: QueueStore, opId: string, patch: Partial<QueuedOp>): boolean {
  const queue = store.read()
  if (!queue.some((op) => op.id === opId)) return false
  store.write(queue.map((op) => (op.id === opId ? { ...op, ...patch } : op)))
  return true
}

/** Take an operation out of the queue and into the set-aside list, durably, in that order. */
export function dropOp(
  store: QueueStore, op: QueuedOp, reason: DropReason, message?: string,
): DroppedOp {
  const record: DroppedOp = {
    id: op.id,
    label: op.label,
    domain: op.domain,
    ownerProfileId: op.ownerProfileId,
    reason,
    message,
    at: Date.now(),
  }
  removeOp(store, op.id)
  store.writeDropped([...store.readDropped(), record].slice(-MAX_DROPPED))
  return record
}

/**
 * Whether a failing status is worth sending again.
 *
 * 408 and 429 are the server asking for patience, and 5xx is the server being unwell — all three
 * describe *this attempt*, not the request. Every other 4xx describes the request, and sending it
 * again produces the same refusal at the same cost, so it is terminal. 409 and 404 never reach
 * here: they have dedicated outcomes.
 */
export function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

/** How long one send may go unanswered before the op falls back into the queue. */
const SEND_DEADLINE_MS = 20_000

/** Execute one queued op against the API. `forceOverwrite` drops the version check (keep-mine). */
export async function executeOp(
  op: QueuedOp,
  forceOverwrite = false,
  beforeDrain?: (outcome: ExecOutcome) => void,
): Promise<ExecOutcome> {
  if (!canExecuteQueuedOp(op)) {
    return { kind: 'error', status: 401, message: 'Queued operation belongs to another profile.' }
  }
  const useVersion = !forceOverwrite && op.baseVersion != null
  const sep = op.path.includes('?') ? '&' : '?'
  const url = `/api${op.path}${useVersion ? `${sep}baseVersion=${op.baseVersion}` : ''}`

  const controller = new AbortController()
  let markDrained!: () => void
  const drained = new Promise<void>((resolve) => { markDrained = resolve })
  activeRequests.set(controller, drained)

  /*
   * A send that is never answered is offline, and has to be *called* offline.
   *
   * This controller existed only to be aborted from outside — a profile transition — so a request
   * to a host with no route sat on an open socket for as long as the OS allowed, and `run` above it
   * did not return, and the screen that awaited it kept its controls disabled the whole time. The
   * op is already durable by then: timing out drops it back into the queue it was written to, which
   * is where an unsent write belongs and where replay will find it.
   *
   * Longer than the read deadline in `api/client.ts` because this carries a body up a slow link
   * rather than asking a question, and the household is not waiting on the answer.
   */
  let expired = false
  const deadline = setTimeout(() => { expired = true; controller.abort() }, SEND_DEADLINE_MS)

  try {
    let outcome: ExecOutcome
    let res: Response

    /*
     * The identity boundary, checked here rather than by routing this through the JSON helper.
     *
     * This transport is not that one: it owns a send deadline, an abort controller a profile
     * transition can pull, and an outcome vocabulary that decides whether an operation is retained,
     * retried or set aside. Sending it through `request` to inherit the boundary would cost all of
     * that, so it inherits the *policy* instead.
     *
     * <b>Reported as `offline`, which is exactly what it is.</b> An unconfirmed panel and an
     * unreachable one are the same situation from the queue's point of view — the write has not been
     * sent and is still owed — and `offline` already means "retained, try again". Anything else here
     * would be a new outcome for a condition the queue already handles correctly.
     *
     * This is the reconnect hole it closes: `WriteQueueProvider` already refuses to *replay* while
     * locked or device-only, but a fresh write goes straight to `executeDurably`, and connectivity
     * returning before confirmation would have let it send under a cookie nobody had checked.
     */
    if (!isPrivateNetworkAllowed(op.method, op.path)) {
      outcome = { kind: 'offline' }
      beforeDrain?.(outcome)
      return outcome
    }

    try {
      res = await fetch(url, {
        method: op.method,
        headers: op.body != null ? { 'Content-Type': 'application/json' } : undefined,
        body: op.body != null ? JSON.stringify(op.body) : undefined,
        cache: 'no-store',
        signal: controller.signal,
      })
    } catch {
      // Both are retained rather than forgotten, but they are not the same event: `cancelled` is a
      // profile transition and `offline` is a server that is not there. A deadline is the latter.
      outcome = controller.signal.aborted && !expired ? { kind: 'cancelled' } : { kind: 'offline' }
      beforeDrain?.(outcome)
      return outcome
    }

    if (res.ok) {
      const text = await res.text().catch(() => '')
      outcome = { kind: 'ok', data: text ? JSON.parse(text) : undefined }
    } else if (res.status === 409) {
      const current = await res.json().catch(() => undefined)
      outcome = { kind: 'conflict', current }
    } else if (res.status === 404) {
      outcome = { kind: 'gone' }
    } else {
      const detail = await res.text().catch(() => '')
      outcome = { kind: 'error', status: res.status, message: detail.trim() || res.statusText }
    }
    // A cookie transition cannot pass its barrier until this synchronous durability decision ran.
    beforeDrain?.(outcome)
    return outcome
  } finally {
    clearTimeout(deadline)
    activeRequests.delete(controller)
    markDrained()
  }
}

/** What a durable execution did to the queue, for the caller that has a UI to update. */
export interface DurableResult {
  outcome: ExecOutcome
  /** The op is no longer queued: it landed, or was set aside. */
  settled: boolean
  /** Set aside — the household should be told. */
  dropped?: DroppedOp
}

/**
 * The write-ahead path: own it, persist it, send it, and only then decide whether it may go.
 *
 * Ordering is the point. The persist happens before the fetch so that nothing can end the page
 * between the two; the removal happens after the answer has been classified so that nothing is
 * forgotten on the strength of a request we never saw the end of.
 */
export async function executeDurably(
  store: QueueStore, op: QueuedOp, forceOverwrite = false,
): Promise<DurableResult> {
  // Ownership is checked before the write, not after: another profile's operation must never enter
  // this store, let alone leave it under whichever cookie happens to be current.
  if (!canExecuteQueuedOp(op)) {
    return {
      outcome: { kind: 'error', status: 401, message: 'Queued operation belongs to another profile.' },
      settled: false,
    }
  }

  persistAhead(store, op)
  let settledResult: DurableResult | null = null
  const settle = (outcome: ExecOutcome): DurableResult => {
    if (settledResult) return settledResult

    switch (outcome.kind) {
      case 'ok':
      // A row that is gone is a write with nothing left to apply. Terminal, and the resync that
      // follows is what puts the screen back in step with it.
      case 'gone':
        removeOp(store, op.id)
        settledResult = { outcome, settled: true }
        break

      case 'offline':
      case 'cancelled':
        // Retained exactly once. A cancellation is a profile transition, not permission to forget
        // the operation that was durably written before its request started.
        settledResult = { outcome, settled: false }
        break

      case 'conflict':
        // Durable, so the question survives a reload. Replay steps over it until somebody answers.
        updateOp(store, op.id, { conflict: { current: outcome.current, at: Date.now() } })
        settledResult = { outcome, settled: false }
        break

      case 'error': {
        if (!isRetryable(outcome.status)) {
          settledResult = {
            outcome, settled: true, dropped: dropOp(store, op, 'rejected', outcome.message),
          }
          break
        }
        const attempts = (op.attempts ?? 0) + 1
        if (attempts >= MAX_ATTEMPTS) {
          settledResult = {
            outcome,
            settled: true,
            dropped: dropOp(store, { ...op, attempts }, 'retry-exhausted', outcome.message),
          }
          break
        }
        updateOp(store, op.id, { attempts })
        settledResult = { outcome, settled: false }
        break
      }
    }
    return settledResult
  }

  const outcome = await executeOp(op, forceOverwrite, settle)
  return settledResult ?? settle(outcome)
}

/** What a replay pass did, for the caller that has a UI to update. */
export interface ReplayResult {
  /** Something landed, was set aside, or newly conflicted — providers should resync. */
  changed: boolean
  dropped: DroppedOp[]
  conflicted: QueuedOp[]
  /** The network went away mid-pass; the rest is still queued. */
  stoppedOffline: boolean
}

/**
 * Replay this profile's queue, in order.
 *
 * Two things distinguish it from the obvious loop. It re-reads storage on every turn rather than
 * working a snapshot and assigning survivors back at the end — a snapshot erases anything queued
 * while the pass was awaiting, which on a panel where writes arrive by touch is not a rare race.
 * And only `offline` halts it: a deterministic refusal used to stop the queue and hold every write
 * behind it for ever, with nothing on screen, so the one write the server would never accept became
 * the reason none of the others were tried.
 */
export async function replayQueue(store: QueueStore, profileId: number | null): Promise<ReplayResult> {
  const result: ReplayResult = { changed: false, dropped: [], conflicted: [], stoppedOffline: false }
  if (profileId == null) return result

  // Legacy records, queued before the queue knew whose they were. Policy is quarantine, never
  // adoption: replaying one attributes somebody's mutation to whoever is signed in now. They are
  // set aside so the household can re-enter what matters, and are never sent.
  for (const orphan of store.read().filter((op) => op.ownerProfileId == null)) {
    result.dropped.push(dropOp(store, orphan, 'legacy-orphaned'))
    result.changed = true
  }

  const tried = new Set<string>()
  for (;;) {
    // Re-read, every turn. This is the D2 fix and it is load-bearing.
    const next = store.read().find((op) =>
      op.ownerProfileId === profileId && !op.conflict && !tried.has(op.id))
    if (!next) break
    tried.add(next.id)

    const { outcome, settled, dropped } = await executeDurably(store, next)
    if (dropped) result.dropped.push(dropped)
    if (settled) result.changed = true

    if (outcome.kind === 'offline' || outcome.kind === 'cancelled') {
      result.stoppedOffline = true
      break
    }
    if (outcome.kind === 'conflict') {
      result.conflicted.push(next)
      result.changed = true
    }
    if (outcome.kind === 'error' && outcome.status === 401) {
      // The execution gate closed underneath us — a sign-out or lock landed mid-pass. Stop rather
      // than grind the rest of the queue against a cookie that is no longer this profile's.
      break
    }
  }

  return result
}

/**
 * The keep-mine form of an operation.
 *
 * `baseVersion` is cleared rather than merely overridden for this one send. An offline keep-mine is
 * replayed later by the ordinary path, and an op still carrying its original version conflicts
 * again on that replay — asking the household the same question a second time, after they have
 * already answered it. Clearing the version is what makes the answer stick.
 */
export function keepMine(op: QueuedOp): QueuedOp {
  const { baseVersion: _baseVersion, conflict: _conflict, ...rest } = op
  return { ...rest, attempts: 0 }
}

/** The discard form: the server wins, so there is nothing left to send. */
export function discardConflict(store: QueueStore, opId: string): void {
  removeOp(store, opId)
}
