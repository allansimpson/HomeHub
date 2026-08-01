import type { CSSProperties } from 'react'

export type IconId =
  | 'ico-home'
  | 'ico-calendar'
  | 'ico-climate'
  | 'ico-weather'
  | 'ico-assist'
  | 'ico-todo'
  | 'ico-baby'
  | 'ico-litter'
  | 'ico-meals'
  | 'ico-pantry'
  | 'ico-refresh'
  | 'ico-bell'
  | 'ico-person'
  | 'ico-gear'
  | 'ico-lock'
  | 'ico-warning'
  | 'ico-display'
  | 'ico-group'
  | 'ico-list'
  | 'ico-trash'
  | 'ico-search'
  | 'ico-signin'
  | 'ico-signout'
  | 'ico-back'
  | 'ico-add'
  | 'ico-minus'
  | 'ico-check'
  | 'ico-delete'
  | 'ico-alert'
  | 'ico-chevron-right'
  | 'ico-chevron-down'
  | 'ico-stop'
  // Calendar marks (spec 14). Drawn without a stroke-width so the caller can set it in CSS —
  // 1.7 at the 13px month-grid size, 1.4 everywhere else.
  | 'ico-mark-school'
  | 'ico-mark-medical'
  | 'ico-mark-work'
  | 'ico-mark-hours'
  | 'ico-mark-house'
  | 'ico-mark-swim'
  | 'ico-mark-sport'
  | 'ico-mark-music'
  | 'ico-mark-dining'
  | 'ico-mark-book'
  | 'ico-mark-errand'
  | 'ico-mark-travel'
  | 'ico-mark-pet'
  | 'ico-mark-outdoors'
  | 'ico-mark-deadline'
  | 'ico-mark-post'
  | 'ico-mark-gift'
  | 'ico-mark-star'
  | 'ico-mark-cake'

interface IconProps {
  id: IconId
  /** Edge length; defaults to 1.5rem (24 mock px). Accepts any CSS length. */
  size?: string
  className?: string
  style?: CSSProperties
}

/**
 * Renders a symbol from the inline sprite (see IconSprite). Colour follows `currentColor`,
 * so set `color` on the parent to tint. Icons are decorative here (labels carry meaning).
 */
export function Icon({ id, size = '1.5rem', className, style }: IconProps) {
  return (
    <svg
      className={className}
      style={{ width: size, height: size, color: 'inherit', ...style }}
      aria-hidden="true"
      focusable="false"
    >
      <use href={`#${id}`} />
    </svg>
  )
}
