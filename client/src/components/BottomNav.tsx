import { useLocation, useNavigate } from 'react-router-dom'
import { Icon } from '../icons/Icon'
import { NAV_SECTIONS } from '../app/navConfig'

/**
 * Persistent bottom navigation — 5 deco icons. Active = brass icon + label with an
 * underline tick; the dashboard's active item uses a brass diamond instead. Not rendered on
 * the Lock screen. Bottom placement is fixed for thumb/hand reach on a wall panel.
 */
export function BottomNav() {
  const navigate = useNavigate()
  const { pathname } = useLocation()

  return (
    <nav className="ml-nav">
      {NAV_SECTIONS.map((section) => {
        const isActive =
          section.path === '/' ? pathname === '/' : pathname.startsWith(section.path)
        const isHome = section.path === '/'
        return (
          <button
            key={section.path}
            className={'ml-nav__item' + (isActive ? ' ml-nav__item--active' : '')}
            onClick={() => navigate(section.path)}
            type="button"
            aria-current={isActive ? 'page' : undefined}
          >
            <Icon id={section.icon} size="1.5rem" />
            <span className="ml-nav__label">{section.label}</span>
            {isActive && isHome ? (
              <span className="ml-nav__diamond" aria-hidden="true" />
            ) : (
              <span
                className={'ml-nav__tick' + (isActive ? '' : ' ml-nav__tick--hidden')}
                aria-hidden="true"
              />
            )}
          </button>
        )
      })}
    </nav>
  )
}
