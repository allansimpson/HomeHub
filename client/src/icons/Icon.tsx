import type { CSSProperties } from 'react'

export type IconId =
  // Section glyphs (Icons v2). Seven of these are the bar; `ico-assist` sits off it, on the
  // Dashboard block and the Attendant overlay's header.
  | 'ico-home'
  | 'ico-calendar'
  | 'ico-meals'
  | 'ico-care'
  | 'ico-climate'
  | 'ico-weather'
  | 'ico-todo'
  | 'ico-assist'
  // Care log tiles (see IconSprite — drawn to the section set's geometry, not part of Icons v2).
  | 'ico-bottle'
  | 'ico-diaper'
  | 'ico-nursing'
  | 'ico-refresh'
  | 'ico-person'
  | 'ico-gear'
  | 'ico-lock'
  | 'ico-warning'
  | 'ico-display'
  | 'ico-group'
  | 'ico-list'
  | 'ico-trash'
  | 'ico-archive'
  | 'ico-pin'
  | 'ico-search'
  | 'ico-signin'
  | 'ico-signout'
  // The composer's attach menu — a picture, a camera, a sheet of paper.
  | 'ico-image'
  | 'ico-camera'
  | 'ico-file'
  | 'ico-back'
  | 'ico-add'
  | 'ico-minus'
  | 'ico-check'
  /** Take a turn's words somewhere else — the transcript's copy control (`CopyTurn`). */
  | 'ico-copy'
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
 *
 * **The `viewBox` is not redundant.** Every symbol in the sprite carries its own `0 0 24 24`, and by
 * the spec that is enough: a `<use>` of a `<symbol>` renders as an `<svg>` sized to the host's
 * viewport, so the artwork should scale to whatever `size` says. WebKit does not reliably do that
 * when the host `<svg>` has no `viewBox` of its own — it draws the symbol at its intrinsic 24×24
 * anchored at the origin and clips it to the box, which shifts every glyph down and right by
 * `(24 − size) / 2` and crops the far edges.
 *
 * A glyph that fills its 24 units survives that looking merely a little large. A glyph that is small
 * and centred in an empty square does not: the composer's attach mark sat visibly off-centre inside
 * the border drawn exactly around its true middle, which is the sort of thing you can stare at for a
 * long time while checking the CSS that centres it — and the CSS was right the whole time.
 */
export function Icon({ id, size = '1.5rem', className, style }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      style={{ width: size, height: size, color: 'inherit', ...style }}
      aria-hidden="true"
      focusable="false"
    >
      <use href={`#${id}`} />
    </svg>
  )
}
