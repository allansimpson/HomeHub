import type { ReactNode } from 'react'

interface LedgerRowProps {
  title?: ReactNode
  sub?: ReactNode
  /** Right-side content (values, chips, chevrons). */
  right?: ReactNode
  /** Tapping drills in / performs the row action. */
  onClick?: () => void
  /** Use the heavier major hairline for the top border. */
  major?: boolean
  children?: ReactNode
}

/** Full-width, hairline-separated ledger row with left content / right content slots. */
export function LedgerRow({ title, sub, right, onClick, major, children }: LedgerRowProps) {
  const className =
    'ml-row' + (major ? ' ml-row--major' : '') + (onClick ? ' ml-row--tappable' : '')

  const body = children ?? (
    <>
      <div className="ml-row__main">
        {title !== undefined && <div className="ml-row__title">{title}</div>}
        {sub !== undefined && <div className="ml-row__sub">{sub}</div>}
      </div>
      {right !== undefined && <div className="ml-row__right">{right}</div>}
    </>
  )

  if (onClick) {
    return (
      <button className={className} onClick={onClick} type="button">
        {body}
      </button>
    )
  }
  return <div className={className}>{body}</div>
}
