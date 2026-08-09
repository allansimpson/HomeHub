import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api, ApiError } from '../api/client'
import type {
  BabyChildDto,
  BabyHealthDto,
  BabyStateDto,
  BabyTimerActionName,
  BottleInput,
  DiaperInput,
  NursingSideName,
} from '../api/types'

/**
 * Baby tracking, read from Huckleberry through Home Assistant.
 *
 * Three upstream properties shape everything here, and all three are unusual:
 *
 * 1. **Writes never queue.** Unlike calendar and tasks, a failed baby write is not retried later —
 *    it fails visibly, immediately, and stays failed. Nothing on this path touches the write queue.
 * 2. **Writes are irreversible.** There is no delete or edit service, so nothing logged here can be
 *    retracted by HomeHub. There is no undo, and the UI must not imply one.
 * 3. **No retroactive logging.** Bottles and diapers log *now*; only the timers carry a time basis.
 *
 * Huckleberry is the system of record. This provider displays and requests — it never stores.
 */
interface BabyState {
  health: BabyHealthDto | null
  children: BabyChildDto[]
  /** The child in view. One baby today, but everything is keyed so a second needs no migration. */
  child: BabyChildDto | null
  state: BabyStateDto | null
  /** True until the first read settles, so the screen can hold rather than flash "not connected". */
  loading: boolean
  /** The last write failure, verbatim, until it's cleared or a write succeeds. */
  error: string | null
  /** A write is in flight; controls disable so a double-tap can't log twice. */
  writing: boolean
  logBottle: (input: BottleInput) => Promise<boolean>
  logDiaper: (input: DiaperInput) => Promise<boolean>
  timer: (action: BabyTimerActionName, side?: NursingSideName) => Promise<boolean>
  clearError: () => void
  refresh: () => Promise<void>
}

const BabyContext = createContext<BabyState | null>(null)

const POLL_MS = 30_000

export function BabyProvider({ children: subtree }: { children: ReactNode }) {
  const [health, setHealth] = useState<BabyHealthDto | null>(null)
  const [children, setChildren] = useState<BabyChildDto[]>([])
  const [childKey, setChildKey] = useState<string | null>(null)
  const [state, setState] = useState<BabyStateDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [writing, setWriting] = useState(false)

  const childKeyRef = useRef<string | null>(null)
  childKeyRef.current = childKey

  /**
   * Generation counter for reads, so a slower earlier read cannot overwrite a newer one.
   *
   * Three things call {@link refresh}: the 30s interval, the `homehub:sync` listener, and every
   * write. Without this, a poll that left before a log lands after it and restores the pre-write
   * state — a diaper you just recorded drops back off the screen for up to 30 seconds, on a section
   * whose own label says entries can't be undone, which is exactly when someone logs it twice.
   */
  const readGeneration = useRef(0)

  const refresh = useCallback(async () => {
    const generation = ++readGeneration.current
    // True once a later read has started; this one may still finish, but it must not be believed.
    const superseded = () => generation !== readGeneration.current

    try {
      const next = await api.getBabyHealth()
      if (superseded()) return
      setHealth(next)
      if (!next.configured) {
        setChildren([])
        setState(null)
        return
      }

      const kids = await api.getBabyChildren()
      if (superseded()) return
      setChildren(kids)
      const key = childKeyRef.current && kids.some((k) => k.key === childKeyRef.current)
        ? childKeyRef.current
        : kids[0]?.key ?? null
      setChildKey(key)

      const state = key ? await api.getBabyState(key) : null
      if (superseded()) return
      setState(state)
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      // A read failure leaves the last known state on screen; the sync line already carries the
      // health status, so there's nothing honest to add by blanking the screen.
    } finally {
      // Deliberately unguarded: the first read to finish has resolved the loading question, whether
      // or not its data is still the freshest.
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      if (!cancelled) await refresh()
    }
    void tick()
    const id = window.setInterval(tick, POLL_MS)
    const onSync = () => void refresh()
    window.addEventListener('homehub:sync', onSync)
    return () => {
      cancelled = true
      window.clearInterval(id)
      window.removeEventListener('homehub:sync', onSync)
    }
  }, [refresh])

  /**
   * One write, straight to the API. Never queued and never retried: the caller learns immediately
   * whether it landed, because the alternative — a silent retry against a system of record that
   * can't delete — writes the same feed twice.
   */
  const write = useCallback(
    async (perform: (key: string) => Promise<void>, what: string): Promise<boolean> => {
      const key = childKeyRef.current
      if (!key) {
        setError(`No child to log ${what} against.`)
        return false
      }
      setWriting(true)
      setError(null)
      try {
        await perform(key)
        await refresh()
        return true
      } catch (err) {
        setError(
          err instanceof ApiError && err.message
            ? `${what} was not logged — ${err.message}`
            : `${what} was not logged.`,
        )
        return false
      } finally {
        setWriting(false)
      }
    },
    [refresh],
  )

  const logBottle = useCallback(
    (input: BottleInput) => write((key) => api.logBottle(key, input), 'The bottle'),
    [write],
  )

  const logDiaper = useCallback(
    (input: DiaperInput) => write((key) => api.logDiaper(key, input), 'The diaper'),
    [write],
  )

  const timer = useCallback(
    (action: BabyTimerActionName, side?: NursingSideName) =>
      write((key) => api.babyTimer(key, 'nursing', action, side), `The nursing timer (${action})`),
    [write],
  )

  const clearError = useCallback(() => setError(null), [])

  const child = useMemo(
    () => children.find((c) => c.key === childKey) ?? children[0] ?? null,
    [children, childKey],
  )

  const value = useMemo<BabyState>(
    () => ({
      health, children, child, state, loading, error, writing,
      logBottle, logDiaper, timer, clearError, refresh,
    }),
    [health, children, child, state, loading, error, writing, logBottle, logDiaper, timer, clearError, refresh],
  )

  return <BabyContext.Provider value={value}>{subtree}</BabyContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useBaby(): BabyState {
  const ctx = useContext(BabyContext)
  if (!ctx) throw new Error('useBaby must be used within a BabyProvider')
  return ctx
}
