import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api, ApiError } from '../api/client'
import type { ClimateModeName, ClimateZoneDto } from '../api/types'

const MIN_SETPOINT = 60
const MAX_SETPOINT = 85

/**
 * Live climate zones with optimistic control. Set-point steps apply instantly to the local UI and
 * are debounced to the backend (which drives Home Assistant or the simulator); polling reconciles
 * with reported state, but is held off while a write is pending so it can't clobber an in-progress
 * adjustment.
 */
interface ClimateState {
  zones: ClimateZoneDto[]
  offline: boolean
  adjustSetPoint: (id: number, delta: number) => void
  setMode: (id: number, mode: ClimateModeName) => Promise<void>
  applyScene: (scene: 'evening' | 'all-off') => Promise<void>
  refresh: () => Promise<void>
}

const ClimateContext = createContext<ClimateState | null>(null)

const POLL_MS = 15_000

export function ClimateProvider({ children }: { children: ReactNode }) {
  const [zones, setZones] = useState<ClimateZoneDto[]>([])
  const [offline, setOffline] = useState(false)
  const pending = useRef<Map<number, number>>(new Map()) // zoneId -> debounce timer
  const hasPending = useRef(false)

  const refresh = useCallback(async () => {
    if (hasPending.current) return // don't reconcile mid-adjustment
    try {
      const next = await api.getClimateZones()
      if (!hasPending.current) setZones(next)
      setOffline(false)
    } catch (err) {
      if (err instanceof ApiError) setOffline(true)
      else throw err
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

  const adjustSetPoint = useCallback((id: number, delta: number) => {
    hasPending.current = true
    let nextValue = 0
    setZones((cur) =>
      cur.map((z) => {
        if (z.id !== id) return z
        nextValue = Math.min(MAX_SETPOINT, Math.max(MIN_SETPOINT, (z.setPointF ?? 72) + delta))
        return { ...z, setPointF: nextValue }
      }),
    )
    const timers = pending.current
    window.clearTimeout(timers.get(id))
    timers.set(
      id,
      window.setTimeout(async () => {
        try {
          await api.setClimateSetPoint(id, nextValue)
        } catch (err) {
          if (!(err instanceof ApiError)) throw err
        } finally {
          timers.delete(id)
          if (timers.size === 0) hasPending.current = false
          await refresh()
        }
      }, 500),
    )
  }, [refresh])

  const setMode = useCallback(async (id: number, mode: ClimateModeName) => {
    setZones((cur) => cur.map((z) => (z.id === id ? { ...z, mode, running: mode !== 'Off', setPointF: mode === 'Off' ? null : z.setPointF } : z)))
    try {
      await api.setClimateMode(id, mode)
      await refresh()
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
    }
  }, [refresh])

  const applyScene = useCallback(async (scene: 'evening' | 'all-off') => {
    try {
      await api.applyClimateScene(scene)
      await refresh()
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
    }
  }, [refresh])

  const value = useMemo<ClimateState>(
    () => ({ zones, offline, adjustSetPoint, setMode, applyScene, refresh }),
    [zones, offline, adjustSetPoint, setMode, applyScene, refresh],
  )

  return <ClimateContext.Provider value={value}>{children}</ClimateContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useClimate(): ClimateState {
  const ctx = useContext(ClimateContext)
  if (!ctx) throw new Error('useClimate must be used within a ClimateProvider')
  return ctx
}
