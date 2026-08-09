import { useCallback, useEffect, useState } from 'react'
import { useSession } from './SessionProvider'
import { nextBoundary, shouldDim, type NightOverride } from './nightMode'

/**
 * The panel's current darkness, and the one gesture that argues with it.
 *
 * The window and the schedule switch are household settings and live on the server. The **override**
 * does not, and that is deliberate on two counts:
 *
 *  - it is about the screen in front of you rather than about the household, and
 *  - it is supposed to be forgotten. A restart, like the next boundary, ends it — which is the
 *    behaviour somebody who tapped "brighten" at eleven at night actually wants, and the reason this
 *    is not simply the schedule switch under another name.
 *
 * Module-level rather than a provider because two unrelated places need the same value — the effect
 * that dims the panel and the settings control that argues with it — and threading a fourteenth
 * context through `main.tsx` to carry one boolean would cost more than it explains. Same shape as
 * `units.ts`.
 */

let override: NightOverride | null = null
const listeners = new Set<() => void>()

function publish(): void {
  listeners.forEach((notify) => notify())
}

export interface NightMode {
  /** Whether the panel is dark right now, whatever the reason. */
  dimmed: boolean
  /** What the schedule alone would say — the value the override is currently arguing with. */
  scheduled: boolean
  /** True while a manual override is in force. */
  overridden: boolean
  /** When the override lapses and the schedule resumes, as `HH:mm`. Null when there is none. */
  overrideUntil: Date | null
  /**
   * Argue with the schedule until it next changes its mind.
   *
   * Takes the state wanted rather than a toggle, so a stale render cannot invert the panel.
   */
  setOverride: (dim: boolean) => void
  /** Drop the override now rather than waiting for the boundary. */
  clearOverride: () => void
}

export function useNightMode(): NightMode {
  const { settings } = useSession()
  const [, bump] = useState(0)

  const enabled = settings?.idleDimmingEnabled ?? true
  const start = settings?.nightDimStart ?? '22:00'
  const end = settings?.nightDimEnd ?? '06:00'

  // Re-evaluated on a tick rather than on a timer aimed at the boundary: a wall panel can be
  // suspended, resumed, or have its clock corrected, and every one of those makes a single
  // long-armed timeout fire at the wrong minute. Thirty seconds is under a minute, so the panel
  // never sits more than half a minute past a boundary it should have noticed.
  useEffect(() => {
    const notify = () => bump((n) => n + 1)
    listeners.add(notify)
    const id = window.setInterval(notify, 30_000)
    return () => {
      listeners.delete(notify)
      window.clearInterval(id)
    }
  }, [])

  const now = new Date()
  // Read, then dropped if spent — an override that expires by being read cannot be left behind by a
  // missed tick, which a separate expiry timer could.
  if (override && now.getTime() >= override.untilMs) override = null

  const setOverride = useCallback((dim: boolean) => {
    const at = new Date()
    const boundary = nextBoundary(at, start, end)
    override = {
      dim,
      // No window to expire against — the schedule is off, or the times are unusable — so the
      // override holds until somebody drops it or the panel restarts. It is the only thing deciding
      // anything at that point, and expiring it would silently undo the only instruction there is.
      untilMs: boundary ? boundary.getTime() : Number.POSITIVE_INFINITY,
    }
    publish()
  }, [start, end])

  const clearOverride = useCallback(() => {
    override = null
    publish()
  }, [])

  const scheduled = shouldDim(now, { enabled, start, end }, null)

  return {
    dimmed: shouldDim(now, { enabled, start, end }, override),
    scheduled,
    overridden: override !== null,
    overrideUntil:
      override && Number.isFinite(override.untilMs) ? new Date(override.untilMs) : null,
    setOverride,
    clearOverride,
  }
}
