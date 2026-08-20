import { useEffect, useRef } from 'react'
import { useNow } from '../../app/useNow'
import type { CareTimerDto } from '../../api/types'

/**
 * A running session's elapsed seconds, ticking, without lying about pauses.
 *
 * <b>`elapsedMinutes` from the server is the only figure that knows about pauses</b> — two places
 * summing "now minus started" is two places to get a pause wrong, and the one that is wrong will be
 * the one somebody reads at 3am. But it arrives every ten seconds, and a clock that jumps in
 * ten-second steps does not read as running.
 *
 * So the server's value is the base and the seconds since it arrived are added on top. Every read
 * re-anchors it, so the interpolation can never drift more than one poll out, and a paused timer
 * simply holds the server's figure.
 *
 * Shared by the running panel and the strip on the day view so the two cannot disagree — a glance
 * at one followed by a glance at the other should not show two different sessions.
 */
export function useRunningSeconds(timer: CareTimerDto): number {
  const now = useNow(1000)
  const base = useRef({ minutes: timer.elapsedMinutes, at: Date.now() })

  useEffect(() => {
    base.current = { minutes: timer.elapsedMinutes, at: Date.now() }
  }, [timer.elapsedMinutes, timer.paused])

  /*
   * A held session holds still, and more firmly than a paused one.
   *
   * Its length is a measurement already taken — the server banked it at FINISH and will not move it
   * again — so interpolating on top of it would have the day view counting up from a figure that
   * has stopped, and the strip disagreeing with the finish panel about how long the session ran.
   */
  if (timer.endedUtc != null || timer.paused) return timer.elapsedMinutes * 60
  return base.current.minutes * 60 + Math.max(0, (now - base.current.at) / 1000)
}

/** `07:35` — a running clock always shows its seconds, or it does not read as running. */
export function mmss(seconds: number): string {
  const whole = Math.floor(seconds)
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`
}
