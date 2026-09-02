import { authorizedOperation, isPrivateNetworkAllowed } from '../api/privateNetwork'

/**
 * Offline write-queue (Stage 9b). User mutations that can't reach the server are sealed to the device
 * (see `queueStore.ts`, which survives reload) and replayed in order on reconnect. Conditional writes
 * carry the version last seen so the server can 409 an edit-vs-edit conflict, which we surface rather
 * than silently overwrite (conservative policy). Climate set-points carry no version (last-write-wins).
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
  /**
   * A private write found in the plaintext store a previous build used. Never replayed.
   *
   * Kept apart from `legacy-orphaned` because the two are refused for different reasons and the
   * distinction is worth having in a log: that one has no owner, this one has an owner and no
   * integrity — nothing about a plaintext record says it was not edited on the way here.
   */
  | 'legacy-plaintext'
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
 * Which domains may be held on the device in the clear. <b>Private is the default.</b>
 *
 * An allowlist rather than a list of private domains, and the direction is the point: a domain added
 * later is private until somebody writes it down here and says why, rather than plaintext until
 * somebody remembers to classify it. `care` is absent because its bodies are the household's record —
 * feed volumes, nappy contents, times, a child's name — and its paths and labels identify the same
 * thing as plainly as the bodies do.
 *
 * The only thing that consults this is `queueStore`'s migration off the plaintext store a previous
 * build used. Everything the queue writes now is sealed whichever domain it belongs to; this decides
 * what may be *carried across* from bytes that were already legible.
 */
const NON_PRIVATE_DOMAINS: ReadonlySet<WriteDomain> = new Set<WriteDomain>([
  'task', 'calendar', 'climate', 'meal', 'recipe', 'pantry', 'grocery',
])

/** Whether a queued write of this domain carries private household content. */
export function isPrivateDomain(domain: WriteDomain): boolean {
  return !NON_PRIVATE_DOMAINS.has(domain)
}

/**
 * The durable side of the queue, injected so the rules can be tested without a DOM and so the
 * storage layer can change underneath them without touching a single rule.
 *
 * <b>Reads and writes are synchronous and durability is not.</b> The rules below re-read the store on
 * every turn of a replay precisely so a concurrent enqueue is never overwritten, and a rule that had
 * to await could not do that. So a write lands in the store's memory synchronously and is sealed to
 * the device behind {@link QueueStore.flush} — see `queueStore.ts` for why the seal cannot be
 * synchronous. The write-ahead invariant is unchanged and is now explicit rather than implied by
 * `localStorage` being synchronous: {@link executeDurably} awaits the flush before its fetch begins.
 */
export interface QueueStore {
  read(): QueuedOp[]
  write(ops: QueuedOp[]): void
  readDropped(): DroppedOp[]
  writeDropped(ops: DroppedOp[]): void
  /** Resolves when every write so far is on the device; rejects when one could not be. */
  flush(): Promise<void>
}

/** Beyond this a set-aside notice is a wall of text nobody reads. Oldest fall off first. */
const MAX_DROPPED = 20

/** Retryable failures tolerated before a write is set aside. */
export const MAX_ATTEMPTS = 5

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
  // Awaited, so a durability decision that has to reach storage can hold the drain open until it has.
  // The return value is the caller's own business — `executeDurably` hands back a `DurableResult`.
  beforeDrain?: (outcome: ExecOutcome) => unknown,
): Promise<ExecOutcome> {
  if (!canExecuteQueuedOp(op)) {
    return { kind: 'error', status: 401, message: 'Queued operation belongs to another profile.' }
  }
  const useVersion = !forceOverwrite && op.baseVersion != null
  const sep = op.path.includes('?') ? '&' : '?'
  const path = `${op.path}${useVersion ? `${sep}baseVersion=${op.baseVersion}` : ''}`

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

  /** The server's answer, once there is one. Null until the reply has been read and classified. */
  let classified: ExecOutcome | null = null

  try {
    /*
     * The identity boundary, asked before the transport is entered rather than inside it.
     *
     * <b>Reported as `offline`, which is exactly what it is.</b> An unconfirmed panel and an
     * unreachable one are the same situation from the queue's point of view — the write has not been
     * sent and is still owed — and `offline` already means "retained, try again". Anything else here
     * would be a new outcome for a condition the queue already handles correctly.
     *
     * Asked here as well as inside `authorizedOperation` so the two refusals can be told apart: a
     * boundary that was already shut is `offline`, and one that closed *underneath* a request in
     * flight is `cancelled`. They are both retained, and they are not the same event.
     *
     * This is the reconnect hole it closes: `WriteQueueProvider` already refuses to *replay* while
     * locked or device-only, but a fresh write goes straight to `executeDurably`, and connectivity
     * returning before confirmation would have let it send under a cookie nobody had checked.
     */
    if (!isPrivateNetworkAllowed(op.method, op.path)) {
      const refused: ExecOutcome = { kind: 'offline' }
      await beforeDrain?.(refused)
      return refused
    }

    /*
     * <b>Through the authorised transport, which it used to sidestep.</b>
     *
     * This transport is genuinely not the JSON helper — it owns a send deadline, an abort controller
     * a profile transition can pull, and an outcome vocabulary that decides whether an operation is
     * retained, retried or set aside — and it used to inherit only the *policy* while calling `fetch`
     * itself. The cost of that was one specific thing: nothing here announced a lost session. An
     * expired cookie first discovered by a queued replay produced an ordinary `error 401`, the pass
     * broke out of its loop, and the panel stayed unlocked over the household's private screens with
     * no session behind them. Every other authenticated path had been brought under one decision and
     * this one had not.
     *
     * Everything it owns survives the move: the deadline is still this function's, the controller is
     * still what a transition pulls, and the classification below still happens inside the operation —
     * which is now also what holds the transition's drain open until the durability decision has run.
     */
    return await authorizedOperation(path, {
      method: op.method,
      headers: op.body != null ? { 'Content-Type': 'application/json' } : undefined,
      body: op.body != null ? JSON.stringify(op.body) : undefined,
      cache: 'no-store',
      signal: controller.signal,
    }, async (res) => {
      let outcome: ExecOutcome
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
      // A cookie transition cannot pass its barrier until this durability decision has run — which is
      // now true because the operation is what the barrier waits on, rather than the headers.
      classified = outcome
      await beforeDrain?.(outcome)
      return outcome
    })
  } catch {
    /*
     * The server's answer, once classified, is what happened — whatever the transport does next.
     *
     * `authorizedOperation` refuses on its way out when the boundary closed while the body was being
     * read, and that refusal must not be re-read as "the write never went". It went, it was answered,
     * and the durability decision on that answer has already been persisted; re-reporting it as
     * offline would leave the queue holding an operation the server has already applied.
     */
    if (classified) return classified

    /*
     * Otherwise: three failures arrive here and two of them are the same answer.
     *
     * A dead socket and a deadline are `offline`: the write was not sent and is still owed. An abort
     * pulled from outside is `cancelled` — a profile transition, not permission to forget an
     * operation that was durably written before its request started. So is the boundary closing
     * mid-flight, which `authorizedOperation` refuses for the same reason and which is a transition by
     * another name. All three are retained; only the telling differs.
     */
    const outcome: ExecOutcome = controller.signal.aborted && !expired
      ? { kind: 'cancelled' }
      : isPrivateNetworkAllowed(op.method, op.path) ? { kind: 'offline' } : { kind: 'cancelled' }
    await beforeDrain?.(outcome)
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
  /*
   * Sealed to the device before anything is sent — the write-ahead invariant, stated rather than
   * inherited.
   *
   * It used to be enough that `localStorage.setItem` is synchronous. The store now seals its blob
   * with WebCrypto, which is not, so "persisted before the fetch" is this await and nothing else. A
   * refusal propagates: the caller has source data to retain (notably a completed care timer) and
   * must be told, which is the same contract the old synchronous throw had.
   */
  await store.flush()
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
        /*
         * <b>A 401 is retained, not set aside.</b>
         *
         * It used to fall through to the terminal branch below — a 4xx describes the request, so the
         * request was discarded — and that reasoning is wrong for exactly this status. A 401 says
         * nothing about the operation and everything about the session carrying it: the cookie
         * expired, the profile's security version was bumped, somebody signed out on another tab. The
         * write is perfectly good and will land the moment its owner is confirmed again, so throwing
         * it away punished the household for a session timeout by deleting the entry they made.
         *
         * The transport announces the session loss (see `privateNetwork.noteAuthenticatedResponse`)
         * and `replayQueue` stops the pass; this half is only about not losing the work.
         */
        if (outcome.status === 401) {
          settledResult = { outcome, settled: false }
          break
        }
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
      /*
       * The identity this pass was replaying under is gone.
       *
       * Either the execution gate closed underneath us — a sign-out or lock landed mid-pass — or the
       * server itself refused the cookie, which is the case that used to end here silently. It no
       * longer does: the transport announces the loss (`privateNetwork.noteAuthenticatedResponse`)
       * and the panel locks. What this line owns is the other half — stop rather than grind the rest
       * of the queue against a cookie that is no longer this profile's. The operation stays queued;
       * see the 401 branch in `executeDurably`.
       */
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
