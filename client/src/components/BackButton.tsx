import { Icon } from '../icons/Icon'

interface BackButtonProps {
  onClick: () => void
  label?: string
}

/**
 * Back affordance, top-left of every drill-in screen: a 44×44 box with a 1px dim-brass border and
 * a brass arrow (shared chrome / ACCOUNT_TODO_LISTS.md §2).
 *
 * **The sprite's `ico-back`, not the `◂` character.** It used to be the text glyph, which is a filled
 * triangle — solid where every other mark on the panel is a 1.5-weight stroke, and typographically
 * small: `◂` occupies a fraction of its em, so at any size that suited the surrounding text it read
 * as a speck in the middle of a 44px box. The sprite's arrow is the same line vocabulary as the rest
 * of the chrome and fills the size it is given, so the box can be sized by the mark rather than by
 * whatever the font decided.
 *
 * @category Shell
 */
export function BackButton({ onClick, label = 'Back' }: BackButtonProps) {
  return (
    <button className="ml-backbtn" onClick={onClick} aria-label={label} type="button">
      {/* Half the box. The old glyph drew about 8px inside 44 and disappeared; a mark filling much
          more than this stops being chrome and starts competing with the title beside it. */}
      <Icon id="ico-back" size="1.375rem" />
    </button>
  )
}
