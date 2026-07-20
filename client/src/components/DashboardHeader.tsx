import { OfflineChip } from './OfflineChip'

interface DashboardHeaderProps {
  /** Clock text, e.g. "19:42" (rendered in Marcellus). */
  clock: string
  /** Date line, e.g. "THURSDAY 16 JULY". */
  date: string
  /** Conditions line, e.g. "78° CLEAR · FEELS 80°". */
  conditions?: string
  /** When true, the offline chip replaces the conditions/date detail. */
  offline?: boolean
}

/** Dashboard header: big clock left; date + conditions (or offline chip) right. */
export function DashboardHeader({ clock, date, conditions, offline }: DashboardHeaderProps) {
  return (
    <header className="ml-header ml-dash-header">
      <div className="ml-dash-header__clock serif">{clock}</div>
      <div className="ml-dash-header__right">
        {offline ? (
          <OfflineChip />
        ) : (
          <>
            <div className="ml-dash-header__date">{date}</div>
            {conditions && <div className="ml-dash-header__conditions">{conditions}</div>}
          </>
        )}
      </div>
    </header>
  )
}
