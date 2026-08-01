import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useNotifications } from '../app/NotificationsProvider'
import type { AppNotification } from '../app/NotificationsProvider'

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** Counts read as words in the group headers — `ONE`, `FOUR` — not as digits. */
const WORDS = ['none', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
function spell(n: number): string {
  return n < WORDS.length ? WORDS[n] : String(n)
}

function isToday(iso: string): boolean {
  const d = new Date(iso)
  const now = new Date()
  return d.toDateString() === now.toDateString()
}

/**
 * The invisible strip along the top edge that opens the drawer.
 *
 * Deliberately thin and above everything: the gesture has to work from any tab without stealing
 * taps from the header beneath it. It only claims the pointer once a downward drag is unambiguous.
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
 * The pull-down drawer — a **sheet, not a screen**. The app stays where it was underneath, dimmed
 * behind a scrim, and comes back untouched when the sheet closes.
 *
 * Grouped by severity rather than by time, because the question it answers is "is anything waiting
 * for me", not "what happened when".
 */
export function NotificationDrawer() {
  const { all, drawerOpen, closeDrawer, clearAll, markRead } = useNotifications()
  const navigate = useNavigate()
  const [dy, setDy] = useState(0)
  const start = useRef<number | null>(null)

  if (!drawerOpen) return null

  const wantsYou = all.filter((n) => n.severity === 'wants-you')
  const worthKnowing = all.filter((n) => n.severity === 'worth-knowing' && isToday(n.atUtc))
  // Everything worth knowing that isn't today's — the store keeps seven days, so this is not
  // "yesterday" and the heading below says so. It used to claim yesterday while showing rows up to
  // a week old, which quietly misdates every one of them.
  const earlier = all.filter((n) => n.severity === 'worth-knowing' && !isToday(n.atUtc))

  const onDown = (e: React.PointerEvent) => { start.current = e.clientY }
  const onMove = (e: React.PointerEvent) => {
    if (start.current == null) return
    setDy(Math.min(0, e.clientY - start.current))
  }
  const onUp = () => {
    const close = dy < -60
    start.current = null
    setDy(0)
    if (close) closeDrawer()
  }

  const open = (n: AppNotification) => {
    void markRead(n.id)
    closeDrawer()
    if (n.route) navigate(n.route)
  }

  return (
    <div className="ml-drawerwrap">
      <div className="ml-drawer__scrim" onClick={closeDrawer} aria-hidden="true" />
      {/* No fixed height — the sheet wraps its content. A tail of empty graphite between the last
          row and the handle reads as a broken screen; with few notifications the drawer is short,
          and that is correct. */}
      <div
        className="ml-drawer"
        style={dy ? { transform: `translateY(${dy}px)` } : undefined}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        role="dialog"
        aria-label="Notifications"
      >
        <div className="ml-drawer__head">
          <span className="ml-drawer__title serif">Notifications</span>
          <button type="button" className="ml-linkbtn" onClick={() => void clearAll()}>Clear all</button>
        </div>
        <div className="ml-drawer__rule" aria-hidden="true" />

        {all.length === 0 && (
          <div className="ml-drawer__empty">Nothing waiting.</div>
        )}

        <Group label="Wants you" rows={wantsYou} onOpen={open} />
        <Group label="Worth knowing" rows={worthKnowing} onOpen={open} />
        <Group label="Earlier" rows={earlier} onOpen={open} />

        <div className="ml-drawer__foot">
          <span className="ml-drawer__handle" aria-hidden="true" />
          <span className="ml-drawer__hint">Swipe up to close</span>
        </div>
      </div>
    </div>
  )
}

function Group({
  label, rows, onOpen,
}: {
  label: string
  rows: AppNotification[]
  onOpen: (n: AppNotification) => void
}) {
  if (rows.length === 0) return null
  return (
    <>
      <div className="ml-drawer__group">
        <span className="ml-drawer__grouplabel">{label}</span>
        <span className="ml-drawer__groupcount">{spell(rows.length)}</span>
      </div>
      {rows.map((n) => (
        <button key={n.id} type="button" className={`ml-notirow ml-notirow--${n.accent}`} onClick={() => onOpen(n)}>
          <span className="ml-notirow__rail" aria-hidden="true" />
          <span className="ml-notirow__body">
            <span className="ml-notirow__head">
              <span className="ml-notirow__source">{n.label}</span>
              <span className="ml-notirow__time">{clock(n.atUtc)}</span>
            </span>
            <span className="ml-notirow__headline">{n.headline}</span>
            {n.meta && <span className="ml-notirow__meta">{n.meta}</span>}
          </span>
        </button>
      ))}
    </>
  )
}
