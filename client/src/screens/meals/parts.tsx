import type { ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { BottomNav } from '../../components'
import { Icon } from '../../icons/Icon'
import { agoLabel } from '../../app/mealsDomain'
import type { RecipeDto } from '../../api/types'

/**
 * Shared chrome for the Meals section. Everything here appears on three or more screens; anything
 * used once lives with the screen that uses it.
 */

/** The three faces of the section, in bar order. */
export type MealsSegmentId = 'week' | 'recipes' | 'pantry'

const SEGMENTS: { id: MealsSegmentId; label: string; path: string; weight: number }[] = [
  { id: 'week', label: 'WEEK', path: '/meals', weight: 1 },
  { id: 'recipes', label: 'RECIPES', path: '/meals/recipes', weight: 1.2 },
  { id: 'pantry', label: 'PANTRY', path: '/meals/pantry', weight: 1 },
]

/**
 * `WEEK · RECIPES · PANTRY` — the section's top-level control, on all three of its roots.
 *
 * Pantry is a segment rather than a tab because the two are already coupled: cooking a meal deducts
 * from the pantry and adds what ran out to the grocery list, and that coupling lives in
 * `DeductionScreen` and `StockCheckScreen` today. What the pantry is out of is what the list is for.
 *
 * Built on `.pt-segment` rather than a third segmented-control implementation — MEALS_PANTRY.md is
 * explicit that this is the same pattern as the Cook View tabs and Pantry's own
 * ALL/CUPBOARD/FRIDGE/FREEZER row, and the Pantry one was already the closer match.
 */
export function MealsSegment({ active }: { active: MealsSegmentId }) {
  const navigate = useNavigate()
  return (
    <div className="pt-segment" role="tablist">
      {SEGMENTS.map((s) => (
        <button
          type="button"
          role="tab"
          key={s.id}
          aria-selected={active === s.id}
          className={'pt-segment__cell' + (active === s.id ? ' pt-segment__cell--on' : '')}
          style={{ flex: `${s.weight} 1 0` }}
          onClick={() => { if (active !== s.id) navigate(s.path) }}
        >
          {s.label}
        </button>
      ))}
    </div>
  )
}

/**
 * A modal surface: header grid (CANCEL · title · optional confirm), double rule, then content.
 *
 * No bottom nav and no account avatar — a modal is a question, and leaving the tab bar live under
 * one invites answering it by navigating away (MEALS_NAV.md). `CANCEL` on the left rather than a
 * dismiss ✕ so the way out is a word, not a glyph, on a panel used with wet hands.
 */
export function MealsModal({
  title,
  onCancel,
  cancelLabel = 'CANCEL',
  confirm,
  children,
  footer,
  nav = false,
}: {
  title: string
  onCancel: () => void
  cancelLabel?: string
  /** Right-hand control — SAVE on the amounts form, empty elsewhere. */
  confirm?: ReactNode
  children: ReactNode
  /** Pinned action bar below the scrolling content. */
  footer?: ReactNode
  /**
   * Keep the bottom nav. Off for modals that are a step in a flow, on for the morning-after confirm
   * — that one is a soft ask, and walking away from it has to stay as easy as answering it.
   */
  nav?: boolean
}) {
  return (
    <div className="ml-shell">
      <div className="ml-shell__body ml-shell__body--noavatar">
        <header className="ml-mealmodal__header">
          <button type="button" className="ml-mealmodal__cancel" onClick={onCancel}>{cancelLabel}</button>
          <span className="ml-mealmodal__title serif">{title}</span>
          <span className="ml-mealmodal__confirm">{confirm}</span>
        </header>
        <div className="ml-doublerule" aria-hidden="true">
          <div className="ml-doublerule__brass" />
          <div className="ml-doublerule__gap" />
          <div className="ml-doublerule__hair" />
        </div>
        <div className="ml-shell__content">{children}</div>
      </div>
      {footer}
      {nav && <BottomNav />}
    </div>
  )
}

/**
 * The section's micro rule line: 9–10px, heavily tracked, `--text-disabled`. Used to state a rule
 * the screen obeys ("SAVED AS YOU TAP", "NIGHTS STILL PLAN WITHOUT RECIPES") rather than to label a
 * control. Never a status — it does not change.
 */
export function RuleLine({ children }: { children: ReactNode }) {
  return <p className="ml-mealrule">{children}</p>
}

/** Section label in the Meals idiom: no tick, brass, 0.32em. */
export function MealsLabel({ label, status }: { label: string; status?: ReactNode }) {
  return (
    <div className="ml-meallabel">
      <span className="ml-meallabel__text">{label}</span>
      {status !== undefined && <span className="ml-meallabel__status">{status}</span>}
    </div>
  )
}

/**
 * "Ellen changed the amounts" — shown on a recipe someone else edited, until the reader has seen it.
 *
 * **Brass, not amber.** A shared recipe improving is the system working, not something demanding
 * action in the next few minutes; amber here would train people to ignore amber (MEALS_SCREEN §7a.3).
 * Never rendered for the reader's own edit — the caller compares `modifiedByProfileId` against the
 * active profile before mounting this.
 */
export function AttributionStrip({
  recipe,
  changedLines,
  onSeeWhat,
}: {
  recipe: RecipeDto
  /** How many ingredient lines the edit touched, when known. */
  changedLines?: number
  onSeeWhat: () => void
}) {
  const who = recipe.modifiedByName ?? 'Someone'
  const initial = who.trim().charAt(0).toUpperCase()
  return (
    <div className="ml-attrib">
      <span className="ml-attrib__avatar serif" aria-hidden="true">{initial}</span>
      <span className="ml-attrib__main">
        <span className="ml-attrib__what">{`${who} changed the amounts`}</span>
        <span className="ml-attrib__meta">
          {recipe.modifiedAtUtc ? agoLabel(recipe.modifiedAtUtc) : 'RECENTLY'}
          {changedLines ? ` · ${changedLines} LINE${changedLines === 1 ? '' : 'S'}` : ''}
        </span>
      </span>
      <button type="button" className="ml-attrib__action" onClick={onSeeWhat}>SEE WHAT</button>
    </div>
  )
}

/**
 * Amber hairline strip for something actionable within minutes. Amber is reserved for exactly that
 * (MEALS_BEHAVIOURS §8) — a late dinner is information, not an alert, and does not use this.
 */
export function MealAlert({
  title,
  sentence,
  action,
}: {
  title?: string
  sentence: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="ml-mealalert">
      <span className="ml-mealalert__glyph" aria-hidden="true"><Icon id="ico-warning" size="1.25rem" /></span>
      <span className="ml-mealalert__main">
        {title && <span className="ml-mealalert__title">{title}</span>}
        <span className="ml-mealalert__text">{sentence}</span>
      </span>
      {action}
    </div>
  )
}

/**
 * The folder's right-hand history column: how long since it was cooked, and how the value was
 * reached.
 *
 * `TONIGHT` is the only verdigris in the whole section — a genuinely live status, and the section's
 * single licence to use the colour (MEALS_SCREEN §13). Everything else here is plain text.
 */
export function HistoryColumn({
  value,
  caption,
  live,
}: {
  value: string
  caption: string
  live?: boolean
}) {
  return (
    <span className={'ml-histcol' + (live ? ' ml-histcol--live' : '')}>
      <span className="ml-histcol__value serif">{value}</span>
      <span className="ml-histcol__caption">{caption}</span>
    </span>
  )
}

/** Chevron for a row that drills in. Absent on rows that don't — the absence is the affordance. */
export function Chevron() {
  return <span className="ml-mealchev" aria-hidden="true">›</span>
}

/**
 * Numeric keypad for the amounts form (MEALS_SCREEN §8a.7). Same shell as `OnScreenKeyboard`, three
 * rows, no letters — and fractions as keys, because kitchen amounts are written `1/2` far more often
 * than `0.5` and making someone spell that with a decimal point is how a form stops being used.
 *
 * The fields it serves carry `data-no-osk`, so the global letter keyboard leaves them alone.
 */
export function AmountKeypad({
  onKey,
  onBackspace,
  onDone,
}: {
  onKey: (char: string) => void
  onBackspace: () => void
  onDone: () => void
}) {
  const rows: string[][] = [
    ['1', '2', '3', '4', '5'],
    ['6', '7', '8', '9', '0'],
    ['1/2', '1/3', '1/4', '.', '⌫'],
  ]
  return (
    <div className="ml-kb ml-amountpad" data-osk onPointerDown={(e) => e.preventDefault()}>
      <div className="ml-amountpad__bar">
        <span className="ml-amountpad__hint">AMOUNTS ONLY</span>
        <button type="button" className="ml-amountpad__done" onClick={onDone}>DONE</button>
      </div>
      <div className="ml-kb__panel">
        {rows.map((row, i) => (
          <div className="ml-kb__row" key={i}>
            {row.map((key) => (
              <button
                type="button"
                key={key}
                className={'ml-kb__key ml-amountpad__key' + (key === '⌫' ? ' ml-kb__key--brass' : '')}
                onClick={() => (key === '⌫' ? onBackspace() : onKey(key))}
              >
                {key}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
