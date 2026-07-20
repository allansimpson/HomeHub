import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api, ApiError } from '../api/client'
import type { WeatherSnapshotDto } from '../api/types'

/**
 * Cached weather (current + hourly + daily), refreshed on an interval. The backend caches
 * last-known in SQL, so a brief NWS outage still shows the last good reading (offline chip
 * appears only when there's nothing cached). Weather *alerts* arrive via the shared alert
 * feed, not here.
 */
interface WeatherState {
  weather: WeatherSnapshotDto | null
  loading: boolean
  offline: boolean
}

const WeatherContext = createContext<WeatherState | null>(null)

const POLL_MS = 5 * 60_000

export function WeatherProvider({ children }: { children: ReactNode }) {
  const [weather, setWeather] = useState<WeatherSnapshotDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [offline, setOffline] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const next = await api.getWeather()
      setWeather(next)
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
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [refresh])

  const value = useMemo<WeatherState>(() => ({ weather, loading, offline }), [weather, loading, offline])

  return <WeatherContext.Provider value={value}>{children}</WeatherContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useWeather(): WeatherState {
  const ctx = useContext(WeatherContext)
  if (!ctx) throw new Error('useWeather must be used within a WeatherProvider')
  return ctx
}
