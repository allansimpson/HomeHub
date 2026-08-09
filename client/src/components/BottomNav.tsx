import { useLocation, useNavigate } from 'react-router'
import { Icon } from '../icons/Icon'
import { NAV_SECTIONS, activeSectionPath } from '../app/navConfig'
import { useCareSubjects } from '../app/careSubjects'
import { useAssist } from '../app/AssistProvider'

/**
 * Persistent bottom navigation — 8 deco tabs (Home · Calendar · Meals · Care · Climate · Weather ·
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
  // A hard fault on either Care subject badges the tab. This is *in addition to* the notification
  // drawer row the fault also raises, never instead of it (NAV.md).
  const { anyFault } = useCareSubjects()
  // Unread chats badge Assist the same way — including chats with an agent that is not the one
  // currently on screen, since those are the ones nobody would otherwise go looking for.
  const { agents } = useAssist()
  const unread = agents.reduce((sum, a) => sum + a.unread, 0)

  return (
    <nav className="ml-nav">
      {NAV_SECTIONS.map((section) => {
        const isActive = section.path === activePath
        const faulted = section.path === '/care' && anyFault
        const badged = section.path === '/assist' && unread > 0
        return (
          <button
            key={section.path}
            className={'ml-nav__item' + (isActive ? ' ml-nav__item--active' : '')}
            onClick={() => navigate(section.path)}
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
