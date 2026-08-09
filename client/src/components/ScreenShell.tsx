import type { ReactNode } from 'react'
import { BottomNav } from './BottomNav'
import { DoubleRule } from './DoubleRule'
import { AccountAvatar } from './AccountAvatar'

interface ScreenShellProps {
  /** The screen header (DashboardHeader or DrillInHeader). */
  header: ReactNode
  children: ReactNode
  /** Full-bleed banner rendered ABOVE the header (e.g. a severe-weather alert), per spec 05. */
  banner?: ReactNode
  /** Show the double-rule motif under the header (default true). */
  rule?: boolean
  /** Show the bottom nav (default true; the Lock screen hides it). */
  nav?: boolean
  /** Dashboard is the idle display and must never scroll its content. */
  fixedContent?: boolean
  /**
   * Show the global account avatar (default true where the nav is shown). The Config *index* sets
   * this false — its identity row is the account surface, so the avatar would be redundant there
   * (CONFIG_SCREEN.md §1).
   */
  avatar?: boolean
  /**
   * Let the avatar carry the wants-you badge (default true).
   *
   * False on the inbox and on Config: on the first you are reading the very list it counts, and on
   * the second the Notifications row states the count in words one tap away.
   */
  avatarBadge?: boolean
}

/**
 * Full-height screen scaffold: [banner] → header → double-rule → content → bottom nav. Portrait,
 * 4K-scaled. Every screen composes this so chrome and structure stay consistent.
 *
 * @category Shell
 */
export function ScreenShell({
  header,
  children,
  banner,
  rule = true,
  nav = true,
  fixedContent = false,
  avatar = true,
  avatarBadge = true,
}: ScreenShellProps) {
  const showAvatar = nav && avatar
  return (
    <div className="ml-shell">
      {banner}
      {/* Body is the avatar's positioning context, so the avatar always sits BELOW a full-width
          banner (severe alert / mic live) rather than on top of it — spec 13. */}
      <div className={'ml-shell__body' + (showAvatar ? '' : ' ml-shell__body--noavatar')}>
        {showAvatar && <AccountAvatar showBadge={avatarBadge} />}
        {header}
        {rule && <DoubleRule />}
        <div className={'ml-shell__content' + (fixedContent ? ' ml-shell__content--fixed' : '')}>
          {children}
        </div>
      </div>
      {nav && <BottomNav />}
    </div>
  )
}
