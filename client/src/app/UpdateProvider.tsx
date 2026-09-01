import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { workerRegistration } from './registerServiceWorker'
import { APPLIED_VISIBLE_MS, clearHandoff, outcomeOf, readHandoff, worthOffering, writeHandoff } from './appUpdate'
import type { UpdateStatus } from './appUpdate'

/**
 * How often a running panel asks whether it is still the current one.
 *
 * <b>Because an installed panel almost never navigates.</b> Everything that would ordinarily fetch a
 * fresh shell — opening a tab, typing an address, pulling to refresh — is absent here. The wall
 * panel is never closed, and tapping the home-screen icon on Android resumes the document that is
 * already running rather than loading a new one. Left alone, a device would go on serving the build
 * it happened to launch on until somebody cleared its site data, which is exactly the state this
 * whole mechanism exists to end. Half an hour is frequent enough that a deploy reaches every device
 * the same evening and rare enough to be invisible on the network.
 */
const CHECK_EVERY_MS = 30 * 60_000

/** After coming back to the panel, don't re-ask if the last question was this recent. */
const CHECK_ON_WAKE_AFTER_MS = 2 * 60_000

/**
 * How long APPLY NOW is given before the panel calls it a failure.
 *
 * Generous, because what is being waited on is a worker activating and a page reloading over a house
 * LAN that may be having a bad minute. If it has not happened by now it is not going to, and saying
 * so is better than a gauge that sweeps forever.
 */
const APPLY_TIMEOUT_MS = 20_000

/** How long to wait for a worker to say which build it is before giving up and not naming it. */
const VERSION_TIMEOUT_MS = 3_000

interface UpdateState {
  status: UpdateStatus
  /** The build coming, or the one that just landed. Null when it could not be established. */
  version: string | null
  /** What the panel is running now — the "still on 4.11" of a failure. */
  runningVersion: string
  /** When APPLY NOW was pressed, for "Applied at 16:57". */
  at: number | null
}

interface UpdateContextValue extends UpdateState {
  /** APPLY NOW, and TRY AGAIN — the same act, and the design gives it the same behaviour. */
  apply: () => void
}

const UpdateContext = createContext<UpdateContextValue | null>(null)

/** Ask a worker which build it is, down a port opened for the one question. */
function askVersion(worker: ServiceWorker): Promise<string | null> {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    const done = setTimeout(() => resolve(null), VERSION_TIMEOUT_MS)
    channel.port1.onmessage = (event) => {
      clearTimeout(done)
      const build = (event.data as { build?: unknown } | null)?.build
      resolve(typeof build === 'string' ? build : null)
    }
    try {
      worker.postMessage({ type: 'VERSION' }, [channel.port2])
    } catch {
      clearTimeout(done)
      resolve(null)
    }
  })
}

/** What the server is serving right now, for the devices that have no worker to ask. */
async function askServer(): Promise<string | null> {
  try {
    const res = await fetch('/build.json', { cache: 'no-store' })
    if (!res.ok) return null
    const body = (await res.json()) as { build?: unknown }
    return typeof body.build === 'string' ? body.build : null
  } catch {
    // Offline, or a server mid-restart. Not a failure of anything — the next check will ask again.
    return null
  }
}

/**
 * Whether a newer panel is being served, and the act of taking it.
 *
 * <b>Two ways of knowing, because there are two kinds of device here.</b> Where there is a service
 * worker, a worker sitting in `waiting` is the signal: it only reaches that state having downloaded
 * and warmed the whole of the next build, which is precisely the "downloaded and verified"
 * precondition the update plate stands for — the household is never offered an update that has not
 * already arrived. Where there is no worker at all (a phone on plain HTTP, which is not a secure
 * context) the panel asks the server for its build stamp and compares it to the one frozen into this
 * bundle. The second path cannot promise the new build is already on the device, only that it
 * exists; the plate reads the same either way, because from the household's side it is the same
 * fact and the same single press.
 *
 * Spec: `design_handoff_update_notice`. The sequence and its copy live in `UpdatePlate`.
 */
export function UpdateProvider({ children }: { children: ReactNode }) {
  const running = __BUILD__
  const [state, setState] = useState<UpdateState>({
    status: 'none', version: null, runningVersion: running, at: null,
  })
  /** The worker holding the next build, when there is one. Null on the ask-the-server path. */
  const waiting = useRef<ServiceWorker | null>(null)
  const registration = useRef<ServiceWorkerRegistration | null>(null)
  const lastCheck = useRef(0)

  const store = typeof window === 'undefined' ? null : window.sessionStorage

  /*
   * What the last reload turned out to have done — read once, on the far side of it.
   *
   * Nothing else can answer this. The reload wiped every trace of the press that caused it, so
   * without the note left behind, an update that worked and one that silently did nothing arrive
   * looking identical.
   */
  useEffect(() => {
    const outcome = outcomeOf(readHandoff(store), running, Date.now())
    clearHandoff(store)
    if (!outcome) return
    setState({
      status: outcome.status,
      version: outcome.status === 'applied' ? running : outcome.version,
      runningVersion: running,
      at: outcome.at,
    })
  }, [running, store])

  /*
   * "Clears on its own" — no dismiss control, because nothing needs pressing.
   *
   * Its own effect, keyed on the state rather than folded into the read above, so the timer belongs
   * to the plate being up rather than to the moment it was put up. The two come apart under React's
   * development double-mount, where the second pass reads a note the first has already torn up: a
   * timer set in that effect would be cleaned up and never re-established, and the verdigris plate
   * would stand for the rest of the session.
   */
  useEffect(() => {
    if (state.status !== 'applied') return
    const clear = setTimeout(
      () => setState((s) => (s.status === 'applied' ? { ...s, status: 'none' } : s)),
      APPLIED_VISIBLE_MS,
    )
    return () => clearTimeout(clear)
  }, [state.status])

  /** A worker has installed behind the running one: the next build is on the device. */
  const offer = useCallback(async (worker: ServiceWorker) => {
    const build = await askVersion(worker)

    /*
     * Nothing to offer: the page is already running the build this worker is waiting to install.
     *
     * See `worthOffering` for how a panel arrives in that state — briefly, the shell comes from the
     * network while the old worker still controls the page, so the code is new before the worker
     * is. Offering here is what produced "the changes are there but it says it didn't apply": the
     * press reloads onto the build it started on, and the outcome check says so.
     *
     * <b>The worker is let through rather than left waiting.</b> It is the build already on screen,
     * so its cache holds exactly the assets this page loads and there is no version skew to protect
     * anybody from — the danger `sw.js` describes, a page running old code while the new worker
     * deletes the cache underneath it, cannot arise when the two agree. No plate and no reload: the
     * household is not told about a change they are already looking at. Left waiting instead, this
     * would re-offer on every boot, and every one of them would end at the same failed plate.
     */
    if (!worthOffering(build, running)) {
      try {
        worker.postMessage({ type: 'SKIP_WAITING' })
      } catch {
        // A worker that cannot be spoken to stays waiting. It costs a stale cache until the next
        // build supersedes it, and nothing the household can see.
      }
      return
    }

    waiting.current = worker
    setState((s) => (
      // Never over the top of an apply in flight: by then the plate is a gauge, and the standing
      // offer it came from is finished business.
      s.status === 'none' || s.status === 'ready' || s.status === 'applied'
        ? { status: 'ready', version: build, runningVersion: running, at: null }
        : s
    ))
  }, [running])

  /* Watch the registration, and ask it again from time to time. */
  useEffect(() => {
    let live = true
    let timer: number | null = null

    const check = () => {
      lastCheck.current = Date.now()
      const reg = registration.current
      if (reg) {
        // Re-fetches sw.js. Its bytes carry the build stamp, so a deploy makes it a different file
        // and the browser installs it; an unchanged one costs a conditional request and nothing else.
        void reg.update().catch(() => undefined)
        return
      }
      // No worker on this device — ask the server outright.
      void askServer().then((build) => {
        if (!live || !build || build === running) return
        setState((s) => (
          s.status === 'none' || s.status === 'applied'
            ? { status: 'ready', version: build, runningVersion: running, at: null }
            : s
        ))
      })
    }

    void workerRegistration.then((reg) => {
      if (!live) return
      registration.current = reg
      if (reg) {
        // Already waiting when the app started: a build that arrived during a previous session, or
        // one installed by a launch that never reloaded. It is still the current offer.
        if (reg.waiting && navigator.serviceWorker.controller) void offer(reg.waiting)
        reg.addEventListener('updatefound', () => {
          const installing = reg.installing
          if (!installing) return
          installing.addEventListener('statechange', () => {
            // `controller` is the test for "this is an update" rather than a first install. On a
            // device opening the panel for the very first time there is nothing to announce: the
            // build it just downloaded is the build it is already running.
            if (installing.state === 'installed' && navigator.serviceWorker.controller) void offer(installing)
          })
        })
      }
      check()
    })

    timer = window.setInterval(check, CHECK_EVERY_MS)

    /*
     * And whenever somebody comes back to it.
     *
     * The interval alone is not enough on a phone: a backgrounded tab has its timers throttled to
     * near nothing, so the half-hourly check can be hours late. Somebody picking the phone up is
     * both the moment a check is cheapest and the moment it matters, since they are about to use it.
     */
    const wake = () => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - lastCheck.current < CHECK_ON_WAKE_AFTER_MS) return
      check()
    }
    document.addEventListener('visibilitychange', wake)

    return () => {
      live = false
      if (timer !== null) clearInterval(timer)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [offer, running])

  /**
   * APPLY NOW.
   *
   * The note goes down before anything irreversible happens, because everything after this line is
   * on the other side of an amnesia. Then the waiting worker is told to take over, and the page
   * reloads the moment it has — through the new worker, which fetches the shell from the network.
   * Without a worker there is nothing to hand over to and the reload is the whole of it.
   */
  const apply = useCallback(() => {
    setState((s) => ({ ...s, status: 'applying' }))
    const expect = state.version ?? 'the new build'
    writeHandoff(store, { expect, from: running, at: Date.now() })

    const go = () => {
      setState((s) => ({ ...s, status: 'restarting' }))
      // A frame for the takeover screen to paint, so the reload is announced rather than a blink.
      window.setTimeout(() => window.location.reload(), 60)
    }

    const handover = () => {
      clearTimeout(fail)
      navigator.serviceWorker?.removeEventListener('controllerchange', handover)
      go()
    }

    const fail = window.setTimeout(() => {
      /*
       * Take the listener down with the attempt.
       *
       * Left standing, a hand-over that arrived a minute after this gave up would reload the panel
       * out of nowhere — the household having read that it did not apply, put the phone down, and
       * been given no reason to expect the screen to go anywhere. A press that has been declared
       * failed is finished; TRY AGAIN is how it starts again.
       */
      navigator.serviceWorker?.removeEventListener('controllerchange', handover)
      clearHandoff(store)
      setState((s) => (s.status === 'applying' ? { ...s, status: 'failed', at: Date.now() } : s))
    }, APPLY_TIMEOUT_MS)

    const worker = waiting.current
    if (!worker) {
      clearTimeout(fail)
      go()
      return
    }

    navigator.serviceWorker.addEventListener('controllerchange', handover)

    try {
      worker.postMessage({ type: 'SKIP_WAITING' })
    } catch {
      // A worker that cannot be spoken to is one that cannot hand over. Reload anyway: the shell is
      // fetched network-first, so the panel still ends up on the current build the slow way.
      navigator.serviceWorker.removeEventListener('controllerchange', handover)
      clearTimeout(fail)
      go()
    }
  }, [running, state.version, store])

  const value = useMemo<UpdateContextValue>(() => ({ ...state, apply }), [state, apply])
  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useUpdate(): UpdateContextValue {
  const ctx = useContext(UpdateContext)
  if (!ctx) throw new Error('useUpdate must be used within an UpdateProvider')
  return ctx
}
