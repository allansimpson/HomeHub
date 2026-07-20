import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useConnection } from './ConnectionProvider'
import { executeOp, loadQueue, newId, saveQueue } from './writeQueue'
import type { ExecOutcome, QueuedOp } from './writeQueue'

/** A surfaced edit-vs-edit conflict awaiting the user's choice. */
export interface Conflict {
  op: QueuedOp
  current: unknown
}

type RunOutcome = ExecOutcome | { kind: 'queued' }

/**
 * Offline write-queue coordinator (Stage 9b). Domain providers apply their change optimistically
 * then call {@link run}; if the server is unreachable the op is queued (persisted) and replayed in
 * order on reconnect. A 409 becomes a surfaced {@link Conflict} the user resolves — keep-mine
 * (force overwrite) or discard (server wins) — never a silent overwrite. Successful replay fires a
 * `homehub:sync` event so providers refresh.
 */
interface WriteQueueState {
  pendingCount: number
  conflicts: Conflict[]
  /** Try a mutation now, or queue it if offline. Domain providers reconcile from the outcome. */
  run: (draft: Omit<QueuedOp, 'id' | 'createdAt'>) => Promise<RunOutcome>
  resolveConflict: (opId: string, choice: 'keep-mine' | 'discard') => Promise<void>
  retry: () => void
}

const WriteQueueContext = createContext<WriteQueueState | null>(null)

function fireSync() {
  window.dispatchEvent(new Event('homehub:sync'))
}

export function WriteQueueProvider({ children }: { children: ReactNode }) {
  const { online } = useConnection()
  const [pending, setPending] = useState<QueuedOp[]>(() => loadQueue())
  const [conflicts, setConflicts] = useState<Conflict[]>([])
  const replaying = useRef(false)

  // Persist the queue whenever it changes.
  useEffect(() => {
    saveQueue(pending)
  }, [pending])

  const enqueue = useCallback((op: QueuedOp) => setPending((p) => [...p, op]), [])

  const run = useCallback(
    async (draft: Omit<QueuedOp, 'id' | 'createdAt'>): Promise<RunOutcome> => {
      const op: QueuedOp = { ...draft, id: newId(), createdAt: Date.now() }
      if (!online) {
        enqueue(op)
        return { kind: 'queued' }
      }
      const outcome = await executeOp(op)
      if (outcome.kind === 'offline') {
        enqueue(op)
        return { kind: 'queued' }
      }
      if (outcome.kind === 'conflict') {
        setConflicts((c) => [...c, { op, current: outcome.current }])
      }
      return outcome
    },
    [online, enqueue],
  )

  const replay = useCallback(async () => {
    if (replaying.current) return
    replaying.current = true
    try {
      let changed = false
      // Snapshot; process FIFO, stopping if we go offline again.
      const queue = loadQueue()
      const remaining: QueuedOp[] = []
      const newConflicts: Conflict[] = []
      let stopped = false
      for (const op of queue) {
        if (stopped) {
          remaining.push(op)
          continue
        }
        const outcome = await executeOp(op)
        if (outcome.kind === 'offline' || outcome.kind === 'error') {
          stopped = true
          remaining.push(op)
        } else if (outcome.kind === 'conflict') {
          newConflicts.push({ op, current: outcome.current })
          changed = true
        } else {
          // ok or gone → the op is done.
          changed = true
        }
      }
      setPending(remaining)
      if (newConflicts.length) setConflicts((c) => [...c, ...newConflicts])
      if (changed) fireSync()
    } finally {
      replaying.current = false
    }
  }, [])

  // Replay whenever the connection is up and there's queued work.
  useEffect(() => {
    if (online && pending.length > 0) void replay()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online])

  const resolveConflict = useCallback(async (opId: string, choice: 'keep-mine' | 'discard') => {
    let target: Conflict | undefined
    setConflicts((c) => {
      target = c.find((x) => x.op.id === opId)
      return c.filter((x) => x.op.id !== opId)
    })
    if (choice === 'discard') {
      fireSync() // revert optimistic state to the server's
      return
    }
    if (target) {
      const outcome = await executeOp(target.op, /* forceOverwrite */ true)
      if (outcome.kind === 'conflict') {
        // Shouldn't happen with force; if it does, re-surface.
        setConflicts((c) => [...c, { op: target!.op, current: outcome.current }])
      } else {
        fireSync()
      }
    }
  }, [])

  const value = useMemo<WriteQueueState>(
    () => ({ pendingCount: pending.length, conflicts, run, resolveConflict, retry: () => void replay() }),
    [pending.length, conflicts, run, resolveConflict, replay],
  )

  return <WriteQueueContext.Provider value={value}>{children}</WriteQueueContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useWriteQueue(): WriteQueueState {
  const ctx = useContext(WriteQueueContext)
  if (!ctx) throw new Error('useWriteQueue must be used within a WriteQueueProvider')
  return ctx
}
