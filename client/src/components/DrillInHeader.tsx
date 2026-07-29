import type { ReactNode } from 'react'
import { BackButton } from './BackButton'

interface DrillInHeaderProps {
  title: string
  /**
   * Back target. Omitted on the main tab destinations — a tab is reached from the bottom nav, so
   * there is nothing to go "back" to; only drill-ins (Config sub-screens, Sensor History) carry it.
   */
  onBack?: () => void
  /** Right-aligned status text, e.g. "16 JULY · 19:42" or "3 OF 5 RUNNING". */
  status?: ReactNode
  /** Render the status in verdigris (live/OK). */
  statusLive?: boolean
}

/** Drill-in header: ◂ back + Marcellus title + right-aligned status. */
export function DrillInHeader({ title, onBack, status, statusLive }: DrillInHeaderProps) {
  return (
    <header className="ml-header ml-header--drillin">
      {onBack && <BackButton onClick={onBack} />}
      <span className="ml-drillin-header__title serif">{title}</span>
      {status !== undefined && (
        <span className={`ml-drillin-header__status${statusLive ? ' ml-drillin-header__status--live' : ''}`}>
          {status}
        </span>
      )}
    </header>
  )
}
