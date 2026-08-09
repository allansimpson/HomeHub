import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Whether a scroll box has more content below the fold.
 *
 * Drives the fade at the foot of the transcript. A conversation that continues past the bottom edge
 * looks exactly like one that ends there — the last visible line is a whole line either way — so
 * without an affordance the household reads a partial answer as the answer. The fade is the cheapest
 * honest signal: it says "this is cut off" without occupying any space of its own.
 *
 * It goes away at the bottom, which is the other half of the point. A permanent gradient is
 * decoration; one that appears and disappears is information.
 *
 * Re-measures on scroll and on the box resizing, and returns {@link measure} for the caller to fire
 * when the *content* changes. That last one is the case that matters most here and the one a
 * `ResizeObserver` on the scroll box cannot see: a streamed reply growing a line at a time changes
 * `scrollHeight` without changing the box, and without firing a scroll event.
 */
export function useScrollEdge<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [more, setMore] = useState(false)

  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    // A pixel of slack: fractional scroll positions mean an element scrolled fully to the bottom
    // routinely lands a fraction short, which would leave the fade on forever.
    setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 1)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    // The box changing size — rotation, or a native keyboard opening under it on a phone.
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => {
      el.removeEventListener('scroll', measure)
      observer.disconnect()
    }
  }, [measure])

  return { ref, more, measure }
}
