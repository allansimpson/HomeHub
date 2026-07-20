interface ChipProps {
  label: string
  active?: boolean
  /** Live/OK variant (verdigris border + text when active). */
  live?: boolean
  onClick?: () => void
}

/** Bordered rectangular chip / tab. Used for filters, room/mode selectors, WHO multi-select. */
export function Chip({ label, active, live, onClick }: ChipProps) {
  const className =
    'ml-chip' + (active ? ' ml-chip--active' : '') + (live ? ' ml-chip--live' : '')
  return (
    <button className={className} onClick={onClick} type="button" aria-pressed={active}>
      {label}
    </button>
  )
}
