import { useNavigate } from 'react-router-dom'
import { useSession } from '../app/SessionProvider'
import { Icon } from '../icons/Icon'

/**
 * Ever-present account control (spec 13): a 48px circle pinned top-right of every standard screen —
 * the one consistent place to see who is signed in. Verdigris ring + Marcellus initial when signed
 * in; hairline ring + neutral person glyph when signed out.
 *
 * Tapping opens the CONFIG tab (the panel's single account surface) rather than an anchored pop-out
 * menu — the shared-chrome spec allows either, and this panel routes identity through CONFIG.
 * Rendered by ScreenShell, so it is absent exactly where the spec says: the Lock screen and the
 * Calendar event modal (both render with `nav={false}`), and it sits below any full-width banner.
 */
export function AccountAvatar() {
  const navigate = useNavigate()
  const { activeProfile } = useSession()

  return (
    <button
      type="button"
      className={'ml-avatar' + (activeProfile ? ' ml-avatar--in' : '')}
      onClick={() => navigate('/settings')}
      aria-label={activeProfile ? `Account — ${activeProfile.name}` : 'Not signed in'}
    >
      {activeProfile ? (
        <span className="serif">{activeProfile.initial}</span>
      ) : (
        <Icon id="ico-person" size="1.375rem" />
      )}
    </button>
  )
}
