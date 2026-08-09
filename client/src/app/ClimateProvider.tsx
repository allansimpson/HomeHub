import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api, ApiError } from '../api/client'
import type { ClimatePanelDto, ClimateZoneDto, ClimateZonePatch, RepeatOfferDto } from '../api/types'

/**
 * The Climate section's live state and every write a person can make from it.
 *
 * One poll feeds the whole screen — six rows that each fetched their own reading and loan would be
 * eighteen round trips and would drift out of step with one another while it happened. Every action
 * returns the next whole panel, so a row re-renders from one response rather than from a merge the
 * client invented.
 */
interface ClimateState {
  zones: ClimateZoneDto[]
  offer: RepeatOfferDto | null
  housePaused: boolean
  loading: boolean
  /**
   * Minutes since the last successful poll, or null while the panel is current. The loop line
   * appends it — the screen keeps showing the last payload rather than emptying itself.
   */
  staleMinutes: number | null
  /**
   * Whether the press-and-slide gesture may run at all.
   *
   * False after five minutes of failed polls: sliding against a target that may already have changed
   * is worse than not sliding, and unlike the other controls a gesture cannot queue — the value it
   * would replay was chosen against a picture of the room that has since expired
   * (CLIMATE_BEHAVIOURS §8).
   */
  gestureLive: boolean
  /**
   * Zones promoted during this session, and what they were before.
   *
   * `UNDO` is present for the rest of the session, not for five seconds — 3b hides a permanent change
   * inside a gesture, and a toast that has already gone is not a way out of it. The set lives here
   * rather than on the server because "this session" is a fact about the panel.
   */
  promotedThisSession: ReadonlySet<number>
  setTarget: (id: number, targetF: number) => Promise<void>
  borrow: (id: number, targetF: number) => Promise<void>
  keep: (id: number, targetF?: number) => Promise<void>
  cancelBorrow: (id: number) => Promise<void>
  undo: (id: number) => Promise<void>
  patchZone: (id: number, patch: ClimateZonePatch) => Promise<void>
  answerOffer: (offer: RepeatOfferDto, accept: boolean) => Promise<void>
  pauseHouse: (paused: boolean) => Promise<void>
  allUnitsOff: () => Promise<void>
  refresh: () => Promise<void>
}

const ClimateContext = createContext<ClimateState | null>(null)

/** The loop ticks once a minute; a quarter of that keeps a countdown honest without hammering it. */
const POLL_MS = 15_000

/** Five minutes of silence and the gesture stands down. */
const GESTURE_DEADLINE_MS = 5 * 60_000

export function ClimateProvider({ children }: { children: ReactNode }) {
  const [panel, setPanel] = useState<ClimatePanelDto | null>(null)
  const [heardAt, setHeardAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [loading, setLoading] = useState(true)
  const [promoted, setPromoted] = useState<Set<number>>(() => new Set())
  const inFlight = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const next = await api.getClimatePanel()
      setPanel(next)
      setHeardAt(Date.now())
    } catch (err) {
      // Keep the last payload. A screen that empties itself when the network hiccups is telling the
      // household less than it knows, and the loop line already says how old this is.
      if (!(err instanceof ApiError)) throw err
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      if (cancelled || inFlight.current) return
      inFlight.current = true
      try {
        await refresh()
      } finally {
        inFlight.current = false
      }
      if (!cancelled) setNow(Date.now())
    }
    void tick()
    const id = window.setInterval(tick, POLL_MS)
    const onSync = () => void tick()
    window.addEventListener('homehub:sync', onSync)
    return () => {
      cancelled = true
      window.clearInterval(id)
      window.removeEventListener('homehub:sync', onSync)
    }
  }, [refresh])

  /** Every write answers with the next whole panel, so there is nothing to reconcile. */
  const apply = useCallback(async (call: () => Promise<ClimatePanelDto>) => {
    try {
      setPanel(await call())
      setHeardAt(Date.now())
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      // The write did not land. Re-read rather than leave the row showing an intent the house never
      // received — an optimistic target that silently failed is the one thing this section must not do.
      await refresh()
    }
  }, [refresh])

  const setTarget = useCallback((id: number, targetF: number) =>
    apply(() => api.setClimateTarget(id, targetF)), [apply])

  const borrow = useCallback((id: number, targetF: number) =>
    apply(() => api.startClimateOverride(id, targetF)), [apply])

  /** `targetF` for 3b, which lifts on `KEEP` with no loan to promote; omitted for 3a. */
  const keep = useCallback(async (id: number, targetF?: number) => {
    await apply(() => api.promoteClimateOverride(id, targetF))
    setPromoted((cur) => new Set(cur).add(id))
  }, [apply])

  const cancelBorrow = useCallback((id: number) =>
    apply(() => api.cancelClimateOverride(id)), [apply])

  const undo = useCallback(async (id: number) => {
    await apply(() => api.undoClimatePromotion(id))
    setPromoted((cur) => {
      const next = new Set(cur)
      next.delete(id)
      return next
    })
  }, [apply])

  const patchZone = useCallback((id: number, patch: ClimateZonePatch) =>
    apply(() => api.patchClimateZone(id, patch)), [apply])

  const answerOffer = useCallback((offer: RepeatOfferDto, accept: boolean) =>
    apply(() => api.answerClimateOffer(offer.zoneId, accept, offer.targetF, offer.windowHour)), [apply])

  const pauseHouse = useCallback((paused: boolean) =>
    apply(() => api.pauseClimateLoop(paused)), [apply])

  const allUnitsOff = useCallback(async () => {
    try {
      await api.allClimateUnitsOff()
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
    }
    await refresh()
  }, [refresh])

  const silentFor = heardAt == null ? Infinity : now - heardAt
  const staleMinutes = silentFor > POLL_MS * 2 ? Math.max(1, Math.round(silentFor / 60_000)) : null

  const value = useMemo<ClimateState>(() => ({
    zones: panel?.zones ?? [],
    offer: panel?.offer ?? null,
    housePaused: panel?.housePaused ?? false,
    loading,
    staleMinutes,
    gestureLive: silentFor < GESTURE_DEADLINE_MS,
    promotedThisSession: promoted,
    setTarget, borrow, keep, cancelBorrow, undo, patchZone, answerOffer, pauseHouse, allUnitsOff, refresh,
  }), [
    panel, loading, staleMinutes, silentFor, promoted,
    setTarget, borrow, keep, cancelBorrow, undo, patchZone, answerOffer, pauseHouse, allUnitsOff, refresh,
  ])

  return <ClimateContext.Provider value={value}>{children}</ClimateContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useClimate(): ClimateState {
  const ctx = useContext(ClimateContext)
  if (!ctx) throw new Error('useClimate must be used within a ClimateProvider')
  return ctx
}
