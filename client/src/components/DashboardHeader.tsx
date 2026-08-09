import { OfflineChip } from './OfflineChip'

interface DashboardHeaderProps {
  /** Clock text, e.g. "7:42" (rendered in Marcellus). */
  clock: string
  /** Meridiem for {@link clock}, set small after it — `AM` / `PM`. */
  ampm?: string
  /** Date line, e.g. "THURSDAY 16 JULY". */
  date: string
  /** Conditions line, e.g. "78° CLEAR · FEELS 80°". */
  conditions?: string
  /**
   * Where those conditions are for, e.g. "Minneapolis, MN".
   *
   * Its own line under the conditions rather than part of them: the temperature changes hourly and
   * the town does not, so sharing a line would have the place shifting about as the numbers either
   * side of it changed length. Omitted entirely until the forecast provider has named the location —
   * the header then reads exactly as it did before, which is better than a coordinate nobody standing
   * in the kitchen can check.
   */
  place?: string
  /** When true, the offline chip replaces the conditions/date detail. */
  offline?: boolean
  /** Active-profile monogram; when set with onSwitchProfile, renders the switcher badge. */
  profileInitial?: string
  /** Opens the profile switcher (Lock screen). */
  onSwitchProfile?: () => void
}

/**
 * Dashboard header: big clock left; date + conditions (or offline chip) right. Identity is global
 * (spec 13).
 *
 * **No bell.** The unread count moved to the account avatar, which was already the only route to
 * `/settings` → `Notifications` — a count belongs on the door it opens, and the bell was a second
 * glyph crowding the same corner. The drag-down `NotificationPullTab` is still the way to the
 * drawer, so nothing lost a route.
 *
 * @category Shell
 */
export function DashboardHeader({ clock, ampm, date, conditions, place, offline }: DashboardHeaderProps) {
  return (
    <header className="ml-header ml-dash-header">
      {/* The meridiem rides after the numerals at a fraction of their size, the same treatment the
          NEXT rows give an event time — it is a qualifier on the number, not part of it. */}
      <div className="ml-dash-header__clock serif">
        {clock}
        {ampm && <span className="ml-dash-header__ampm">{ampm}</span>}
      </div>
      <div className="ml-dash-header__right">
        {/* Profile chip removed — identity + switch/sign-out live under the Account nav tab. */}
        {offline ? (
          <OfflineChip />
        ) : (
          <>
            <div className="ml-dash-header__date">{date}</div>
            {conditions && <div className="ml-dash-header__conditions">{conditions}</div>}
            {/* Only alongside conditions. On its own it would be a town name with no weather under
                it, which says nothing the household needs from a dashboard. */}
            {conditions && place && <div className="ml-dash-header__place">{place}</div>}
          </>
        )}
      </div>
    </header>
  )
}
