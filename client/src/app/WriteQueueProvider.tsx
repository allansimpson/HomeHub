import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useConnection } from './ConnectionProvider'
import {
  discardConflict, executeDurably, keepMine, localQueueStore, newId, persistAhead,
  queueForProfile, removeOp, replayQueue, updateOp,
} from './writeQueue'
import type { DroppedOp, ExecOutcome, QueuedOp } from './writeQueue'
import { useSession } from './SessionProvider'

/** A surfaced edit-vs-edit conflict awaiting the user's choice. */
export interface Conflict {
  op: QueuedOp
  current: unknown
}

/**
 * What became of a write.
 *
 * `queued` carries the op's id so a caller can take it back before it ever leaves — see
 * {@link WriteQueueState.withdraw}. Everything else is the server's answer.
 */
type RunOutcome = ExecOutcome | { kind: 'queued'; opId: string }

/**
 * Offline write-queue coordinator (Stage 9b). Domain providers apply their change optimistically
 * then call {@link run}; if the server is unreachable the op is queued (persisted) and replayed in
 * order on reconnect. A 409 becomes a surfaced {@link Conflict} the user resolves — keep-mine
 * (force overwrite) or discard (server wins) — never a silent overwrite. Successful replay fires a
 * `homehub:sync` event so providers refresh.
 *
 * A coordinator only: every durability rule lives in `writeQueue.ts` as a pure function over the
 * store, and the `pending`/`dropped` state here is a mirror of storage rather than the truth of it.
 * Nothing waits for a render to become durable.
 */
export interface WriteQueueState {
  pendingCount: number
  conflicts: Conflict[]
  /** Writes that will not be retried, awaiting acknowledgement. See {@link dismissDropped}. */
  dropped: DroppedOp[]
  /** Try a mutation now, or queue it if offline. Domain providers reconcile from the outcome. */
  run: (draft: Omit<QueuedOp, 'id' | 'createdAt' | 'ownerProfileId'>) => Promise<RunOutcome>
  resolveConflict: (opId: string, choice: 'keep-mine' | 'discard') => Promise<void>
  retry: () => void
  /** Acknowledge the set-aside notice. The writes are already gone; this clears the telling. */
  dismissDropped: () => void
  /**
   * Take a queued op back before it is ever sent. Returns whether one was found to withdraw.
   *
   * <b>The third state Undo has to keep its promise in.</b> The queue could add and replay but not
   * forget, so an offline create that somebody immediately undid had nothing to undo — the delete
   * would 404 against an event that did not exist yet, and the create would replay on reconnect and
   * put the engagement on the calendar minutes after it was taken back. Withdrawing in place is the
   * only version of that promise that survives being made offline.
   */
  withdraw: (opId: string) => boolean
  /**
   * Rewrite a queued op's body before it is ever sent. Returns whether one was found to amend.
   *
   * <b>The correction half of what {@link withdraw} does for deletion.</b> Correcting an entry that
   * has not left the panel yet cannot go out as a PUT: there is no server row to address, and no id
   * to address it by. Withdrawing and re-adding would work but hands the entry a new place in the
   * queue and a new identity, so an amendment made twice could race its own create. Rewriting the
   * op in place keeps one create, in its original order, carrying the corrected values.
   *
   * False once the op has gone — the entry has a real id by then, and an ordinary conditional PUT
   * is the right way to correct it.
   */
  amend: (opId: string, body: unknown, label?: string) => boolean
}

const WriteQueueContext = createContext<WriteQueueState | null>(null)

const store = localQueueStore

function fireSync() {
  window.dispatchEvent(new Event('homehub:sync'))
}

export function WriteQueueProvider({ children }: { children: ReactNode }) {
  const { online } = useConnection()
  const { activeProfileId, locked } = useSession()
  const [pending, setPending] = useState<QueuedOp[]>(() => store.read())
  const [dropped, setDropped] = useState<DroppedOp[]>(() => store.readDropped())
  const replaying = useRef(false)
  /*
   * Ids currently mid-flight, held out of the pending count.
   *
   * Write-ahead means every ordinary online tap is briefly a queued operation — persisted, sent,
   * removed, all inside a few hundred milliseconds. Counting those would flash "1 change pending"
   * across the top of the panel on every touch, which reads as trouble and is not. Durability the
   * household can see should be durability the household actually needs to see.
   */
  const inFlight = useRef(new Set<string>())

  // Storage is the truth; this pulls the mirror back into line with it after any durable change.
  const sync = useCallback(() => {
    setPending(store.read())
    setDropped(store.readDropped())
  }, [])

  const owned = useMemo(
    () => queueForProfile(pending, locked ? null : activeProfileId),
    [pending, locked, activeProfileId],
  )
  const conflicts = useMemo<Conflict[]>(
    () => owned.flatMap((op) => (op.conflict ? [{ op, current: op.conflict.current }] : [])),
    [owned],
  )
  const pendingCount = owned.filter((op) => !op.conflict && !inFlight.current.has(op.id)).length
  const activeDropped = useMemo(
    () => (locked || activeProfileId == null
      ? []
      : dropped.filter((d) => d.ownerProfileId == null || d.ownerProfileId === activeProfileId)),
    [dropped, locked, activeProfileId],
  )

  const run = useCallback(
    async (draft: Omit<QueuedOp, 'id' | 'createdAt' | 'ownerProfileId'>): Promise<RunOutcome> => {
      if (locked || activeProfileId == null) {
        return { kind: 'error', status: 401, message: 'Unlock a profile before saving changes.' }
      }
      const op: QueuedOp = {
        ...draft,
        id: newId(),
        createdAt: Date.now(),
        ownerProfileId: activeProfileId,
      }
      if (!online) {
        // Durable before the caller is told it is queued — not one render later.
        persistAhead(store, op)
        sync()
        return { kind: 'queued', opId: op.id }
      }

      inFlight.current.add(op.id)
      let result
      try {
        result = await executeDurably(store, op)
      } finally {
        // Cleared before the mirror is refreshed, or an op that fell through to `offline` would be
        // held out of a count that has no reason to be recomputed again.
        inFlight.current.delete(op.id)
      }
      sync()
      if (result.dropped) fireSync()
      return result.outcome.kind === 'offline' ? { kind: 'queued', opId: op.id } : result.outcome
    },
    [online, locked, activeProfileId, sync],
  )

  const replay = useCallback(async () => {
    if (replaying.current || locked || activeProfileId == null) return
    replaying.current = true
    try {
      const result = await replayQueue(store, activeProfileId)
      sync()
      if (result.changed) fireSync()
    } finally {
      replaying.current = false
    }
  }, [locked, activeProfileId, sync])

  // Replay whenever the connection is up and this profile has queued work.
  useEffect(() => {
    if (online && !locked && owned.some((op) => !op.conflict)) void replay()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, locked, activeProfileId])

  const resolveConflict = useCallback(async (opId: string, choice: 'keep-mine' | 'discard') => {
    const target = store.read().find((op) => op.id === opId)
    if (!target || locked || target.ownerProfileId !== activeProfileId) return

    if (choice === 'discard') {
      discardConflict(store, opId)
      sync()
      fireSync() // revert optimistic state to the server's
      return
    }

    /*
     * Keep-mine goes back through the durable path, and this is the whole of the fix.
     *
     * It used to leave state, force-execute, and look at the answer only for another conflict —
     * so an `offline` or a refusal fell through every branch of it, and because a conflicted op had
     * never been in `pending`, the edit existed nowhere at all. Somebody chose to keep their work
     * and the panel quietly threw it away, with no race required and nothing on screen. Now the
     * choice is persisted first: worst case it waits in the queue for the network to come back.
     */
    const forced = keepMine(target)
    persistAhead(store, forced)
    sync()

    const { outcome, dropped: setAside } = await executeDurably(store, forced)
    sync()
    if (outcome.kind === 'conflict') return // re-surfaced; shouldn't happen with the version cleared
    if (outcome.kind !== 'offline' || setAside) fireSync()
  }, [locked, activeProfileId, sync])

  /*
   * Read from the persisted queue rather than from `pending`, and written straight back.
   *
   * `pending` is a render away from whatever the last `run` put in it, and the case this exists for
   * is somebody pressing UNDO seconds after the create that queued it — quite possibly in the same
   * commit. Going through storage makes the withdrawal answer about the queue that will actually be
   * replayed, not the one this render happens to be holding.
   */
  const withdraw = useCallback((opId: string): boolean => {
    const target = store.read().find((op) => op.id === opId)
    if (!target || locked || target.ownerProfileId !== activeProfileId) return false
    removeOp(store, opId)
    sync()
    return true
  }, [locked, activeProfileId, sync])

  /* Through storage rather than `pending`, for the same reason `withdraw` is — see its note. */
  const amend = useCallback((opId: string, body: unknown, label?: string): boolean => {
    const target = store.read().find((op) => op.id === opId)
    if (!target || locked || target.ownerProfileId !== activeProfileId) return false
    updateOp(store, opId, { body, label: label ?? target.label })
    sync()
    return true
  }, [locked, activeProfileId, sync])

  const dismissDropped = useCallback(() => {
    store.writeDropped([])
    sync()
  }, [sync])

  const value = useMemo<WriteQueueState>(
    () => ({
      pendingCount, conflicts, dropped: activeDropped, run, resolveConflict,
      retry: () => void replay(), dismissDropped, withdraw, amend,
    }),
    [pendingCount, conflicts, activeDropped, run, resolveConflict, replay, dismissDropped,
      withdraw, amend],
  )

  return <WriteQueueContext.Provider value={value}>{children}</WriteQueueContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useWriteQueue(): WriteQueueState {
  const ctx = useContext(WriteQueueContext)
  if (!ctx) throw new Error('useWriteQueue must be used within a WriteQueueProvider')
  return ctx
}
