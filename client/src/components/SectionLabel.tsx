import type { ReactNode } from 'react'

interface SectionLabelProps {
  label: string
  /** Optional right-side status (muted, or verdigris when live). */
  status?: ReactNode
  /** Render the status in verdigris (live/OK). */
  statusLive?: boolean
  /** Render the tick + label in verdigris — marks a "live"/app-level group (e.g. SMART VIEWS). */
  live?: boolean
  /**
   * Show the 14×3 brass tick before the label.
   *
   * **Off by default.** The system README allows omitting it "on card-free rows where a label/value
   * row is used instead", and that turned out to describe every heading on this panel — the screens
   * are ruled rows throughout, not cards. Left on, the tick indented every heading past the gutter
   * so no label lined up with the content under it.
   *
   * Kept as an opt-in rather than deleted, so a genuinely card-based screen can still ask for it.
   */
  tick?: boolean
}

/**
 * Section label row: optional brass tick + letterspaced caps label + optional right status.
 *
 * @category Structure
 */
export function SectionLabel({ label, status, statusLive, live, tick = false }: SectionLabelProps) {
  return (
    <div className="ml-section">
      {tick && <span className={`ml-section__tick${live ? ' ml-section__tick--live' : ''}`} aria-hidden="true" />}
      <span className={`ml-section__label${live ? ' ml-section__label--live' : ''}`}>{label}</span>
      {status !== undefined && (
        <span className={`ml-section__status${statusLive ? ' ml-section__status--live' : ''}`}>{status}</span>
      )}
    </div>
  )
}
