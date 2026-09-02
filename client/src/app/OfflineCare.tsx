import { DrillInHeader, ScreenShell } from '../components'
import { CareLogView } from '../screens/care/CareLogView'

/**
 * The whole of what an unlocked-but-unconfirmed panel may show: the local, owner-bound Care log.
 *
 * <b>This exists because "the server is unreachable" is not a capability boundary.</b> The previous
 * arrangement mounted the full provider tree and the whole router in device-only, on the reasoning
 * that nothing could be fetched anyway. Connectivity returns while stale cookies, polling effects and
 * cached state are still live, and the window between those two things is where a request begun
 * under one identity lands under another's cookie. So device-only is its own state with its own
 * capability, rather than a degraded version of a confirmed one.
 *
 * <b>Deliberately not the router.</b> Rendering `App` with the providers suspended would leave every
 * other screen reachable and empty, and each of those screens is a promise the panel cannot keep
 * without a server — a shopping list that is not the list, a week with no plan. Worse, it would put
 * the decision "may this screen run" back inside eleven components. One screen, mounted directly, is
 * a boundary somebody can look at.
 *
 * <b>And deliberately not `CareScreen`.</b> That reaches `useCareSubjects`, which reads `useBaby` and
 * `useLitter` — two authenticated polling providers. Going through it would drag exactly what this is
 * meant to exclude back into the tree. `CareLogView` needs only the connection and the write queue,
 * both of which live above this and are safe: the queue is owner-bound and suspended until the server
 * confirms who is asking.
 *
 * The child's name is not passed, and that is not an omission. It lives in `/api/settings`, which is
 * private and uncached, so the log reads `Baby` here — the same behaviour an offline care session has
 * always had, and an honest one: the panel genuinely does not know whose log this is beyond the
 * profile that unlocked it.
 */
export function OfflineCare() {
  return (
    <ScreenShell
      // No nav, for the same reason the lock screen has none: there is nowhere else to go. Offering
      // tabs that cannot load would be the panel promising what it cannot keep.
      nav={false}
      header={<DrillInHeader title="CARE" status="OFFLINE" />}
    >
      <CareLogView childKey="conrad" />
    </ScreenShell>
  )
}
