import { useLocation, useNavigate } from 'react-router'
import { BackButton, ScreenShell, ScrollArea } from '../../components'
import { useCareSubjects, type CareSubjectId } from '../../app/careSubjects'
import { useClock } from '../../app/useClock'
import { ConradView } from './ConradView'
import { MikaView } from './MikaView'

/**
 * One subject, one frame — the baby under `/care`, the litter robot under `/devices/litter`.
 *
 * <b>The switcher is gone.</b> Baby and Litter were merged into one CARE tab on the reasoning that
 * they share a five-part structure — live status, today's log, quick actions, history, settings —
 * and they genuinely do. What they never shared is a shape, and the merge kept saying so: <b>a baby
 * is a log you write to many times a day; a litter robot is a machine you read when it complains.</b>
 * The two views inside this frame stayed completely different for exactly that reason.
 *
 * The August split (design_handoff_baby_devices) finishes the thought. The baby keeps the tab and is
 * called BABY again; the robot moves in with the air conditioners under DEVICES, where it is one
 * device among several rather than the other half of a child. So this file keeps only what is
 * genuinely shared — the header line, the sync row, the scroll body — and the route decides which
 * subject it is framing.
 *
 * The path stays `/care` for the baby deliberately: the household's bookmarks, the Attendant and
 * every notification deep link emit it, and a tab rename is not a reason to break them.
 */
export function CareScreen() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { subjects } = useCareSubjects()
  const { stamp } = useClock()

  const isDevice = pathname.startsWith('/devices')
  const subject: CareSubjectId = isDevice ? 'mika' : 'conrad'
  const active = subjects.find((s) => s.id === subject) ?? subjects[0]

  return (
    <ScreenShell
      header={
        <header className={'ml-header ml-care__switcher' + (isDevice ? ' ml-header--drillin' : '')}>
          {/* A device is a drill-in from the array. The baby is a tab, and has nowhere to go back to. */}
          {isDevice && <BackButton onClick={() => navigate('/devices')} />}
          <span className="ml-care__name serif">{active.name}</span>
          {active.meta && <span className="ml-care__namemeta">{active.meta}</span>}
          {/* The tab dates its header, the same way Meals, Weather and Devices do. The litter
              drill-in does not: it is reached from Devices, which said the day one tap ago. */}
          {!isDevice && <span className="ml-drillin-header__status">{stamp}</span>}
        </header>
      }
    >
      {/*
        The sync row belongs to the machine, not to the child.

        <b>On the robot it is the headline.</b> A litter box is a thing you read when it complains,
        and "when did we last hear from it" is the first question anybody has about one — a reading
        with no freshness beside it is a reading you cannot act on.

        <b>On the baby it was a claim about somebody else's service.</b> `UPDATED 7 S AGO` and the
        clock beside it reported the Huckleberry integration's last poll — but everything below is
        HomeHub's own log, which is written to this device first and works with no server at all.
        So the line described a freshness the surface under it does not depend on, in a position
        that reads as though it does: at 3am, "updated 7 seconds ago" over a list of feeds says the
        feeds are 7 seconds fresh, and they are not, and on a bad night it would say the log was
        stale when every entry in it had already been written down safely.

        Nothing is lost by removing it. The integration's health is stated in Config → Baby
        settings, where the pull that uses it lives; and a *hard* fault still badges the tab and
        drops a NEEDS YOU row on the dashboard, which is the path that actually fetches somebody.
      */}
      {isDevice && (
        <div className={`ml-syncline ml-syncline--${active.sync.tone}`}>
          <span className="ml-syncline__dot" aria-hidden="true" />
          <span className="ml-syncline__text">{active.sync.text}</span>
          {active.sync.meta && <span className="ml-syncline__meta">{active.sync.meta}</span>}
        </div>
      )}

      <ScrollArea>
        <div className="ml-care__body">
          {isDevice ? <MikaView /> : <ConradView />}
        </div>
      </ScrollArea>
    </ScreenShell>
  )
}
