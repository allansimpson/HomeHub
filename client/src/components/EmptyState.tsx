interface EmptyStateProps {
  label: string
  hint?: string
}

/** Placeholder for a section with no data yet — styled, never a blank or error screen. */
export function EmptyState({ label, hint }: EmptyStateProps) {
  return (
    <div className="ml-empty">
      <div className="ml-empty__label">{label}</div>
      {hint && <div className="ml-empty__hint">{hint}</div>}
    </div>
  )
}
