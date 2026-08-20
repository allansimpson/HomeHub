import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

/** Grey last-known values once they've been stale this long (spec default: 5 minutes). */
const STALE_MS = 5 * 60_000
/** How often to probe the server. */
const PING_MS = 10_000
/** Give up a probe after this long (a hung request counts as offline). */
const PING_TIMEOUT_MS = 4_000

/**
 * Failed probes before the panel calls itself offline.
 *
 * One is not evidence. A probe can fail because the server is down, or because Wi-Fi was rekeying, or
 * because the phone's radio had just woken up, or because the browser froze the tab mid-`fetch` — and
 * only the first of those is worth telling anybody about. Two consecutive failures across the retry
 * gap below is a connection that is genuinely not answering.
 */
const FAILURES_BEFORE_OFFLINE = 2

/**
 * How soon to re-probe after a failure, instead of waiting out {@link PING_MS}.
 *
 * The point of requiring two failures is to distinguish a blip from an outage, and that distinction
 * has to be *made* quickly or it costs more than it saves — at the full interval the panel would take
 * ten seconds to admit a server that really had gone away.
 */
const RETRY_MS = 1_500

/**
 * How long the panel must have been offline before it says so.
 *
 * The banner exists for a household standing in front of a panel showing figures that are no longer
 * live. It does not exist for the two seconds after a phone wakes up, which is when it was firing
 * most: the tab is frozen while backgrounded, the probe in flight dies with it, and the first thing
 * anybody saw on returning to the app was RECONNECTING — which then cleared by itself before they had
 * finished reading it. A banner that is usually wrong by the time it is read is worse than no banner,
 * because it teaches people to ignore the one that is right.
 *
 * Three seconds is past where a wake-up settles and well short of where somebody would be acting on
 * stale figures without knowing it.
 */
const ANNOUNCE_AFTER_MS = 3_000

/**
 * How long before the panel stops saying "reconnecting" and admits it is offline.
 *
 * <b>Two different sentences about two different situations, and the wrong one is worse than
 * silence.</b> "Reconnecting" is a promise that something is in progress and about to resolve — true
 * for the server restarting after a deploy, or a router that dropped a packet. Twenty seconds in it
 * has stopped being true: nothing is reconnecting, the panel is simply somewhere the server is not,
 * and a spinner-flavoured word implies a wait that has no end. That matters most on a phone that has
 * left the house, where the honest state is not a fault at all — the app works, it is holding what
 * was written, and it will sync later. It should say so.
 *
 * Twenty seconds because a service restart is the case worth waiting out: `deploy/updating.md`
 * restarts Kestrel, which is back inside a few seconds, and calling that "offline" would flash the
 * wrong word across every panel in the house on every deploy.
 */
const OFFLINE_AFTER_MS = 20_000

/**
 * App-wide connection state (Stage 9a). A lightweight health probe decides whether the server is
 * reachable; every screen keeps showing its last-known cached data regardless, and prominent live
 * values grey out once {@link stale}. This is the single honest source for the reconnecting
 * indicator — never a blocking error screen.
 */
interface ConnectionState {
  /**
   * Whether the last probe (or probes — see {@link FAILURES_BEFORE_OFFLINE}) reached the server.
   *
   * The truthful state, and what anything making a *decision* should read: the write queue holds its
   * ops against it, and holding a write for three seconds longer than necessary would be a real cost
   * paid to make a banner calmer.
   */
  online: boolean
  /** Offline long enough that shown values should be greyed. */
  stale: boolean
  /**
   * Offline for long enough to be worth saying out loud.
   *
   * What the RECONNECTING banner and the dashboard's chip read, and the only thing that should:
   * {@link online} answers "is the server there", this answers "does a person need telling". They
   * differ for exactly {@link ANNOUNCE_AFTER_MS}, which is the window nearly every real interruption
   * on a phone fits inside.
   */
  reconnecting: boolean
  /**
   * Offline for long enough that "reconnecting" has stopped being a true description.
   *
   * What decides the *wording* of the banner, where {@link reconnecting} decides whether there is
   * one at all. A phone out of the house sits here indefinitely and nothing is wrong with it — see
   * {@link OFFLINE_AFTER_MS}. Anything making a decision should still read {@link online}.
   */
  offline: boolean
  lastOnlineAt: number
}

const ConnectionContext = createContext<ConnectionState | null>(null)

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState(true)
  const [lastOnlineAt, setLastOnlineAt] = useState(() => Date.now())
  /** When the current offline spell began, or null while connected. Drives the announce delay. */
  const [offlineSince, setOfflineSince] = useState<number | null>(null)
  // Re-evaluated each probe so `stale` advances even while the server stays down.
  const [now, setNow] = useState(() => Date.now())

  const failures = useRef(0)
  /** The scheduled next probe. One at a time — a wake-up must not leave two loops running. */
  const timer = useRef<number | undefined>(undefined)
  const cancelled = useRef(false)

  const ping = useCallback(async () => {
    const controller = new AbortController()
    const abort = window.setTimeout(() => controller.abort(), PING_TIMEOUT_MS)
    let reached = false
    try {
      const res = await fetch('/api/health', { signal: controller.signal, cache: 'no-store' })
      reached = res.ok
    } catch {
      reached = false
    } finally {
      window.clearTimeout(abort)
    }
    if (cancelled.current) return

    if (reached) {
      failures.current = 0
      setOnline(true)
      setOfflineSince(null)
      setLastOnlineAt(Date.now())
    } else if (document.visibilityState === 'hidden') {
      // A probe that failed while the tab was in the background proves nothing. Browsers freeze
      // timers and tear down in-flight requests in a hidden tab — on a phone, aggressively — so this
      // failure is at least as likely to be about the tab as about the server. Not counted, and the
      // visibility handler below re-probes the moment anybody is actually looking.
    } else {
      failures.current += 1
      if (failures.current >= FAILURES_BEFORE_OFFLINE) {
        setOnline(false)
        setOfflineSince((since) => since ?? Date.now())
      }
    }

    setNow(Date.now())

    // Re-armed from the end of each probe rather than run on a fixed interval, so a slow or timed-out
    // probe cannot overlap the next one — and so the retry after a first failure can be quick without
    // making the healthy cadence quick too.
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(
      () => void ping(),
      !reached && failures.current > 0 && failures.current < FAILURES_BEFORE_OFFLINE ? RETRY_MS : PING_MS,
    )
  }, [])

  useEffect(() => {
    cancelled.current = false
    void ping()

    /**
     * Probe now, rather than waiting out the cadence.
     *
     * This is the half of the fix that is about the *connection* rather than about the banner. Coming
     * back to a backgrounded app, the panel used to sit on whatever it had concluded before it was
     * frozen until the next tick came round — up to a full interval of RECONNECTING over a server
     * that had been answering the whole time. Asking immediately is both faster and more honest.
     *
     * `online`/`offline` are the browser's own opinion of the radio. Worth acting on and not worth
     * trusting: a laptop on a captive-portal Wi-Fi is `online` and cannot reach the house. They are
     * treated as a hint that something changed, and the probe decides.
     */
    const wake = () => {
      if (document.visibilityState === 'hidden') return
      window.clearTimeout(timer.current)
      void ping()
    }

    document.addEventListener('visibilitychange', wake)
    window.addEventListener('focus', wake)
    window.addEventListener('online', wake)
    window.addEventListener('offline', wake)

    return () => {
      cancelled.current = true
      window.clearTimeout(timer.current)
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('focus', wake)
      window.removeEventListener('online', wake)
      window.removeEventListener('offline', wake)
    }
  }, [ping])

  /**
   * Announce the outage once it has lasted.
   *
   * A timer of its own rather than a comparison against the probe clock: the probe only ticks every
   * ten seconds while offline, so deriving this from `now` would round the delay up to the next
   * probe and the banner would appear late and at an unpredictable moment.
   */
  const announced = useElapsedSince(offlineSince, ANNOUNCE_AFTER_MS)
  const admitted = useElapsedSince(offlineSince, OFFLINE_AFTER_MS)

  const value = useMemo<ConnectionState>(
    () => ({
      online,
      stale: !online && now - lastOnlineAt > STALE_MS,
      reconnecting: !online && announced,
      offline: !online && admitted,
      lastOnlineAt,
    }),
    [online, now, lastOnlineAt, announced, admitted],
  )

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>
}

/**
 * True once `since` is at least `delay` old, on its own timer.
 *
 * <b>A timer rather than a comparison against the probe clock.</b> The probe only ticks every ten
 * seconds while offline, so deriving either threshold from it would round the delay up to the next
 * probe — the banner would change its wording late, and at an unpredictable moment. Both thresholds
 * want the same treatment, so they share it and cannot drift apart.
 */
function useElapsedSince(since: number | null, delay: number): boolean {
  const [passed, setPassed] = useState(false)
  useEffect(() => {
    if (since === null) {
      setPassed(false)
      return
    }
    const waited = Date.now() - since
    if (waited >= delay) {
      setPassed(true)
      return
    }
    const id = window.setTimeout(() => setPassed(true), delay - waited)
    return () => window.clearTimeout(id)
  }, [since, delay])
  return passed
}

// eslint-disable-next-line react-refresh/only-export-components
export function useConnection(): ConnectionState {
  const ctx = useContext(ConnectionContext)
  if (!ctx) throw new Error('useConnection must be used within a ConnectionProvider')
  return ctx
}
