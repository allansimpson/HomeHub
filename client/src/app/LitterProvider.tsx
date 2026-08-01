import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api, ApiError } from '../api/client'
import type { CatHealthDto, LitterRobotDto, LitterSelectName, LitterSwitchName } from '../api/types'

/**
 * Litter-Robot state and commands, over Home Assistant.
 *
 * Every command here is fire-and-forget: the robot accepts commands it then silently ignores — a
 * clean cycle requested while a cat is detected is accepted and dropped, with no error. So a call
 * that returns proves only that the command was delivered. Each command answers with a freshly-read
 * snapshot and the UI reports what the robot says, never "it worked".
 */
interface LitterState {
  health: CatHealthDto | null
  robots: LitterRobotDto[]
  /**
   * The status each robot was in on the previous read, keyed by slug.
   *
   * Home Assistant reports where the robot *is*, never how it got there — so a cycle that stops
   * partway looks identical to one that never started. Remembering the last status is the only way
   * the panel can say "that cycle was interrupted" rather than silently swapping the view.
   *
   * Only what this session actually observed: a cycle interrupted while the panel was asleep leaves
   * no trace here, and the screen says nothing rather than guessing.
   */
  previousStatus: Readonly<Record<string, string>>
  loading: boolean
  /** In-flight command keys (`slug:action`), so a control can disable itself without a local flag. */
  pending: ReadonlySet<string>
  /** The last command failure, verbatim. */
  error: string | null
  startCycle: (slug: string) => Promise<void>
  resetDrawer: (slug: string) => Promise<void>
  addLitter: (slug: string) => Promise<void>
  setSwitch: (slug: string, which: LitterSwitchName, on: boolean) => Promise<void>
  setSelect: (slug: string, which: LitterSelectName, option: string) => Promise<void>
  setRecovery: (slug: string, enabled: boolean) => Promise<void>
  clearError: () => void
  refresh: () => Promise<void>
}

const LitterContext = createContext<LitterState | null>(null)

const POLL_MS = 20_000

export function LitterProvider({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<CatHealthDto | null>(null)
  const [robots, setRobots] = useState<LitterRobotDto[]>([])
  const [previousStatus, setPreviousStatus] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  /** Non-zero while a post-command watch is reading fresh; the cached poll stands aside. */
  const watching = useRef(0)
  /** Bumped per watch so a superseded chain stops instead of racing the newer one. */
  const watchGeneration = useRef(0)
  /** Set on teardown so timer chains don't keep firing — and setting state — after unmount. */
  const unmounted = useRef(false)
  useEffect(() => () => { unmounted.current = true }, [])

  const refresh = useCallback(async (fresh = false) => {
    try {
      setHealth(await api.getCatHealth())
      const next = await api.getLitterRobots(fresh)
      // A cached read must not overwrite what a live watch is showing. `watchForChange` is reading
      // fresh every second or two after a command; this poll's answer came from the server's
      // ten-second display cache and may predate the command entirely.
      if (!fresh && watching.current > 0) return
      // Record where each robot was *before* this read, so a transition out of a running cycle can
      // be named. Written before the new snapshot lands, and only when the code actually changed —
      // otherwise a re-poll of the same state would erase the transition we are trying to keep.
      setRobots((cur) => {
        const changed: Record<string, string> = {}
        for (const robot of next) {
          const was = cur.find((r) => r.slug === robot.slug)
          if (was && was.statusCode !== robot.statusCode) changed[robot.slug] = was.statusCode
        }
        if (Object.keys(changed).length > 0) setPreviousStatus((p) => ({ ...p, ...changed }))
        return next
      })
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
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

  const mark = useCallback((key: string, on: boolean) => {
    setPending((cur) => {
      const next = new Set(cur)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])

  /**
   * Send one command and fold the snapshot it answers with back into the list.
   *
   * Nothing announces that a command was *sent*. The panel used to flash "requested…" here, which
   * said only that a message left the building — and the robot accepts commands it silently drops,
   * so that was the one thing not worth reporting. The reading is the answer, and
   * {@link watchForChange} now fetches it within a second or two of the press.
   */
  const command = useCallback(
    async (slug: string, action: string, perform: () => Promise<LitterRobotDto | void>) => {
      const key = `${slug}:${action}`
      mark(key, true)
      setError(null)
      try {
        const updated = await perform()
        if (updated) setRobots((cur) => cur.map((r) => (r.slug === slug ? updated : r)))
      } catch (err) {
        if (!(err instanceof ApiError)) throw err
        setError(err.message || 'The command did not reach the robot.')
      } finally {
        mark(key, false)
      }
    },
    [mark],
  )

  /**
   * Watch for the robot to react, instead of waiting for the next scheduled poll.
   *
   * A command is fire-and-forget, so the only proof it landed is a changed status — and on the
   * normal twenty-second cadence, behind a ten-second server cache, that proof can be half a minute
   * arriving. Long enough that a working command looks broken and gets pressed again.
   *
   * So for a short window after a press the panel reads *fresh*, quickly at first and then easing
   * off, and stops the moment the status actually moves. Costs a handful of extra reads on a
   * deliberate action, and nothing at all the rest of the time.
   */
  const watchForChange = useCallback(async (slug: string, from: string | undefined) => {
    const waits = [1200, 1800, 2500, 3000, 4000, 5000, 6000, 8000]
    // Claim the watch. The ordinary poll defers while `watching` is non-zero (see `refresh`) because
    // its reads come from the server's ten-second display cache: a cached pre-command snapshot
    // resolving a moment after a fresh one had already shown "Globe rotating" flips the status band
    // back to Stable — and records a bogus transition in `previousStatus`, which `cycleInterrupted`
    // then reads.
    const generation = ++watchGeneration.current
    watching.current++
    try {
      for (const wait of waits) {
        await new Promise((r) => setTimeout(r, wait))
        // Abandoned if the provider unmounted or another command started its own watch — otherwise
        // this chain keeps firing for half a minute after the screen is gone.
        if (generation !== watchGeneration.current || unmounted.current) return
        const seen = await api.getLitterRobots(true).catch(() => null)
        if (generation !== watchGeneration.current || unmounted.current) return
        if (!seen) continue
        setRobots((cur) => {
          const changed: Record<string, string> = {}
          for (const robot of seen) {
            const was = cur.find((r) => r.slug === robot.slug)
            if (was && was.statusCode !== robot.statusCode) changed[robot.slug] = was.statusCode
          }
          if (Object.keys(changed).length > 0) setPreviousStatus((p) => ({ ...p, ...changed }))
          return seen
        })
        if (seen.find((r) => r.slug === slug)?.statusCode !== from) return
      }
    } finally {
      watching.current--
    }
  }, [])

  const startCycle = useCallback(
    async (slug: string) => {
      const before = robots.find((r) => r.slug === slug)?.statusCode
      // The cycle endpoint answers with an outcome rather than a snapshot: it verifies by re-reading
      // status, and declines with 409 when the robot refuses. A refusal is information, not an error
      // to hide — but it arrives as a thrown ApiError, so the watch below shows where things landed.
      await command(slug, 'cycle', () => api.startLitterCycle(slug).then(() => undefined))
      await watchForChange(slug, before)
    },
    [command, robots, watchForChange],
  )

  const resetDrawer = useCallback(
    (slug: string) => command(slug, 'drawer', () => api.resetLitterDrawer(slug)),
    [command],
  )

  const addLitter = useCallback(
    (slug: string) => command(slug, 'litter', () => api.resetLitterLevel(slug)),
    [command],
  )

  const setSwitch = useCallback(
    (slug: string, which: LitterSwitchName, on: boolean) =>
      command(slug, which, () => api.setLitterSwitch(slug, which, on)),
    [command],
  )

  const setSelect = useCallback(
    (slug: string, which: LitterSelectName, option: string) =>
      command(slug, which, () => api.setLitterSelect(slug, which, option)),
    [command],
  )

  const setRecovery = useCallback(
    (slug: string, enabled: boolean) =>
      command(slug, 'recovery', () => api.setLitterRecovery(slug, enabled)),
    [command],
  )

  const clearError = useCallback(() => setError(null), [])

  const value = useMemo<LitterState>(
    () => ({
      health, robots, previousStatus, loading, pending, error,
      startCycle, resetDrawer, addLitter, setSwitch, setSelect, setRecovery, clearError, refresh,
    }),
    [health, robots, previousStatus, loading, pending, error,
      startCycle, resetDrawer, addLitter, setSwitch, setSelect, setRecovery, clearError, refresh],
  )

  return <LitterContext.Provider value={value}>{children}</LitterContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useLitter(): LitterState {
  const ctx = useContext(LitterContext)
  if (!ctx) throw new Error('useLitter must be used within a LitterProvider')
  return ctx
}
