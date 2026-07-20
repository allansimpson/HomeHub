import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api, ApiError } from '../api/client'
import type { CalendarEventDto } from '../api/types'

/**
 * Upcoming household events for the dashboard NEXT section, refreshed on an interval. The
 * Calendar screen fetches its own visible month range; after any create/edit/delete it calls
 * {@link refresh} so the dashboard reflects the change immediately.
 */
interface CalendarState {
  upcoming: CalendarEventDto[]
  loading: boolean
  offline: boolean
  refresh: () => Promise<void>
}

const CalendarContext = createContext<CalendarState | null>(null)

const POLL_MS = 2 * 60_000

export function CalendarProvider({ children }: { children: ReactNode }) {
  const [upcoming, setUpcoming] = useState<CalendarEventDto[]>([])
  const [loading, setLoading] = useState(true)
  const [offline, setOffline] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const next = await api.getUpcoming(7)
      setUpcoming(next)
      setOffline(false)
    } catch (err) {
      if (err instanceof ApiError) setOffline(true)
      else throw err
    } finally {
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

  const value = useMemo<CalendarState>(
    () => ({ upcoming, loading, offline, refresh }),
    [upcoming, loading, offline, refresh],
  )

  return <CalendarContext.Provider value={value}>{children}</CalendarContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useCalendar(): CalendarState {
  const ctx = useContext(CalendarContext)
  if (!ctx) throw new Error('useCalendar must be used within a CalendarProvider')
  return ctx
}
