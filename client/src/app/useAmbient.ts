import { useEffect } from 'react'
import type { DaylightBoostMode } from '../api/types'

/**
 * High-ambient daylight boost (spec 12): the same dark layout with brighter text/brass tokens and
 * heavier body weight so the panel stays first-glance readable under daylight glare. Drives
 * `data-ambient="bright"` on <html> (the token swap lives in tokens.css). Orthogonal to night-dim.
 *
 *  - "on"  → always boosted.
 *  - "off" → never boosted.
 *  - "auto" → the AmbientLightSensor where available (with hysteresis so it doesn't flicker at the
 *             lux boundary), else a daytime schedule fallback (most Chromium kiosks lack the sensor).
 */
const BRIGHT_LUX = 300
const NORMAL_LUX = 150

// Minimal AmbientLightSensor typing (not in the default DOM lib).
interface AmbientLightSensorLike {
  illuminance: number
  start: () => void
  stop: () => void
  onreading: (() => void) | null
  onerror: ((e: unknown) => void) | null
}
type AmbientLightSensorCtor = new (opts?: { frequency?: number }) => AmbientLightSensorLike

function isDaytime(now: Date): boolean {
  const h = now.getHours()
  return h >= 8 && h < 18
}

export function useAmbient(mode: DaylightBoostMode) {
  useEffect(() => {
    const root = document.documentElement
    const setBright = (bright: boolean) => root.setAttribute('data-ambient', bright ? 'bright' : 'normal')

    if (mode === 'on') {
      setBright(true)
      return () => root.removeAttribute('data-ambient')
    }
    if (mode === 'off') {
      setBright(false)
      return () => root.removeAttribute('data-ambient')
    }

    // ---- auto ----
    const Ctor = (window as unknown as { AmbientLightSensor?: AmbientLightSensorCtor }).AmbientLightSensor
    if (Ctor) {
      let bright = false
      try {
        const sensor = new Ctor({ frequency: 0.5 })
        sensor.onreading = () => {
          // Hysteresis: only flip once clearly past the opposite threshold.
          if (!bright && sensor.illuminance > BRIGHT_LUX) bright = true
          else if (bright && sensor.illuminance < NORMAL_LUX) bright = false
          setBright(bright)
        }
        sensor.onerror = () => {
          // Permission/hardware error — fall back to the schedule.
          setBright(isDaytime(new Date()))
        }
        sensor.start()
        return () => {
          sensor.stop()
          root.removeAttribute('data-ambient')
        }
      } catch {
        /* construction blocked (permissions) — fall through to schedule */
      }
    }

    // Schedule fallback: bright during daytime hours, re-checked each minute.
    const apply = () => setBright(isDaytime(new Date()))
    apply()
    const id = window.setInterval(apply, 60_000)
    return () => {
      window.clearInterval(id)
      root.removeAttribute('data-ambient')
    }
  }, [mode])
}
