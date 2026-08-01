import { useEffect, useState } from 'react'

/**
 * A ticking `Date.now()`, for anything whose label changes on its own: elapsed-time meta lines,
 * running timers, countdowns to the next recovery attempt.
 *
 * Distinct from {@link useClock}, which returns the formatted wall clock for the dashboard. Pick the
 * slowest interval that still reads as live — a 30s tick is right for "3h ago", 1s for MM:SS.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}
