interface ToggleProps {
  on: boolean
  onChange: (next: boolean) => void
  label?: string
}

/** Square-thumb switch. On: brass border + brass-bright thumb right. Off: inactive, left. */
export function Toggle({ on, onChange, label }: ToggleProps) {
  return (
    <button
      className={'ml-toggle' + (on ? ' ml-toggle--on' : '')}
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
