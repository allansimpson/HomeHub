import { AccountAvatar } from 'client'

/**
 * The 48px circle pinned top-right of every standard screen. With no session loaded in a preview
 * it shows the signed-out treatment: hairline ring and the neutral person glyph.
 */
export const Default = () => <AccountAvatar />

/**
 * `showBadge={false}` — set on the inbox and on Config, where a count would be a dead affordance.
 * Identical to Default until there are unread wants-you items to badge.
 */
export const WithoutBadge = () => <AccountAvatar showBadge={false} />

/** In the corner it actually occupies, against a header. */
export const InPlace = () => (
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
    <span className="serif" style={{ fontSize: '1.75rem' }}>Climate</span>
    <AccountAvatar />
  </div>
)
