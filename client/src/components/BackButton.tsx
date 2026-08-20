import { Icon } from '../icons/Icon'

interface BackButtonProps {
  onClick: () => void
  label?: string
  /**
   * Name the screen behind this one, beside the arrow.
   *
   * Passed only where the parent is somewhere you may not have come from — the Notifications inbox
   * is the case that earned it: the account avatar opens it directly while anything is waiting, so
   * the household arrives from the dashboard and the bare arrow is the only route on to Config
   * without saying so. Left off everywhere else, where you drilled in from the very screen the
   * arrow returns to and a label would only restate it.
   */
  text?: string
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
export function BackButton({ onClick, label, text }: BackButtonProps) {
  return (
    <button
      className={'ml-backbtn' + (text ? ' ml-backbtn--labelled' : '')}
      onClick={onClick}
      // The visible word is the better accessible name when there is one — "back to Config" says
      // where, which is the whole reason the label was added.
      aria-label={label ?? (text ? `Back to ${text}` : 'Back')}
      type="button"
    >
      {/* Half the box. The old glyph drew about 8px inside 44 and disappeared; a mark filling much
          more than this stops being chrome and starts competing with the title beside it. */}
      <Icon id="ico-back" size="1.375rem" />
      {text && <span className="ml-backbtn__text">{text}</span>}
    </button>
  )
}
