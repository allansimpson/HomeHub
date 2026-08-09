import { useEffect, useRef } from 'react'
import { useSession } from './SessionProvider'
import { useNightMode } from './useNightMode'

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const

/**
 * Panel idle behaviour, mounted once inside the router + session:
 *  - After the configured idle timeout with no interaction, lock — but only if the active profile
 *    opted into a PIN. A panel with no PIN now does nothing at all when it goes quiet.
 *  - Apply night dimming (data-nightdim on <html>, styled in index.css).
 *
 * <b>Going quiet is not a request to go somewhere else.</b> This used to navigate to the dashboard
 * after the idle timeout, on the reasoning that a wall panel's resting state is the home screen. In
 * practice the panel is not only a wall panel — it is also a phone and a browser tab — and the rule
 * threw away what somebody was in the middle of: a half-written message, a recipe open at step four,
 * a screen deliberately left on for the person coming back to it. Nothing about a few quiet minutes
 * distinguishes "finished" from "went to fetch something", and the screen was picking the first
 * every time.
 *
 * The lock survives, because it answers a different question. Locking is a privacy decision the
 * member made in advance by setting a PIN, and it protects something; returning home protected
 * nothing and only ever cost. `lockNow` is a no-op for a profile with no PIN, so a household that
 * never opted in is simply left where it was.
 *
 * <b>Deciding whether to dim is not this hook's job.</b> The window, the schedule switch and the
 * manual override live in `useNightMode`, because the settings screen has to argue with the same
 * value and two copies of that rule would eventually disagree about what "night" is. This hook only
 * writes the attribute.
 */
export function useIdleReset() {
  const { settings, locked, lockNow } = useSession()
  const { dimmed } = useNightMode()

  const timeoutMs = Math.max(1, settings?.idleTimeoutMinutes ?? 5) * 60_000

  // Keep the latest values available to the (stable) event handler without re-subscribing.
  const stateRef = useRef({ timeoutMs, locked })
  stateRef.current = { timeoutMs, locked }

  useEffect(() => {
    let idleTimer: number | undefined

    const reset = () => {
      window.clearTimeout(idleTimer)
      if (stateRef.current.locked) return // don't run the idle timer while already locked
      idleTimer = window.setTimeout(lockNow, stateRef.current.timeoutMs)
    }

    for (const evt of ACTIVITY_EVENTS) window.addEventListener(evt, reset, { passive: true })
    reset()

    return () => {
      window.clearTimeout(idleTimer)
      for (const evt of ACTIVITY_EVENTS) window.removeEventListener(evt, reset)
    }
  }, [lockNow, timeoutMs, locked])

  // Night dimming — one attribute write, re-run whenever the answer changes. `useNightMode` is
  // already ticking, so there is no second timer here to fall out of step with it.
  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-nightdim', dimmed ? 'on' : 'off')
    return () => root.removeAttribute('data-nightdim')
  }, [dimmed])
}
