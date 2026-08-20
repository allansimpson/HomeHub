import { useRef } from 'react'

/** How far a finger may travel and still be a tap rather than the start of a scroll. */
const TAP_SLOP = 12

/**
 * Activate on the pointer rather than on the click.
 *
 * <b>`click` is a derived event, and the browser withholds it more often than it looks.</b> A tap
 * that ends a momentum scroll, one that travels a few pixels, one that lands while the page is
 * still settling — all of them produce a full pointer sequence and no click at all. On a wall panel
 * reached for one-handed that is the ordinary case, and it shows up as "the first tap did nothing,
 * the second opened it".
 *
 * The pointer sequence is the ground truth, so this listens to that and applies the slop test the
 * browser's own heuristic was trying to apply — but without the extra conditions that make a click
 * disappear. Movement past {@link TAP_SLOP} is a scroll and activates nothing.
 *
 * <b>Pair it with a guarded `onClick` for the keyboard</b>, which produces no pointer events at all:
 *
 * ```tsx
 * <button {...tap(open)} onClick={(e) => { if (e.detail === 0) open() }} />
 * ```
 *
 * `detail === 0` is the tell for a keyboard-driven click; without that guard a mouse, which fires
 * both, would activate twice.
 */
export function useTap() {
  const from = useRef<{ x: number; y: number } | null>(null)

  return (onTap: () => void) => ({
    onPointerDown: (e: React.PointerEvent) => {
      // Secondary mouse buttons are not taps; a right-click should open nothing.
      if (e.pointerType === 'mouse' && e.button !== 0) {
        from.current = null
        return
      }
      from.current = { x: e.clientX, y: e.clientY }
    },
    onPointerUp: (e: React.PointerEvent) => {
      const start = from.current
      from.current = null
      if (!start) return
      if (Math.abs(e.clientX - start.x) > TAP_SLOP || Math.abs(e.clientY - start.y) > TAP_SLOP) return
      onTap()
    },
    onPointerCancel: () => { from.current = null },
  })
}
