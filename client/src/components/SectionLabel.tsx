import type { ReactNode } from 'react'

interface SectionLabelProps {
  label: string
  /** Optional right-side status (muted, or verdigris when live). */
  status?: ReactNode
  /** Render the status in verdigris (live/OK). */
  statusLive?: boolean
}

/** Section label row: brass tick + letterspaced caps label + optional right status. */
export function SectionLabel({ label, status, statusLive }: SectionLabelProps) {
  return (
    <div className="ml-section">
      <span className="ml-section__tick" aria-hidden="true" />
      <span className="ml-section__label">{label}</span>
      {status !== undefined && (
        <span className={`ml-section__status${statusLive ? ' ml-section__status--live' : ''}`}>{status}</span>
      )}
    </div>
  )
}
