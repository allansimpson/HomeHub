import { useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useNotifications } from '../app/NotificationsProvider'
import type { AppNotification } from '../app/NotificationsProvider'

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/**
 * The live-card stack — what happens when something fires while the panel is in use.
 *
 * Sits **above the bottom nav** and never over the header, so the clock, date and weather stay
 * legible while something is arriving. Three cards at most; the badge carries the true count.
 *
 * **Depth is drawn with border and ink, never `opacity`.** Every card face stays fully opaque.
 * Stepping a whole element's opacity composites its own background, and the dashboard reads straight
 * through the card — a real defect in an earlier build. The recession is done by stepping the border,
 * the label colour, the headline colour and the rail instead.
 *
 * @category Status
 */
export function LiveCards() {
  const { live, dismiss, markRead } = useNotifications()
  const navigate = useNavigate()

  if (live.length === 0) return null

  return (
    <div className="ml-cards" role="status" aria-live="polite">
      {/* Opaque on its own band: a transparent caption floating over the dashboard's climate
          footer collides with it. */}
      <div className="ml-cards__caption">
        Swipe a card up to send it away
        {live.length > 1 && ` · ${live.length - 1} more beneath`}
      </div>
      {live.map((n, i) => (
        <Card
          key={n.id}
          n={n}
          depth={i}
          onDismiss={() => dismiss(n.id)}
          onOpen={() => {
            markRead(n.id)
            dismiss(n.id)
            if (n.route) navigate(n.route)
          }}
        />
      ))}
    </div>
  )
}

function Card({
  n, depth, onDismiss, onOpen,
}: {
  n: AppNotification
  depth: number
  onDismiss: () => void
  onOpen: () => void
}) {
  const [dy, setDy] = useState(0)
  const start = useRef<number | null>(null)
  const moved = useRef(false)

  // Swipe up to send this card away — that card alone, not the stack.
  const onDown = (e: React.PointerEvent) => {
    start.current = e.clientY
    moved.current = false
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }
  const onMove = (e: React.PointerEvent) => {
    if (start.current == null) return
    const delta = Math.min(0, e.clientY - start.current)
    if (delta < -6) moved.current = true
    setDy(delta)
  }
  const onUp = () => {
    if (start.current == null) return
    const sent = dy < -48
    start.current = null
    setDy(0)
    if (sent) onDismiss()
    else if (!moved.current) onOpen()
  }

  return (
    <div
      className={`ml-card ml-card--d${depth} ml-card--${n.accent}`}
      style={dy ? { transform: `translateY(${dy}px)`, opacity: Math.max(0.2, 1 + dy / 120) } : undefined}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
    >
      <span className="ml-card__rail" aria-hidden="true" />
      <div className="ml-card__head">
        <span className="ml-card__source">{n.label}</span>
        <span className="ml-card__time">{clock(n.atUtc)}</span>
      </div>
      <div className="ml-card__headline">{n.headline}</div>
      {/* Only the front card shows a timeout track, and only when it will actually time out —
          a *wants you* card waits, so a draining bar under it would be a lie. */}
      {depth === 0 && n.severity === 'worth-knowing' && (
        <span className="ml-card__timeout" aria-hidden="true" />
      )}
    </div>
  )
}
