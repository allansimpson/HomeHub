import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

/** Grey last-known values once they've been stale this long (spec default: 5 minutes). */
const STALE_MS = 5 * 60_000
/** How often to probe the server. */
const PING_MS = 10_000
/** Give up a probe after this long (a hung request counts as offline). */
const PING_TIMEOUT_MS = 4_000

/**
 * App-wide connection state (Stage 9a). A lightweight health probe decides whether the server is
 * reachable; every screen keeps showing its last-known cached data regardless, and prominent live
 * values grey out once {@link stale}. This is the single honest source for the reconnecting
 * indicator — never a blocking error screen.
 */
interface ConnectionState {
  online: boolean
  /** Offline long enough that shown values should be greyed. */
  stale: boolean
  lastOnlineAt: number
}

const ConnectionContext = createContext<ConnectionState | null>(null)

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState(true)
  const [lastOnlineAt, setLastOnlineAt] = useState(() => Date.now())
  // Re-evaluated each probe so `stale` advances even while the server stays down.
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let cancelled = false

    const ping = async () => {
      const controller = new AbortController()
      const timer = window.setTimeout(() => controller.abort(), PING_TIMEOUT_MS)
      try {
        const res = await fetch('/api/health', { signal: controller.signal, cache: 'no-store' })
        if (cancelled) return
        if (res.ok) {
          setOnline(true)
          setLastOnlineAt(Date.now())
        } else {
          setOnline(false)
        }
      } catch {
        if (!cancelled) setOnline(false)
      } finally {
        window.clearTimeout(timer)
        if (!cancelled) setNow(Date.now())
      }
    }

    void ping()
    const id = window.setInterval(ping, PING_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  const value = useMemo<ConnectionState>(
    () => ({ online, stale: !online && now - lastOnlineAt > STALE_MS, lastOnlineAt }),
    [online, now, lastOnlineAt],
  )

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useConnection(): ConnectionState {
  const ctx = useContext(ConnectionContext)
  if (!ctx) throw new Error('useConnection must be used within a ConnectionProvider')
  return ctx
}
