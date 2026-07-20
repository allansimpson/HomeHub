import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api, ApiError } from '../api/client'
import type { ClimateModeName, ClimateZoneDto } from '../api/types'
import { useWriteQueue } from './WriteQueueProvider'

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
  const { run } = useWriteQueue()
  const [zones, setZones] = useState<ClimateZoneDto[]>([])
  const [offline, setOffline] = useState(false)
  const pending = useRef<Map<number, number>>(new Map()) // zoneId -> debounce timer
  const hasPending = useRef(false)
  const zonesRef = useRef<ClimateZoneDto[]>([])
  zonesRef.current = zones

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
    const onSync = () => void refresh()
    window.addEventListener('homehub:sync', onSync)
    return () => {
      cancelled = true
      window.clearInterval(id)
      window.removeEventListener('homehub:sync', onSync)
    }
  }, [refresh])

  // Climate is transient state → last-write-wins (no version); queued when offline.
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
        const zone = zonesRef.current.find((z) => z.id === id)
        const outcome = await run({
          domain: 'climate',
          method: 'PUT',
          path: `/climate/zones/${id}/setpoint`,
          body: { setPointF: nextValue },
          label: `Set ${zone?.name ?? 'zone'} to ${nextValue}°`,
        })
        timers.delete(id)
        if (timers.size === 0) hasPending.current = false
        if (outcome.kind === 'ok') await refresh()
      }, 500),
    )
  }, [run, refresh])

  const setMode = useCallback(
    async (id: number, mode: ClimateModeName) => {
      setZones((cur) => cur.map((z) => (z.id === id ? { ...z, mode, running: mode !== 'Off', setPointF: mode === 'Off' ? null : z.setPointF } : z)))
      const zone = zonesRef.current.find((z) => z.id === id)
      const outcome = await run({
        domain: 'climate',
        method: 'PUT',
        path: `/climate/zones/${id}/mode`,
        body: { mode },
        label: `Set ${zone?.name ?? 'zone'} to ${mode}`,
      })
      if (outcome.kind === 'ok') await refresh()
    },
    [run, refresh],
  )

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
