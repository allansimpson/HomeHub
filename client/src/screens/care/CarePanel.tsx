import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

/** How long the release easing runs — the snap back, and the slide out on a close. */
const RELEASE_MS = 220

/** Movement before a pointer is treated as a drag rather than a tap on whatever is underneath. */
const CLAIM_PX = 8

/**
 * The surface every Care logging view rises on.
 *
 * <b>All panels are the same height whatever they contain.</b> That is the rule the design puts
 * above the others, and the reason Diaper packs its rows tighter rather than standing taller than
 * Bottle: ten panels that each size to their contents are ten different peeks of the day view
 * behind, and the top 200px stops being a fixed piece of context and becomes a number that moves.
 * Anything that would grow the panel is wrong; give the body `dense` instead.
 *
 * <b>There is no back button, no X, and no tap-the-scrim to dismiss.</b> Dismissal is the drag: the
 * panel follows the finger, snaps back under a third of its height and closes past that, and writes
 * nothing on the way out. One gesture, in one direction, that cannot be confused with a control —
 * which matters on a panel whose every other tap fills in a field.
 *
 * The peek is context, not a target. Taps on the scrim are swallowed rather than acted on.
 */
export function CarePanel({
  title, label, last, running = false, handleNote, dense = false, rise = true, footer, onClose,
  children,
}: {
  title: string
  /** The right-aligned label in the title block — `CONRAD`, `EDITING`, a running dot. */
  label?: ReactNode
  /** The last-entry line under the title. Absent on running-timer panels, which have no "last". */
  last?: ReactNode
  /** A timer is running: the handle says so, because closing here does not stop it. */
  running?: boolean
  /**
   * What closing leaves behind, when it is not simply nothing.
   *
   * The handle is where the panel says what a drag costs, and a held pump session is the second
   * case where the answer is "not what you would assume": the clock has stopped but the session is
   * still there, waiting to be given an amount. `running` is the first, and this overrides it.
   */
  handleNote?: string
  /**
   * Pack the body's rows tighter, for the one panel with more rows than the rhythm fits.
   *
   * Diaper only. It carries six fields where the others carry two or three, and it used to run past
   * the panel and scroll inside itself — which is the sanctioned answer here, but it hid the When
   * row below the fold and cost a swipe to reach a field that is already on screen everywhere else.
   * Tightening the row rhythm on this panel alone buys back the height instead.
   *
   * The body keeps a native scroll as a backstop rather than clipping: a device whose font metrics
   * run a little taller than the canvas should give up a few pixels of travel, not the When row.
   */
  dense?: boolean
  /**
   * Play the rise on mount.
   *
   * False when one panel is handing over to another — starting a session swaps the sheet for the
   * running clock, and because the two are different components React remounts. Without this the
   * handover would animate as a panel dropping away and a new one climbing back, which is the exact
   * impression the handover exists to avoid.
   */
  rise?: boolean
  footer: ReactNode
  onClose: () => void
  children: ReactNode
}) {
  const panel = useRef<HTMLElement | null>(null)
  const body = useRef<HTMLDivElement | null>(null)
  const startY = useRef<number | null>(null)
  const dragging = useRef(false)
  const timeout = useRef<number | null>(null)

  const [dy, setDy] = useState(0)
  /** True from the moment the pointer is released until the easing finishes. */
  const [releasing, setReleasing] = useState(false)
  const [closing, setClosing] = useState(false)
  /** The element and pointer id a claimed drag is holding, so it can be handed back. */
  const captured = useRef<{ el: Element; id: number } | null>(null)

  useEffect(() => () => { if (timeout.current) window.clearTimeout(timeout.current) }, [])

  /**
   * Slide out under the same easing as a snap back, then close.
   *
   * The gesture's own momentum is what the eye is following, so the panel finishes the movement
   * rather than vanishing at the moment of release.
   */
  const slideOut = useCallback(() => {
    setClosing(true)
    setReleasing(true)
    timeout.current = window.setTimeout(onClose, RELEASE_MS)
  }, [onClose])

  const onDown = (e: React.PointerEvent) => {
    if (closing) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    startY.current = e.clientY
  }

  const onMove = (e: React.PointerEvent) => {
    if (startY.current == null) return
    const delta = e.clientY - startY.current

    if (!dragging.current) {
      // Upward, or too small to mean anything: leave the pointer to whatever is underneath, so a
      // tap on a chip is still a tap and a scrolling body still scrolls.
      if (delta < CLAIM_PX) return
      // A scrolled body owns the downward drag until it is back at the top — otherwise scrolling up
      // through the diaper panel closes it the moment the content runs out.
      if (body.current && body.current.scrollTop > 0 && body.current.contains(e.target as Node)) {
        startY.current = null
        return
      }
      dragging.current = true
      e.currentTarget.setPointerCapture(e.pointerId)
      captured.current = { el: e.currentTarget, id: e.pointerId }
    }

    setDy(Math.max(0, delta))
  }

  /*
   * Hand the pointer back, explicitly.
   *
   * <b>This is what made the first tap after closing a panel do nothing.</b> The drag claims the
   * pointer with `setPointerCapture` so it keeps tracking a finger that leaves the panel — but the
   * panel is then removed from the document a moment later, and a capture held by an element that
   * no longer exists swallows exactly one more gesture before the browser gives up on it. Which is
   * precisely the reported behaviour: close the panel, tap a tile, nothing; tap anywhere at all,
   * and every tile works again.
   *
   * Releasing on our own terms rather than relying on the implicit release costs nothing and does
   * not depend on the element still being around to receive it.
   */
  const release = () => {
    const held = captured.current
    captured.current = null
    if (held?.el.hasPointerCapture?.(held.id)) held.el.releasePointerCapture(held.id)
  }

  const onUp = () => {
    release()
    if (!dragging.current) {
      startY.current = null
      return
    }
    // A third of the panel's own measured height, not a written-down 253px: the panel is sized in
    // rem against the 540 × 960 canvas, so its real height depends on the viewport.
    const third = (panel.current?.getBoundingClientRect().height ?? 0) / 3
    const close = dy > third

    startY.current = null
    dragging.current = false
    setReleasing(true)

    if (close) {
      slideOut()
      return
    }
    setDy(0)
    timeout.current = window.setTimeout(() => setReleasing(false), RELEASE_MS)
  }

  /* Not an affordance the design draws — there is nothing to press — but a keyboard that reaches
     this panel should be able to leave it, and Escape closes without writing exactly as the drag
     does. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') slideOut() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [slideOut])

  const height = panel.current?.getBoundingClientRect().height ?? 0
  // The scrim fades with the panel, so the day view comes back as the gesture uncovers it.
  const uncovered = closing ? 1 : height > 0 ? Math.min(1, dy / height) : 0

  return (
    /*
      Once it is closing it stops catching anything.

      The panel is off-screen and the scrim is fully faded by then, but the wrap is still a
      full-screen fixed layer for the length of the slide — so a tap in that window landed on
      nothing and looked like a dead tap. Invisible and still interactive is the worst of both.
    */
    <div className={'ml-carepanelwrap' + (closing ? ' ml-carepanelwrap--closing' : '')}>
      {/* No onClick. The peek is context, and a panel that closes when you touch the thing you were
          reading is a panel that throws away a half-filled entry. */}
      <div
        className="ml-carepanel__scrim"
        style={{ opacity: 1 - uncovered }}
        aria-hidden="true"
      />
      <section
        ref={panel}
        className={
          'ml-carepanel'
          + (releasing ? ' ml-carepanel--releasing' : '')
          + (rise ? '' : ' ml-carepanel--norise')
        }
        style={closing ? { transform: 'translateY(100%)' } : dy ? { transform: `translateY(${dy}px)` } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <div className="ml-carepanel__handle">
          <span className="ml-carepanel__grab" aria-hidden="true" />
          <span className="ml-carepanel__hint">
            Slide down to close{handleNote ? ` · ${handleNote}` : running ? ' · the timer keeps running' : ''}
          </span>
        </div>

        <div className="ml-carepanel__titles">
          <div className="ml-carepanel__titlerow">
            <span className="ml-carepanel__title serif">{title}</span>
            {label && <span className="ml-carepanel__label">{label}</span>}
          </div>
          {last && <div className="ml-carepanel__last">{last}</div>}
        </div>

        <div
          ref={body}
          className={'ml-carepanel__body' + (dense ? ' ml-carepanel__body--dense' : '')}
        >
          {children}
        </div>

        {/* A real block at the foot rather than `margin-top:auto` on the last thing in the body:
            the review line and SAVE sit at the same height on all ten panels, which is what lets
            somebody save without looking. */}
        <footer className="ml-carepanel__foot">{footer}</footer>
      </section>
    </div>
  )
}
