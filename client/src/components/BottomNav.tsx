import { useLocation, useNavigate } from 'react-router'
import { Icon } from '../icons/Icon'
import { NAV_SECTIONS, activeSectionPath } from '../app/navConfig'
import { useCareSubjects } from '../app/careSubjects'
import { useAssist } from '../app/AssistProvider'

/**
 * Persistent bottom navigation — 8 deco tabs (Home · Calendar · Kitchen · Care · Climate · Weather ·
 * Todo · Assist). Active = bright-brass icon + label (colour only, no underline/diamond).
 *
 * **All eight navigate now.** Assist used to be the exception — a `button` that raised an overlay
 * over whatever was showing — and it became an ordinary route when it became an inbox (ASSIST.md).
 * That removed the `aria-haspopup="dialog"` special case *and* the state it papered over: the tab's
 * brass used to be invisible because the overlay covered the bar it was lighting.
 *
 * Config is not a tab at all: the account avatar opens `/settings` from every screen, and while it
 * is open nothing here lights up. That is correct rather than a missing state — no tab owns it.
 *
 * Not rendered on the Lock screen. Bottom placement is fixed for thumb/hand reach on a wall panel.
 *
 * @category Shell
 */
export function BottomNav() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const activePath = activeSectionPath(pathname)
  /*
   * A hard fault badges DEVICES, not BABY.
   *
   * It used to badge the merged CARE tab, where a robot that needed emptying and an unreachable
   * baby integration lit the same dot. Since the split the dot belongs to the machines: it is the
   * litter robot (and, when they arrive, the air conditioners) that can need a human. This is *in
   * addition to* the notification drawer row the fault also raises, never instead of it (NAV.md).
   */
  const { subjects } = useCareSubjects()
  const deviceFault = subjects.some((s) => s.id !== 'conrad' && s.faulted)
  // Unread chats badge Assist the same way — including chats with an agent that is not the one
  // currently on screen, since those are the ones nobody would otherwise go looking for.
  const { agents } = useAssist()
  const unread = agents.reduce((sum, a) => sum + a.unread, 0)

  return (
    <nav className="ml-nav">
      {NAV_SECTIONS.map((section) => {
        const isActive = section.path === activePath
        const faulted = section.path === '/devices' && deviceFault
        const badged = section.path === '/assist' && unread > 0
        return (
          <button
            key={section.path}
            className={'ml-nav__item' + (isActive ? ' ml-nav__item--active' : '')}
            /*
             * Replace, not push — a tab is a place you go, not a step you took.
             *
             * <b>This is what actually stops an edge swipe changing tabs.</b> Pushing left one
             * history entry per tab switch, and iOS treats a horizontal drag from the screen edge
             * as a back gesture: it pops that entry and the household lands on whatever tab they
             * were on before, having meant to swipe the panel in front of them. Reported twice from
             * the Care tab, whose pager is a full-width horizontal swipe surface and so invites the
             * gesture the platform is watching for.
             *
             * Blocking the gesture was tried first and does not work — iOS engages its edge-pan
             * recogniser at touch-down, so a `touchmove` `preventDefault` arrives too late, and
             * cancelling at touch-down instead would leave a dead strip down both edges of a touch
             * appliance. Removing the thing it navigates *to* costs nothing and cannot be raced.
             *
             * Nothing is lost. There is no back affordance for tabs — the bar is how you change
             * them — so no journey is being thrown away. Drill-ins still push, so their own back
             * buttons and `navigate(-1)` are unaffected.
             */
            onClick={() => navigate(section.path, { replace: true })}
            type="button"
            aria-current={isActive ? 'page' : undefined}
          >
            {/* 25px. The bar ran at 22px while it held ten items; the consolidation to eight
                bought the notch back and Assist's return did not spend it (NAV.md). */}
            <span className="ml-nav__iconbox">
              <Icon id={section.icon} size="1.5625rem" />
              {faulted && <span className="ml-nav__fault" aria-hidden="true" />}
              {badged && <span className="ml-nav__unread" aria-hidden="true" />}
            </span>
            <span className="ml-nav__label">{section.label}</span>
            {/* The badges are decorative; what they stand for is announced in words here. */}
            {faulted && <span className="ml-visually-hidden">Needs attention</span>}
            {badged && (
              <span className="ml-visually-hidden">
                {unread === 1 ? '1 unread conversation' : `${unread} unread conversations`}
              </span>
            )}
          </button>
        )
      })}
    </nav>
  )
}
