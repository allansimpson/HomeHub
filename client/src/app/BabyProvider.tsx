import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api, ApiError } from '../api/client'
import type { BabyChildDto, BabyHealthDto, BabyStateDto } from '../api/types'

/**
 * Baby tracking, read from Huckleberry through Home Assistant.
 *
 * **Read-only.** This provider used to write as well — bottles, diapers and the nursing timer, each
 * straight to a Home Assistant service, never queued and never retried, because the upstream has no
 * delete and no edit and a silent retry against it logs the same feed twice. The Care tab logs to
 * HomeHub's own care log now (`useCareLog`), which has a real timestamp and rows that can be
 * corrected, so nothing asks this provider to write any more and the whole irreversible path is gone.
 *
 * What remains is the read the rest of the app still needs: the integration's health for the Care
 * sync line and Config → Devices, the child list, and the live sensor state the dashboard shows.
 * History comes across through the log's own pull-in, which reads Huckleberry's calendar and writes
 * nothing back.
 */
interface BabyState {
  health: BabyHealthDto | null
  children: BabyChildDto[]
  /** The child in view. One baby today, but everything is keyed so a second needs no migration. */
  child: BabyChildDto | null
  state: BabyStateDto | null
  /** True until the first read settles, so the screen can hold rather than flash "not connected". */
  loading: boolean
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

  const childKeyRef = useRef<string | null>(null)
  childKeyRef.current = childKey

  /**
   * Generation counter for reads, so a slower earlier read cannot overwrite a newer one.
   *
   * Two things call {@link refresh} — the 30s interval and the `homehub:sync` listener — and a
   * manual sync fires while the interval's read may still be in flight. Without this, the older
   * read lands last and puts stale sensor values back on screen seconds after the fresh ones.
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

  const child = useMemo(
    () => children.find((c) => c.key === childKey) ?? children[0] ?? null,
    [children, childKey],
  )

  const value = useMemo<BabyState>(
    () => ({ health, children, child, state, loading, refresh }),
    [health, children, child, state, loading, refresh],
  )

  return <BabyContext.Provider value={value}>{subtree}</BabyContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useBaby(): BabyState {
  const ctx = useContext(BabyContext)
  if (!ctx) throw new Error('useBaby must be used within a BabyProvider')
  return ctx
}
