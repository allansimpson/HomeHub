import { useLocation, useNavigate } from 'react-router-dom'
import { Icon } from '../icons/Icon'
import { NAV_SECTIONS, activeSectionPath } from '../app/navConfig'

/**
 * Persistent bottom navigation — 8 deco tabs (Home · Calendar · Baby · Litter · Climate · Weather ·
 * TODO · Assist). Active = bright-brass icon + label (colour only, no underline/diamond).
 *
 * Config is not a tab: the account avatar opens it from every screen, so while `/settings` is open
 * nothing here lights up. That is correct rather than a missing state — no tab owns that route.
 *
 * Not rendered on the Lock screen. Bottom placement is fixed for thumb/hand reach on a wall panel.
 */
export function BottomNav() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const activePath = activeSectionPath(pathname)

  return (
    <nav className="ml-nav">
      {NAV_SECTIONS.map((section) => {
        const isActive = section.path === activePath
        return (
          <button
            key={section.path}
            className={'ml-nav__item' + (isActive ? ' ml-nav__item--active' : '')}
            onClick={() => navigate(section.path)}
            type="button"
            aria-current={isActive ? 'page' : undefined}
          >
            {/* 22px — the 9-tab step. The bar ran at 23px while it held eight items, which was a
                notch reclaimed when Config left; adding Meals puts it back to nine, and both
                MEALS_NAV.md and the ico-meals handoff specify 22px there. */}
            <Icon id={section.icon} size="1.375rem" />
            <span className="ml-nav__label">{section.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
