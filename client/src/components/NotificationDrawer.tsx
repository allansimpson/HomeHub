import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useNotifications } from '../app/NotificationsProvider'
import type { AppNotification } from '../app/NotificationsProvider'
import { clockLabel } from '../app/dates'

/**
 * How long to let the sheet leave before it stops existing.
 *
 * <b>Must match `.ml-drawer`'s transition, and is shorter than the arrival on purpose:</b> arriving
 * is the panel asking for attention, leaving is getting out of the way of somebody who has already
 * decided. The in-duration lives only in the stylesheet, because nothing here waits on it — the
 * close is the one that has to be timed, since unmounting mid-slide would make the panel vanish
 * rather than go.
 */
const SLIDE_OUT_MS = 200

/** Past this much upward drag, letting go closes it rather than springing back. */
const CLOSE_DRAG_PX = 60

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * When a notification arrived, in as few words as are honest.
 *
 * <b>The day is named on anything but today.</b> The list holds a week and is ordered by time alone,
 * so a bare `9:41 PM` four rows down would read as this evening — the grouping that used to carry
 * the day is gone, and the timestamp has to carry it instead. Today's rows stay uncluttered, which
 * is most of them.
 */
function rowTime(iso: string, now: Date): string {
  const at = new Date(iso)
  const clock = clockLabel(at)
  return at.toDateString() === now.toDateString() ? clock : `${WEEKDAYS[at.getDay()]} · ${clock}`
}

/**
 * The invisible strip along the top edge that opens the panel.
 *
 * Deliberately thin and above everything: the gesture has to work from any tab without stealing
 * taps from the header beneath it. It only claims the pointer once a downward drag is unambiguous.
 *
 * @category Status
 */
export function NotificationPullTab() {
  const { openDrawer, drawerOpen } = useNotifications()
  const start = useRef<number | null>(null)

  if (drawerOpen) return null

  return (
    <div
      className="ml-pulltab"
      aria-hidden="true"
      onPointerDown={(e) => { start.current = e.clientY }}
      onPointerMove={(e) => {
        if (start.current == null) return
        if (e.clientY - start.current > 36) {
          start.current = null
          openDrawer()
        }
      }}
      onPointerUp={() => { start.current = null }}
      onPointerCancel={() => { start.current = null }}
    />
  )
}

/**
 * Notifications — one panel, slid down from the top edge, over whatever was on screen.
 *
 * <b>This is now the only notification surface, and it replaced a screen.</b> There used to be both:
 * this sheet, and an inbox at `/notifications` with All / Wants you / Today tabs. Two readers of one
 * queue, disagreeing about how to arrange it — the sheet by severity, the screen by day, with tabs
 * on top of that — for a household whose actual question is "what has happened, newest first". The
 * tabs went with the screen: a filter is only worth a control when the unfiltered list is unusable,
 * and a week of a house's notifications is not that.
 *
 * <b>Severity is the rail, not a heading.</b> Terracotta wants something from you, brass and
 * verdigris are telling you something — the same colours the live cards use, so a notification looks
 * the same wherever it is met. Grouping by it as well was the screen saying twice what the row
 * already says once, and it broke the ordering people were actually reading down.
 *
 * Closing is whatever you would try: the scrim, a swipe back up, or Escape. It slides rather than
 * vanishing, because a panel that covers the screen and then disappears leaves you unsure whether
 * you dismissed it or it dismissed itself.
 *
 * @category Status
 */
export function NotificationDrawer() {
  const { all, drawerOpen, closeDrawer, clearAll, markRead } = useNotifications()
  const navigate = useNavigate()
  const [shown, setShown] = useState(false)
  const [dy, setDy] = useState(0)
  const [dragging, setDragging] = useState(false)
  const start = useRef<number | null>(null)
  const leaving = useRef(false)

  /*
   * Mounted at the top of the screen, then moved down a frame later.
   *
   * The transition needs two states to run between, and both have to be *rendered* — setting the
   * open position in the same paint as the mount is a jump, not a slide. `requestAnimationFrame` is
   * the smallest gap that reliably separates them.
   */
  useEffect(() => {
    if (!drawerOpen) return
    leaving.current = false
    setDy(0)
    const frame = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(frame)
  }, [drawerOpen])

  /** Slide up, then unmount — the provider's flag drops only once the sheet has left. */
  const dismiss = () => {
    if (leaving.current) return
    leaving.current = true
    setDy(0)
    setShown(false)
    window.setTimeout(() => {
      closeDrawer()
      leaving.current = false
    }, SLIDE_OUT_MS)
  }

  useEffect(() => {
    if (!drawerOpen) return
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawerOpen])

  if (!drawerOpen) return null

  const now = new Date()

  const onDown = (e: React.PointerEvent) => {
    start.current = e.clientY
    setDragging(true)
  }
  const onMove = (e: React.PointerEvent) => {
    if (start.current == null) return
    // Upward only. Dragging down would tear the sheet off the edge it is attached to.
    setDy(Math.min(0, e.clientY - start.current))
  }
  const onUp = () => {
    const close = dy < -CLOSE_DRAG_PX
    start.current = null
    setDragging(false)
    setDy(0)
    if (close) dismiss()
  }

  const open = (n: AppNotification) => {
    void markRead(n.id)
    dismiss()
    if (n.route) navigate(n.route)
  }

  const toConfig = () => {
    dismiss()
    navigate('/settings/notifications')
  }

  return (
    <div className="ml-drawerwrap">
      <div
        className={'ml-drawer__scrim' + (shown ? ' ml-drawer__scrim--shown' : '')}
        onClick={dismiss}
        aria-hidden="true"
      />
      {/* No fixed height — the sheet wraps its content. A tail of empty graphite between the last
          row and the footer reads as a broken screen; with few notifications the panel is short,
          and that is correct. */}
      <div
        className={
          'ml-drawer'
          + (shown ? ' ml-drawer--shown' : '')
          + (dragging ? ' ml-drawer--dragging' : '')
        }
        style={dy ? { transform: `translateY(${dy}px)` } : undefined}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        role="dialog"
        aria-modal="true"
        aria-label="Notifications"
      >
        <div className="ml-drawer__head">
          <span className="ml-drawer__title serif">Notifications</span>
          <span className="ml-drawer__count">
            {all.length === 0 ? 'Nothing waiting' : `${all.length} in the last week`}
          </span>
        </div>
        <div className="ml-drawer__rule" aria-hidden="true" />

        {all.length === 0 ? (
          <div className="ml-drawer__empty">Nothing waiting.</div>
        ) : (
          /* One list, newest first — the order the queue is already in. */
          <div className="ml-drawer__list">
            {all.map((n) => (
              <button
                key={n.id}
                type="button"
                className={`ml-notirow ml-notirow--${n.accent}`}
                onClick={() => open(n)}
              >
                <span className="ml-notirow__rail" aria-hidden="true" />
                <span className="ml-notirow__body">
                  <span className="ml-notirow__head">
                    <span className="ml-notirow__source">{n.label}</span>
                    <span className="ml-notirow__time">{rowTime(n.atUtc, now)}</span>
                  </span>
                  <span className="ml-notirow__headline">{n.headline}</span>
                  {n.meta && <span className="ml-notirow__meta">{n.meta}</span>}
                </span>
              </button>
            ))}
          </div>
        )}

        {/*
          Two acts, side by side and told apart by colour rather than by position: emptying the list
          is terracotta because it cannot be undone, and Config is brass because it is only a door.
          CLEAR LIST is absent on an empty list — a control whose every outcome is the state you are
          already in is worse than no control.
        */}
        <div className="ml-drawer__actions">
          {all.length > 0 && (
            <button type="button" className="ml-drawerbtn ml-drawerbtn--clear" onClick={() => void clearAll()}>
              Clear list
            </button>
          )}
          <button type="button" className="ml-drawerbtn ml-drawerbtn--config" onClick={toConfig}>
            Config
          </button>
        </div>

        <div className="ml-drawer__foot">
          <span className="ml-drawer__handle" aria-hidden="true" />
          <span className="ml-drawer__hint">Swipe up to close</span>
        </div>
      </div>
    </div>
  )
}
