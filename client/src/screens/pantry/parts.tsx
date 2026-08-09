import { useState, type ReactNode } from 'react'
import { LOCATION_FILTERS } from '../../app/pantryDomain'
import type { LocationFilter } from '../../app/pantryPrefs'

/**
 * Shared chrome for the Pantry. Same rule as the Meals section: everything here appears on three or
 * more screens, and anything used once lives with the screen that uses it.
 */

/** Section label in the Pantry idiom — brass, 0.32em, optional right-aligned meta. */
export function PantryLabel({
  label,
  meta,
  amber,
}: {
  label: string
  meta?: ReactNode
  /**
   * The one amber label in the section: `WORTH A LOOK` on 9b. Nothing else uses it, which is what
   * keeps amber meaning "look at this now" rather than becoming decoration.
   */
  amber?: boolean
}) {
  return (
    <div className={'pt-label' + (amber ? ' pt-label--amber' : '')}>
      <span className="pt-label__text">{label}</span>
      {meta !== undefined && <span className="pt-label__meta">{meta}</span>}
    </div>
  )
}

/**
 * The `ALL · CUPBOARD · FRIDGE · FREEZER` segment.
 *
 * Flex weights `1 / 1.3 / 1 / 1.1` come straight from §1.4 — the cells are sized to their words
 * rather than equally, so `CUPBOARD` isn't cramped while `ALL` floats in space.
 */
export function LocationSegment({
  value,
  onChange,
  counts,
}: {
  value: LocationFilter
  onChange: (next: LocationFilter) => void
  /** Optional per-location counts; absent on screens where the segment is only a filter. */
  counts?: Partial<Record<LocationFilter, number>>
}) {
  const weights: Record<LocationFilter, number> = { All: 1, Cupboard: 1.3, Fridge: 1, Freezer: 1.1 }
  return (
    <div className="pt-segment" role="tablist">
      {LOCATION_FILTERS.map((filter) => (
        <button
          type="button"
          role="tab"
          key={filter}
          aria-selected={value === filter}
          className={'pt-segment__cell' + (value === filter ? ' pt-segment__cell--on' : '')}
          style={{ flex: `${weights[filter]} 1 0` }}
          onClick={() => onChange(filter)}
        >
          {filter.toUpperCase()}
          {counts?.[filter] != null && <span className="pt-segment__count">{counts[filter]}</span>}
        </button>
      ))}
    </div>
  )
}

/**
 * A modal task surface: header grid (back · title · right meta), double rule, content, pinned
 * footer. No bottom nav — 9b, 9c, 9d and 9f are all steps in a flow (PANTRY_NAV.md §states).
 */
export function PantryModal({
  back,
  backLabel = 'BACK',
  title,
  meta,
  children,
  footer,
}: {
  /** Omitted on 9f, which has no way back — the deduction already happened. */
  back?: () => void
  backLabel?: string
  title: string
  meta?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <div className="ml-shell">
      <div className="ml-shell__body ml-shell__body--noavatar">
        <header className="pt-modal__header">
          {back
            ? <button type="button" className="pt-modal__back" onClick={back}>{backLabel}</button>
            : <span className="pt-modal__when">{backLabel}</span>}
          <span className="pt-modal__title">{title}</span>
          <span className="pt-modal__meta">{meta}</span>
        </header>
        <div className="ml-doublerule" aria-hidden="true">
          <div className="ml-doublerule__brass" />
          <div className="ml-doublerule__gap" />
          <div className="ml-doublerule__hair" />
        </div>
        <div className="ml-shell__content">{children}</div>
      </div>
      {footer}
    </div>
  )
}

/**
 * The 24px tick box used on 9e and 9f.
 *
 * On 9f these are **undo, not consent** — everything on that screen is already applied — so the
 * component takes no "confirm" wording and the screens say which meaning is in play.
 */
export function TickBox({
  checked,
  onToggle,
  label,
}: {
  checked: boolean
  onToggle: () => void
  label: string
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      className={'pt-tick' + (checked ? ' pt-tick--on' : '')}
      onClick={onToggle}
    >
      {checked && <span aria-hidden="true">✓</span>}
    </button>
  )
}

/** Primary action — brass fill, brass hairline. */
export function PrimaryButton({
  children,
  onClick,
  disabled,
  grow = 1,
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  grow?: number
}) {
  return (
    <button
      type="button"
      className="pt-btn pt-btn--primary"
      style={{ flex: `${grow} 1 0` }}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/** Secondary action — plain hairline, no fill. */
export function SecondaryButton({
  children,
  onClick,
  disabled,
  grow = 1,
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  grow?: number
}) {
  return (
    <button
      type="button"
      className="pt-btn pt-btn--secondary"
      style={{ flex: `${grow} 1 0` }}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/** Chevron for a row that drills in. Absent on rows that don't — the absence is the affordance. */
export function Chevron() {
  return <span className="pt-chev" aria-hidden="true">›</span>
}

/**
 * An amount you can step **or type**.
 *
 * The steppers alone were a real dead end: a 500 g bag of walnuts is a perfectly ordinary pantry
 * line, and reaching it at +1 a tap is not a slow path, it is no path. Anything measured rather than
 * counted — grams, millilitres, ounces — lands on numbers no thumb is going to arrive at.
 *
 * `type="number"` on purpose, and not `data-no-osk`: the wall panel's on-screen keyboard opens
 * straight onto its digit layout for a number input, and a phone shows its native numeric pad. One
 * control, right on both, with no device sniffing.
 */
export function AmountField({
  value,
  onChange,
  step = 1,
  label = 'Amount',
}: {
  value: number
  onChange: (next: number) => void
  step?: number
  label?: string
}) {
  /**
   * What is in the box while it is being typed in.
   *
   * Kept apart from `value` because the intermediate states of typing a number are not numbers:
   * clearing the field gives "", and reaching 0.5 goes through "0." — both of which a
   * parse-on-every-keystroke control would rewrite under the cursor, making the field impossible to
   * type into. Null means "not being edited", and the formatted value is shown instead.
   */
  const [draft, setDraft] = useState<string | null>(null)

  const commit = (raw: string) => {
    setDraft(raw)
    const parsed = Number(raw)
    if (raw.trim() !== '' && Number.isFinite(parsed) && parsed >= 0) onChange(parsed)
  }

  const nudge = (delta: number) => {
    setDraft(null)
    onChange(Math.max(0, Math.round((value + delta) * 1000) / 1000))
  }

  return (
    <div className="pt-stepper">
      <button type="button" aria-label={`${label} down`} onClick={() => nudge(-step)}>−</button>
      <input
        className="pt-stepper__value serif"
        type="number"
        min={0}
        step={step}
        aria-label={label}
        value={draft ?? String(value)}
        onChange={(e) => commit(e.target.value)}
        // Snap back to the committed value, so a half-typed "0." or an emptied box does not linger.
        onBlur={() => setDraft(null)}
        onFocus={(e) => e.currentTarget.select()}
      />
      <button type="button" aria-label={`${label} up`} onClick={() => nudge(step)}>＋</button>
    </div>
  )
}
