interface ToggleProps {
  on: boolean
  onChange: (next: boolean) => void
  label?: string
  /**
   * ON styling. 'brass' (default) for real data; 'live' (verdigris) marks app-level "smart"
   * switches — e.g. the Today/All views on the Lists screen.
   */
  variant?: 'brass' | 'live'
}

/**
 * Square-thumb switch. On: brass border + brass-bright thumb right. Off: inactive, left.
 *
 * @category Controls
 */
export function Toggle({ on, onChange, label, variant = 'brass' }: ToggleProps) {
  return (
    <button
      className={'ml-toggle' + (on ? ' ml-toggle--on' : '') + (variant === 'live' ? ' ml-toggle--live' : '')}
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
      aria-label={label}
      type="button"
    >
      <span className="ml-toggle__thumb" />
    </button>
  )
}
