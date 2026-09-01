import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api, ApiError } from '../api/client'
import { CARE_HISTORY_DAYS, careWindowStart } from './care'
import type { CareEntryDto, CareTimerDto } from '../api/types'

/**
 * The few baby figures screens outside the Baby tab need — read from HomeHub's own care log.
 *
 * <b>This used to read Huckleberry through Home Assistant, and that is why it was wrong.</b> The
 * integration was phased out in favour of the panel's own log, but nothing unwired this provider,
 * so two surfaces went on asking a service that no longer answers: the Dashboard's CARE stats
 * showed an em dash for a bottle the household had logged forty minutes earlier, and — worse —
 * `careSubjects` read the missing integration as a *fault*, which `needsYou` promoted to a
 * `tone: 'bad'` row saying `Conrad — integration not found · GO AND LOOK`. A permanent alarm about
 * a system that was retired on purpose, on the screen the panel sits on all day.
 *
 * There is no health here now because there is no integration to be unhealthy. A log the panel
 * writes itself is either reachable or the whole app is offline, which `ConnectionProvider` already
 * says once for everything.
 *
 * <b>Kept as a provider rather than folded into `useCareLog`.</b> That hook carries the write
 * queue, the offline cache and a 10-second poll, all of which the Dashboard wants none of — and the
 * Dashboard is the idle screen, so its polling runs all day. This is one read every 30 seconds.
 */
interface BabyFigures {
  /** When the last bottle was, or null if there is none in the read window. */
  lastBottleUtc: string | null
  lastDiaperUtc: string | null
  /**
   * Bottles in the current 6 AM → 6 AM window.
   *
   * The same window the Baby tab's TODAY page counts (`careWindowStart`), so the Dashboard and the
   * tab it links to cannot disagree about how many feeds there have been — which they would every
   * night between midnight and 6 AM if this counted a calendar day.
   */
  feedsToday: number | null
  /**
   * The running pump session, if there is one — so its two boundaries can be felt from any screen.
   *
   * <b>Here rather than in the Baby tab, which is where the alert used to live and why it did not
   * work.</b> `PumpAlert` was mounted inside `CareLogView`, so leaving that tab unmounted it: the
   * boundary passed in silence for anyone who had walked away, which is the entire situation a
   * haptic exists for. The panel sits on the Dashboard all day, so that was most of the time.
   *
   * The note on the old mount said lifting this would mean putting the care log in a provider and
   * was "a bigger change than this is worth". That provider now exists for the Dashboard's figures,
   * so the change is one more field.
   *
   * Null unless a pump is actually running. Every other timer type has no boundary to announce.
   */
  pumpTimer: CareTimerDto | null
  /** True until the first read settles, so a figure is never shown as absent before it is known. */
  loading: boolean
  refresh: () => Promise<void>
}

const BabyContext = createContext<BabyFigures | null>(null)

const POLL_MS = 30_000

/** One baby, keyed so a second needs no migration — the same key the log and the Care tab use. */
const CHILD_KEY = 'conrad'

export function BabyProvider({ children: subtree }: { children: ReactNode }) {
  const [entries, setEntries] = useState<CareEntryDto[]>([])
  const [timers, setTimers] = useState<CareTimerDto[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const now = new Date()
      const to = new Date(now)
      to.setDate(to.getDate() + 1)
      const from = new Date(now)
      from.setDate(from.getDate() - CARE_HISTORY_DAYS)
      from.setHours(0, 0, 0, 0)
      /*
       * Two reads, because they answer different questions and neither covers the other: the
       * entries give the three figures, and the summary is the only thing that carries running
       * timers. Fetched together so one poll settles both — `Promise.all`, so a slow one does not
       * hold up the other, and either failing drops through to the catch below with the last
       * figures left on screen.
       */
      const [rows, summary] = await Promise.all([
        api.getCareEntries(CHILD_KEY, from.toISOString(), to.toISOString()),
        api.getCareSummary(CHILD_KEY),
      ])
      setEntries(rows)
      setTimers(summary.timers)
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      // Leave the last figures on screen. The connection banner is the one place an unreachable
      // server is announced; blanking three numbers here would say it a second time, in a way that
      // reads as "nothing has been logged" rather than as "the panel cannot see the log".
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

  const value = useMemo<BabyFigures>(() => {
    const newestOf = (type: CareEntryDto['type']) =>
      entries
        .filter((e) => e.type === type)
        .reduce<CareEntryDto | null>(
          (best, e) => (!best || Date.parse(e.atUtc) > Date.parse(best.atUtc) ? e : best),
          null,
        )?.atUtc ?? null

    const windowStart = careWindowStart().getTime()
    return {
      lastBottleUtc: newestOf('Bottle'),
      lastDiaperUtc: newestOf('Diaper'),
      feedsToday: entries.filter((e) => e.type === 'Bottle' && Date.parse(e.atUtc) >= windowStart).length,
      pumpTimer: timers.find((t) => t.type === 'Pump') ?? null,
      loading,
      refresh,
    }
  }, [entries, timers, loading, refresh])

  return <BabyContext.Provider value={value}>{subtree}</BabyContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useBaby(): BabyFigures {
  const ctx = useContext(BabyContext)
  if (!ctx) throw new Error('useBaby must be used within a BabyProvider')
  return ctx
}
