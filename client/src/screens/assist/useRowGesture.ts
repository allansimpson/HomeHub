import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'

/**
 * The conversation row's gestures (ASSIST.md · `1f`, `1g`).
 *
 * One pointer stream, three possible outcomes, and the whole job of this hook is deciding which one
 * a press turned out to be *without* asking the household to be precise about it:
 *
 * - a **horizontal drag** reveals an action panel and commits it on release,
 * - a **vertical drag** is the list scrolling and must be given back to the browser untouched,
 * - a **still press** is a long press, and enters selection mode.
 *
 * The axis is decided once, by whichever direction crosses {@link ENGAGE_PX} first, and never
 * revisited for that press. Re-deciding mid-drag is what makes a row that follows your finger and
 * then suddenly lets the list scroll out from under it.
 *
 * A row is a `<button>`, so a drag would otherwise end in a click that opens the chat you were
 * trying to archive. `onClickCapture` swallows exactly that one click.
 */

/** Which way the row went, and therefore what releasing it does. */
export type SwipeAction = 'archive' | 'pin'

/** 118px — the design's full-height action panel. The row never travels further than it reveals. */
const PANEL_REM = 7.375

/**
 * Travel before the gesture is claimed. Below this nothing moves and nothing is decided: a wall
 * panel is touched with a whole thumb, and treating the first pixel of wobble as intent would
 * archive conversations for people who were only scrolling.
 */
const ENGAGE_PX = 10

/** Past this fraction of the panel, releasing commits. Short of it, the row springs back. */
const COMMIT_FRACTION = 0.55

/** Long enough not to fire on a tap that lingers, short enough not to feel like a stuck screen. */
const HOLD_MS = 500

/**
 * Which kind of gesture this press has turned into, or null while it is still too small to say.
 *
 * Whichever axis crosses {@link ENGAGE_PX} first wins, and a tie goes to the list: `>` rather than
 * `>=` means a perfectly diagonal drag scrolls instead of archiving. That is the safer default —
 * scrolling wrongly costs nothing and archiving wrongly files a conversation away.
 */
export function decideAxis(travelX: number, travelY: number): 'x' | 'y' | null {
  if (Math.abs(travelX) < ENGAGE_PX && Math.abs(travelY) < ENGAGE_PX) return null
  return Math.abs(travelX) > Math.abs(travelY) ? 'x' : 'y'
}

/** Whether releasing here does the thing, given how wide the action panel actually is. */
export function commits(dx: number, panelPx: number): boolean {
  return panelPx > 0 && Math.abs(dx) >= panelPx * COMMIT_FRACTION
}

/** Left reveals the panel on the right, and vice versa. */
export function actionFor(dx: number): SwipeAction {
  return dx < 0 ? 'archive' : 'pin'
}

interface Options {
  /** Released past the commit threshold. `archive` came from the left, `pin` from the right. */
  onSwipe: (action: SwipeAction) => void
  /** Held still. Enters selection mode and selects this row. */
  onHold: () => void
  /**
   * Selection mode. Every gesture is off: a row being ticked must not also archive, and a second
   * long press inside selection has nothing left to mean.
   */
  disabled?: boolean
}

export interface RowGesture {
  /** Signed pixels to translate the row by. Negative reveals archive, positive reveals pin. */
  dx: number
  /** Which panel to paint under the row, or null at rest. */
  revealed: SwipeAction | null
  /** Past the commit threshold — the panel brightens to say releasing now will do the thing. */
  armed: boolean
  handlers: {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void
    onClickCapture: (e: ReactMouseEvent<HTMLElement>) => void
  }
}

export function useRowGesture({ onSwipe, onHold, disabled = false }: Options): RowGesture {
  const [dx, setDx] = useState(0)

  const g = useRef({
    down: false,
    x: 0,
    y: 0,
    /** Null until the press has travelled far enough to be one thing or the other. */
    axis: null as null | 'x' | 'y',
    /** This press has become something other than a tap; the click it ends with is not a tap. */
    consumed: false,
    /** Panel width in real pixels — rem scales with the panel's viewport, so it is read per press. */
    panel: 0,
    /**
     * The live offset, mirrored out of state.
     *
     * `pointerup` decides whether to commit, and it must decide on where the row actually *is* —
     * not on where the last committed render put it. A fast flick can end before React has
     * rendered the final move, and reading state there would judge the swipe by an earlier frame.
     */
    dx: 0,
    timer: 0,
  })

  const clearHold = useCallback(() => {
    if (g.current.timer) {
      window.clearTimeout(g.current.timer)
      g.current.timer = 0
    }
  }, [])

  // A row can be unmounted mid-press — archiving removes it from the list, which is the common case
  // rather than an edge one — and a hold timer that outlives its row fires into nothing.
  useEffect(() => clearHold, [clearHold])

  const settle = useCallback(
    (commit: boolean) => {
      clearHold()
      const s = g.current
      s.down = false
      s.axis = null
      const travelled = s.dx
      s.dx = 0
      if (commit && commits(travelled, s.panel)) onSwipe(actionFor(travelled))
      setDx(0)
    },
    [clearHold, onSwipe],
  )

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (disabled || !e.isPrimary) return
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      g.current = {
        down: true,
        x: e.clientX,
        y: e.clientY,
        axis: null,
        consumed: false,
        panel: PANEL_REM * rem,
        dx: 0,
        timer: 0,
      }
      g.current.timer = window.setTimeout(() => {
        const s = g.current
        s.timer = 0
        // The press is spent, and stays spent until the finger lifts. Without releasing `down`, a
        // hand that drifts sideways after the hold would keep swiping a row that is now a checkbox
        // — the long press would archive the conversation it just selected.
        s.down = false
        // Whatever click follows this belongs to the long press, not to the row.
        s.consumed = true
        onHold()
      }, HOLD_MS)
    },
    [disabled, onHold],
  )

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const s = g.current
      if (!s.down) return

      const travelX = e.clientX - s.x
      const travelY = e.clientY - s.y

      if (s.axis === null) {
        const axis = decideAxis(travelX, travelY)
        if (axis === null) return
        s.axis = axis
        // Either way this is no longer a long press.
        clearHold()
        if (s.axis === 'y') {
          // Hand the press back. Nothing was captured and nothing moved, so the list scrolls
          // natively from here as though this hook had never seen the pointer.
          s.down = false
          return
        }
        s.consumed = true
        // Capture only once the drag is horizontal — capturing earlier would steal vertical drags
        // from the scroller before we knew they were vertical.
        e.currentTarget.setPointerCapture?.(e.pointerId)
      }

      // Clamped to the panel: the row reveals an action, it does not slide off the screen.
      s.dx = Math.max(-s.panel, Math.min(s.panel, travelX))
      setDx(s.dx)
    },
    [clearHold],
  )

  const onPointerUp = useCallback(() => settle(true), [settle])
  const onPointerCancel = useCallback(() => settle(false), [settle])

  const onClickCapture = useCallback((e: ReactMouseEvent<HTMLElement>) => {
    if (!g.current.consumed) return
    e.preventDefault()
    e.stopPropagation()
    g.current.consumed = false
  }, [])

  return {
    dx,
    revealed: dx === 0 ? null : dx < 0 ? 'archive' : 'pin',
    armed: commits(dx, g.current.panel),
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture },
  }
}
