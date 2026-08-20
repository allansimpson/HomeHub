import { useEffect, useRef } from 'react'

/** How long a finger rests before the press counts. */
export const LONG_PRESS_MS = 500

/** How far it may wander while resting. Held still is never held perfectly still. */
export const PRESS_SLOP = 10

/**
 * Press and hold — the way into anything a stray tap must not reach.
 *
 * <b>Extracted because both of its bugs were subtle.</b> The care entries list grew this shape
 * first — and still carries its own inline copy — with each fault taking a round of "it still
 * doesn't work" to find:
 *
 * - **Any pointermove cancelled it.** A finger held still on glass emits a steady trickle of
 *   sub-pixel jitter, so the press died within milliseconds and never once fired. Hence
 *   {@link PRESS_SLOP}: a press is allowed to wobble.
 * - **The release undid it.** The press fires while the finger is still down; the release that
 *   follows then read as a fresh tap on a row that was now selected, and toggled it straight back
 *   off. Hence `acted` — this gesture already did its work, and the lift is its end rather than a
 *   new tap.
 *
 * Anything reaching for this behaviour should use this rather than roll a third: neither fix is one
 * you arrive at by writing the obvious version, and nobody wants to find them a third time.
 *
 * Returns a `bind(value)` rather than the handlers directly: a list binds one row at a time inside
 * a `map`, where calling a hook per row is not allowed. The refs are shared, which is correct —
 * there is one pointer, so there is one press in flight.
 */
export function useLongPress<T>({ onPress, onTap }: {
  onPress: (value: T) => void
  /** A plain tap, when the caller wants one. Never fires on the release of a press. */
  onTap?: (value: T) => void
}) {
  const timer = useRef<number | null>(null)
  const from = useRef({ x: 0, y: 0 })
  const moved = useRef(false)
  const acted = useRef(false)

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])

  const cancel = () => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = null
  }

  return (value: T) => ({
    onPointerDown: (e: React.PointerEvent) => {
      moved.current = false
      acted.current = false
      from.current = { x: e.clientX, y: e.clientY }
      timer.current = window.setTimeout(() => {
        if (moved.current) return
        acted.current = true
        onPress(value)
      }, LONG_PRESS_MS)
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (moved.current) return
      if (Math.abs(e.clientX - from.current.x) > PRESS_SLOP
        || Math.abs(e.clientY - from.current.y) > PRESS_SLOP) {
        moved.current = true
        cancel()
      }
    },
    onPointerUp: () => {
      cancel()
      if (acted.current || moved.current) return
      onTap?.(value)
    },
    onPointerCancel: cancel,
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  })
}
