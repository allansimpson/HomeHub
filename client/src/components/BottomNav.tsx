import { useLocation, useNavigate } from 'react-router-dom'
import { Icon } from '../icons/Icon'
import { NAV_SECTIONS, activeSectionPath } from '../app/navConfig'

/**
 * Persistent bottom navigation — 7 deco tabs (Home · Calendar · Climate · Weather · TODO ·
 * Assist · CONFIG). Active = bright-brass icon + label (colour only, no underline/diamond).
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
            <Icon id={section.icon} size="1.5625rem" />
            <span className="ml-nav__label">{section.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
