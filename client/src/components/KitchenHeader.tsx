import type { ReactNode } from 'react'

interface KitchenHeaderProps {
  /** The panel's name — `PANTRY`, `THE LIST`, `THE WEEK`. Rendered as the 40px page title. */
  title: string
  /**
   * The live count that belongs to the title — `41 THINGS`, `14 OPEN`, `4 PLANNED`.
   *
   * **Beside the title, not opposite it.** It is a fact about the thing the title names, so it
   * reads as part of the same phrase; sending it to the far right turns it into a second, unrelated
   * heading and leaves a gap the eye has to cross to answer "how many".
   */
  meta?: ReactNode
}

/**
 * The header every Kitchen destination wears (`PANTRY_SHELVES` §1, `PLAN_WEEK` §1).
 *
 * Distinct from {@link DrillInHeader}, and the difference is what the screen *is*. A destination is
 * somewhere you went on purpose from the quick row: it has no back arrow, it carries a 40px title
 * rather than a 32px one, and its count sits beside that title. A drill-in is somewhere you fell
 * into from a row, and needs the arrow and a quieter title.
 *
 * The account badge and the double rule come from {@link ScreenShell} — every destination shows
 * standard chrome, so neither belongs here.
 *
 * @category Shell
 */
export function KitchenHeader({ title, meta }: KitchenHeaderProps) {
  return (
    <header className="ml-header ml-kitchen-header">
      <h1 className="ml-kitchen-header__title serif">{title}</h1>
      {meta !== undefined && <span className="ml-kitchen-header__meta">{meta}</span>}
    </header>
  )
}
