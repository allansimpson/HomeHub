import { useNavigate } from 'react-router'
import { useSession } from '../app/SessionProvider'
import { useNotifications } from '../app/NotificationsProvider'
import { Icon } from '../icons/Icon'

interface AccountAvatarProps {
  /**
   * Show the wants-you badge (default true).
   *
   * False on the two screens where a count is a dead affordance: the inbox itself, where you are
   * reading the list, and Config, where the Notifications row states the count in words one tap
   * away. Everywhere else it renders — including under the drawer scrim, where the app beneath dims
   * and keeps its badge rather than earning a special case.
   */
  showBadge?: boolean
}

/**
 * Ever-present account control (spec 13): a 48px circle pinned top-right of every standard screen —
 * the one consistent place to see who is signed in. Verdigris ring + Marcellus initial when signed
 * in; hairline ring + neutral person glyph when signed out.
 *
 * It is the *only* mark in that corner. The consolidation handoff drew a config gear inboard of it;
 * that was dropped, because the gear opened `/settings` and so does this — a second control to the
 * same route buys nothing and costs header clearance on every screen.
 *
 * **It also carries the notification count, and a badged avatar opens the notification panel.** The
 * header bell it replaced was a second glyph crowding the same corner, so the count moved here — but
 * the door this opened was Config, where the row leading to notifications was titled *This panel*
 * and the word appeared only in a grey sub-line. A badge that counts something you then have to go
 * looking for is a badge on the wrong door: reported from the panel as "I can see the number and
 * there is no way to see the notifications". So while anything is waiting, this drops the panel down
 * over whatever is on screen; with nothing waiting it is the account control it always was and
 * opens Config.
 *
 * The behaviour follows the badge exactly — same `count`, one expression — which is what keeps the
 * two from disagreeing. It also means the screen that hides the badge (Config) keeps the plain
 * Config behaviour without needing to say so twice.
 *
 * Nothing navigates on the badged path any more: notifications are a sheet, so the screen underneath
 * stays where it was and comes back untouched.
 *
 * Rendered by ScreenShell, so it is absent exactly where the spec says: the Lock screen and the
 * Calendar event modal (both render with `nav={false}`), and it sits below any full-width banner.
 *
 * @category Shell
 */
export function AccountAvatar({ showBadge = true }: AccountAvatarProps) {
  const navigate = useNavigate()
  const { activeProfile } = useSession()
  const { wantsYouCount, openDrawer } = useNotifications()

  const count = showBadge ? wantsYouCount : 0
  // 1–9 as numerals; ten or more is `9+`. The circle never grows and never becomes a pill.
  const badge = count > 9 ? '9+' : String(count)

  const who = activeProfile ? `Account — ${activeProfile.name}` : 'Not signed in'
  const wants = count === 0 ? '' : ` · ${count} thing${count === 1 ? '' : 's'} want you`

  return (
    <button
      type="button"
      className={'ml-avatar' + (activeProfile ? ' ml-avatar--in' : '')}
      onClick={() => (count > 0 ? openDrawer() : navigate('/settings'))}
      // The count goes in the accessible name, since the badge itself is decorative. The profile
      // stays in it too: this is the identity control, and dropping who is signed in to make room
      // for a number would trade the label's whole job for its newest part. The verb changes with
      // the count because the destination does — a screen reader should not be told "account" and
      // land in the inbox.
      aria-label={count > 0 ? `Notifications${wants} — ${who}` : who}
    >
      {activeProfile ? (
        <span className="serif">{activeProfile.initial}</span>
      ) : (
        <Icon id="ico-person" size="1.375rem" />
      )}
      {/*
        Always mounted, faded by class. A 120ms fade in *and* out is what the spec asks for, and an
        element that unmounts can only animate on the way in — at zero the circle is fully
        transparent and empty, which is absent by every measure that matters here.
      */}
      <span
        className={
          'ml-avatar__badge'
          + (count > 0 ? ' ml-avatar__badge--on' : '')
          + (count > 9 ? ' ml-avatar__badge--capped' : '')
        }
        aria-hidden="true"
      >
        {count > 0 ? badge : ''}
      </span>
    </button>
  )
}
