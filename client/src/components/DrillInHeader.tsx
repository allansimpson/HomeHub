import type { ReactNode } from 'react'
import { BackButton } from './BackButton'

interface DrillInHeaderProps {
  title: string
  /**
   * Back target. Omitted on the main tab destinations — a tab is reached from the bottom nav, so
   * there is nothing to go "back" to; only drill-ins (Config sub-screens, Sensor History) carry it.
   */
  onBack?: () => void
  /**
   * Name the screen `onBack` returns to, beside the arrow — see {@link BackButton}. Only for screens
   * reachable from somewhere other than their parent; a drill-in you can only have come from says
   * nothing new by naming it.
   */
  backLabel?: string
  /** Right-aligned status text, e.g. "16 JULY · 19:42" or "3 OF 5 RUNNING". */
  status?: ReactNode
  /** Render the status in verdigris (live/OK). */
  statusLive?: boolean
  /**
   * Make the title itself the way to rename what it names.
   *
   * Supplied only where a title is a piece of household data rather than a screen name — an Assist
   * chat is the one so far. The title is a button then, and nothing else changes: no pencil, no
   * overflow menu, no second control in a header that has room for one thing. A screen called
   * "Config" has nothing to rename and passes nothing.
   */
  onTitleClick?: () => void
  /** What tapping the title offers to do, for anyone who cannot see that it is a control. */
  titleAction?: string
}

/**
 * Drill-in header: ◂ back + Marcellus title + right-aligned status.
 *
 * @category Shell
 */
export function DrillInHeader({
  title, onBack, backLabel, status, statusLive, onTitleClick, titleAction,
}: DrillInHeaderProps) {
  return (
    <header className="ml-header ml-header--drillin">
      {onBack && <BackButton onClick={onBack} text={backLabel} />}
      {onTitleClick ? (
        <button
          type="button"
          className="ml-drillin-header__title ml-drillin-header__title--action serif"
          onClick={onTitleClick}
          aria-label={titleAction ? `${titleAction}: ${title}` : title}
        >
          {title}
        </button>
      ) : (
        <span className="ml-drillin-header__title serif">{title}</span>
      )}
      {status !== undefined && (
        <span className={`ml-drillin-header__status${statusLive ? ' ml-drillin-header__status--live' : ''}`}>
          {status}
        </span>
      )}
    </header>
  )
}
