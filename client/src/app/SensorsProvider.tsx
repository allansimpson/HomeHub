import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api, ApiError } from '../api/client'
import type { ActiveAlertDto, ZoneReadingDto } from '../api/types'

/**
 * Live house state — zones (with latest readings) and active alerts — refreshed on an interval.
 * Polling is the acceptable fallback to SignalR per the architecture; the poll cadence matches
 * the backend so the panel stays roughly a beat behind real readings. Degrades to empty +
 * offline if the API is unreachable (no DB / server down) rather than crashing.
 */
interface SensorsState {
  zones: ZoneReadingDto[]
  alerts: ActiveAlertDto[]
  loading: boolean
  offline: boolean
  refresh: () => Promise<void>
}

const SensorsContext = createContext<SensorsState | null>(null)

const POLL_MS = 30_000

export function SensorsProvider({ children }: { children: ReactNode }) {
  const [zones, setZones] = useState<ZoneReadingDto[]>([])
  const [alerts, setAlerts] = useState<ActiveAlertDto[]>([])
  const [loading, setLoading] = useState(true)
  const [offline, setOffline] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [nextZones, nextAlerts] = await Promise.all([api.getZones(), api.getAlerts()])
      setZones(nextZones)
      setAlerts(nextAlerts)
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

  const value = useMemo<SensorsState>(
    () => ({ zones, alerts, loading, offline, refresh }),
    [zones, alerts, loading, offline, refresh],
  )

  return <SensorsContext.Provider value={value}>{children}</SensorsContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSensors(): SensorsState {
  const ctx = useContext(SensorsContext)
  if (!ctx) throw new Error('useSensors must be used within a SensorsProvider')
  return ctx
}
