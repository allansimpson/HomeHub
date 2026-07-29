interface BackButtonProps {
  onClick: () => void
  label?: string
}

/**
 * Back affordance, top-left of every drill-in screen: a 44×44 box with a 1px dim-brass border and
 * a brass ◂ glyph (shared chrome / ACCOUNT_TODO_LISTS.md §2).
 */
export function BackButton({ onClick, label = 'Back' }: BackButtonProps) {
  return (
    <button className="ml-backbtn" onClick={onClick} aria-label={label} type="button">
      <span aria-hidden="true">◂</span>
    </button>
  )
}
