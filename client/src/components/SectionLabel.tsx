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
   * Show the 14×3 brass tick before the label. The system README allows omitting it "on card-free
   * rows where a label/value row is used instead" — the dashboard's sections read without it.
   */
  tick?: boolean
}

/** Section label row: optional brass tick + letterspaced caps label + optional right status. */
export function SectionLabel({ label, status, statusLive, live, tick = true }: SectionLabelProps) {
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
