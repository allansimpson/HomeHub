import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Icon } from '../icons/Icon'
import { useSession } from '../app/SessionProvider'
import { useVoice } from '../app/VoiceProvider'
import { useSensors } from '../app/SensorsProvider'

/**
 * Ever-present account control (spec 13): a fixed top-right avatar on every screen that opens a
 * sign-in / switch / sign-out menu — the single global identity affordance, replacing per-screen
 * profile chips. Yields to the full-width top takeovers (mic-live + severe-weather banners) and is
 * hidden on the calendar event modal (and on the lock screen, which App doesn't render it under).
 * "Sign in / switch / sign out" map to this app's profile session (the lock screen).
 */
export function AccountControl() {
  const navigate = useNavigate()
  const location = useLocation()
  const { activeProfile, profiles, lockNow } = useSession()
  const { micLive } = useVoice()
  const { alerts } = useSensors()
  const [open, setOpen] = useState(false)

  // Hide on the event-editor modal; yield entirely while the mic banner owns the top strip.
  const onEventModal = location.pathname.startsWith('/calendar/new') || location.pathname.startsWith('/calendar/edit')
  if (micLive || onEventModal) return null

  // Drop below a severe-weather / alert banner when one is showing on this screen.
  const bannerHere =
    (location.pathname === '/' && alerts.length > 0) ||
    (location.pathname === '/weather' && alerts.some((a) => a.source === 'weather'))

  const signedIn = !!activeProfile
  const others = profiles.filter((p) => p.id !== activeProfile?.id).map((p) => p.initial).join(' · ')

  const go = (path: string) => {
    setOpen(false)
    navigate(path)
  }
  const signOut = () => {
    setOpen(false)
    lockNow()
  }

  return (
    <>
      <button
        type="button"
        className={'ml-account' + (signedIn ? ' ml-account--in' : '') + (bannerHere ? ' ml-account--yield' : '')}
        onClick={() => setOpen((v) => !v)}
        aria-label={signedIn ? `Account: ${activeProfile!.name}` : 'Not signed in'}
        aria-expanded={open}
      >
        {signedIn ? <span className="ml-account__initial serif">{activeProfile!.initial}</span> : <Icon id="ico-person" size="1.5rem" />}
      </button>

      {open && (
        <>
          <div className="ml-account__backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className={'ml-account__menu' + (bannerHere ? ' ml-account__menu--yield' : '')} role="menu">
            {signedIn ? (
              <>
                <div className="ml-account__id">
                  <span className="ml-account__idavatar serif">{activeProfile!.initial}</span>
                  <span className="ml-account__idcol">
                    <span className="ml-account__idname serif">{activeProfile!.name}</span>
                    <span className="ml-account__idstatus">
                      <span className="ml-account__dot" aria-hidden="true" />Signed in · Synced
                    </span>
                  </span>
                </div>
                <button type="button" className="ml-account__row" role="menuitem" onClick={() => go('/settings')}>
                  <Icon id="ico-person" size="1.25rem" />
                  <span className="ml-account__rowlabel">Account</span>
                  <Icon id="ico-chevron-right" size="1rem" />
                </button>
                <button type="button" className="ml-account__row" role="menuitem" onClick={() => go('/lock')}>
                  <Icon id="ico-signin" size="1.25rem" />
                  <span className="ml-account__rowlabel">Switch profile</span>
                  {others && <span className="ml-account__rowmeta">{others}</span>}
                </button>
                <button type="button" className="ml-account__row ml-account__row--danger" role="menuitem" onClick={signOut}>
                  <Icon id="ico-signout" size="1.25rem" />
                  <span className="ml-account__rowlabel">Sign out</span>
                </button>
              </>
            ) : (
              <>
                <div className="ml-account__id">
                  <span className="ml-account__idavatar ml-account__idavatar--out"><Icon id="ico-person" size="1.25rem" /></span>
                  <span className="ml-account__idcol">
                    <span className="ml-account__idname serif">Not signed in</span>
                    <span className="ml-account__idstatus ml-account__idstatus--muted">Shared screens only</span>
                  </span>
                </div>
                <div className="ml-account__explain">
                  Sign in with a household Microsoft account to see your TODO lists, the assistant, and personal data.
                </div>
                <button type="button" className="ml-account__signin" role="menuitem" onClick={() => go('/lock')}>Sign in</button>
              </>
            )}
          </div>
        </>
      )}
    </>
  )
}
