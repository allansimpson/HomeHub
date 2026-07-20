import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useSession } from './SessionProvider'

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const

/** Night-dim window: 10 PM through pre-dawn (spec: "dims after 10 PM"). */
function isNightHour(now: Date): boolean {
  const h = now.getHours()
  return h >= 22 || h < 6
}

/**
 * Panel idle behaviour, mounted once inside the router + session:
 *  - After the configured idle timeout with no interaction, return to the dashboard; if the
 *    active profile opted into a PIN, lock instead.
 *  - Toggle night dimming (data-nightdim on <html>, styled in index.css) when enabled and
 *    it's after 10 PM.
 */
export function useIdleReset() {
  const navigate = useNavigate()
  const location = useLocation()
  const { settings, locked, lockNow } = useSession()

  const timeoutMs = Math.max(1, settings?.idleTimeoutMinutes ?? 5) * 60_000
  const dimmingEnabled = settings?.idleDimmingEnabled ?? true

  // Keep the latest values available to the (stable) event handler without re-subscribing.
  const stateRef = useRef({ timeoutMs, locked, pathname: location.pathname })
  stateRef.current = { timeoutMs, locked, pathname: location.pathname }

  useEffect(() => {
    let idleTimer: number | undefined

    const onIdle = () => {
      lockNow()
      // If not lockable, just return to the dashboard idle display.
      if (stateRef.current.pathname !== '/') navigate('/')
    }

    const reset = () => {
      window.clearTimeout(idleTimer)
      if (stateRef.current.locked) return // don't run the idle timer while already locked
      idleTimer = window.setTimeout(onIdle, stateRef.current.timeoutMs)
    }

    for (const evt of ACTIVITY_EVENTS) window.addEventListener(evt, reset, { passive: true })
    reset()

    return () => {
      window.clearTimeout(idleTimer)
      for (const evt of ACTIVITY_EVENTS) window.removeEventListener(evt, reset)
    }
  }, [navigate, lockNow, timeoutMs, locked])

  // Night dimming — evaluate now and each minute.
  useEffect(() => {
    const root = document.documentElement
    const apply = () => {
      const dim = dimmingEnabled && isNightHour(new Date())
      root.setAttribute('data-nightdim', dim ? 'on' : 'off')
    }
    apply()
    const id = window.setInterval(apply, 60_000)
    return () => {
      window.clearInterval(id)
      root.removeAttribute('data-nightdim')
    }
  }, [dimmingEnabled])
}
