import type { ReactNode } from 'react'
import { BackButton } from './BackButton'

interface DrillInHeaderProps {
  title: string
  onBack: () => void
  /** Right-aligned status text, e.g. "16 JULY · 19:42" or "3 OF 5 RUNNING". */
  status?: ReactNode
  /** Render the status in verdigris (live/OK). */
  statusLive?: boolean
}

/** Drill-in header: ◂ back + Marcellus title + right-aligned status. */
export function DrillInHeader({ title, onBack, status, statusLive }: DrillInHeaderProps) {
  return (
    <header className="ml-header ml-header--drillin">
      <BackButton onClick={onBack} />
      <span className="ml-drillin-header__title serif">{title}</span>
      {status !== undefined && (
        <span className={`ml-drillin-header__status${statusLive ? ' ml-drillin-header__status--live' : ''}`}>
          {status}
        </span>
      )}
    </header>
  )
}
