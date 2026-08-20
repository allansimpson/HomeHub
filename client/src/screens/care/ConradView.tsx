import { CareLogView } from './CareLogView'
import { useCareSubjects } from '../../app/careSubjects'

/**
 * Conrad — log first.
 *
 * The view is HomeHub's own care log and nothing else. It used to be a second surface on top of it:
 * hold-to-confirm tiles that called Huckleberry's Home Assistant services, and read-only TODAY /
 * LATEST / GROWTH ledgers rendered from the sensors those services fed. That surface was shaped
 * entirely by what the integration could not do — no delete, no edit, no retroactive timestamp, four
 * loggable kinds out of ten — so every tile had to hold to confirm and say `NO UNDO` out loud.
 *
 * {@link CareLogView} has none of those limits: ten types, a real time, and entries that can be
 * corrected. Keeping both meant two ways to log a feed, two nursing timers for one session, and two
 * disagreeing accounts of the same day. Huckleberry is not reached from this section at all now —
 * the one-off pull of its history is in Config → Baby settings — though the sync line in
 * `CareScreen` still reports the integration's health.
 *
 * Rendered inside `CareScreen`'s frame — no shell, no header, no sync line of its own.
 */
export function ConradView() {
  const { subjects } = useCareSubjects()

  const conrad = subjects.find((s) => s.id === 'conrad')

  /*
   * No footer of its own.
   *
   * Two things used to sit down here and neither belonged to a child's log. The litter robot's sync
   * line went first; the `TRENDS ▸` link beside it turns out to have pointed at `/care/history`,
   * which is the *litter* history screen — so the last row of the baby page was two cat controls.
   * The design ends this view on the log's own footer, and the log now draws it.
   */
  return <CareLogView childKey="conrad" childName={conrad?.name} />
}
