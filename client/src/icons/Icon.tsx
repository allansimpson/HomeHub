import type { CSSProperties } from 'react'

export type IconId =
  | 'ico-home'
  | 'ico-calendar'
  | 'ico-climate'
  | 'ico-weather'
  | 'ico-assist'
  | 'ico-back'
  | 'ico-add'
  | 'ico-minus'
  | 'ico-check'
  | 'ico-delete'
  | 'ico-alert'
  | 'ico-chevron-right'
  | 'ico-chevron-down'
  | 'ico-stop'

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
