import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

interface HoldButtonProps {
  children: ReactNode
  /** Fires once the hold completes. Never on a plain tap. */
  onHold: () => void
  /** Hold duration in ms; 2s for anything destructive. */
  ms?: number
  /** Terracotta treatment for actions that invalidate state or can't be taken back. */
  destructive?: boolean
  disabled?: boolean
  /** Secondary line under the label — the elapsed-time meta or the reason it's disabled. */
  meta?: ReactNode
  className?: string
  /** Accessible name when the visible label isn't enough on its own. */
  label?: string
  /**
   * Render the hold as a slim track under the label rather than as a fill sweeping across the whole
   * block.
   *
   * The clean-cycle control is a full-width band with its own internal layout, and a background sweep
   * across it reads as the block being selected rather than as a hold in progress. A 6px track under
   * the label says "keep pressing" without changing what the block looks like.
   */
  progressTrack?: boolean
}

/**
 * Press and hold to act.
 *
 * A wall panel at cat height gets bumped, and both sections it serves have actions that a stray
 * touch must not fire: baby entries can't be deleted upstream, and resetting the waste drawer
 * silently invalidates the reading until someone notices the box refusing to cycle. Releasing early
 * cancels — nothing fires unless the ring completes, which is also the affordance that tells you
 * something irreversible is about to happen.
 *
 * Keyboard: Enter/Space act immediately. The hold exists to defeat accidental *touches*, and a key
 * press is already deliberate.
 *
 * @category Controls
 */
export function HoldButton({
  children, onHold, ms = 2000, destructive, disabled, meta, className, label, progressTrack,
}: HoldButtonProps) {
  const [progress, setProgress] = useState(0)
  const frame = useRef(0)
  const startedAt = useRef(0)

  const stop = useCallback(() => {
    if (frame.current) cancelAnimationFrame(frame.current)
    frame.current = 0
    setProgress(0)
  }, [])

  useEffect(() => stop, [stop])

  const start = useCallback(() => {
    if (disabled || frame.current) return
    startedAt.current = performance.now()
    const step = () => {
      const elapsed = performance.now() - startedAt.current
      const next = Math.min(1, elapsed / ms)
      setProgress(next)
      if (next >= 1) {
        stop()
        onHold()
        return
      }
      frame.current = requestAnimationFrame(step)
    }
    frame.current = requestAnimationFrame(step)
  }, [disabled, ms, onHold, stop])

  return (
    <button
      type="button"
      aria-label={label}
      className={
        'ml-hold' +
        (destructive ? ' ml-hold--destructive' : '') +
        (progress > 0 ? ' ml-hold--holding' : '') +
        (className ? ` ${className}` : '')
      }
      disabled={disabled}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          if (!disabled) onHold()
        }
      }}
    >
      {!progressTrack && (
        <span className="ml-hold__fill" style={{ transform: `scaleX(${progress})` }} aria-hidden="true" />
      )}
      <span className="ml-hold__body">
        <span className="ml-hold__label">{children}</span>
        {progressTrack && (
          <span className="ml-hold__track" aria-hidden="true">
            <span className="ml-hold__trackfill" style={{ transform: `scaleX(${progress})` }} />
          </span>
        )}
        {meta !== undefined && <span className="ml-hold__meta">{meta}</span>}
      </span>
    </button>
  )
}
