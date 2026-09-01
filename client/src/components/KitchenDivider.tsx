interface KitchenDividerProps {
  /**
   * The group's name, in **sentence case** — `Worth using soon`, not `WORTH USING SOON`.
   *
   * Not enforced here, because the one thing a runtime `toLowerCase` would break is the case that
   * matters: a shelf or an aisle is named by the household (`Cupboard`, `Fresh · worth a date`) and
   * its capitals are theirs, not a style choice this component gets to overrule.
   */
  label: string
  /**
   * How many rows are under it. Omitted renders nothing — a divider over a group whose size is not
   * a useful fact (`What this changes`) should not be made to state a number to fill the column.
   */
  count?: number | string
  /**
   * Amber, for **time pressure only** — `Worth using soon`, `These need you`, `Can't say yet`.
   *
   * The old band had a third `--quiet` register for a heading that was a fact rather than a call to
   * action. The divider has no equivalent and does not need one: a plain divider is already quiet,
   * and it was the *fill* that made an ordinary band look loud enough to need toning down.
   */
  amber?: boolean
  /**
   * The 18px gap above (§1). Set it on every divider except the first in a scroll region.
   *
   * A prop rather than `:first-child`, because the first divider on a panel is rarely the first
   * element — a search row, a mirror strip or a lede usually sits above it, and the CSS selector
   * would then put the gap back exactly where it is meant to be absent.
   */
  gap?: boolean
}

/**
 * A group heading: name, rule, count (design_handoff_kitchen_lists §1).
 *
 * **This replaced the full-bleed band** used throughout the Kitchen — a tinted strip with a 3px
 * brass stub that ran edge to edge, breaking the gutter, with the rows beneath it shaded by an
 * inset shadow. All of that is gone: the divider keeps the gutter, separates two lists with a
 * hairline rather than a fill, and names the group in the serif at a size that can be read at
 * arm's length.
 *
 * Rendered as a plain `div` rather than a heading element: these sit inside lists whose rows are
 * already buttons, and the panels put four or five of them on a page with no nesting between them,
 * so a run of `h2`s would describe a document structure the screen does not have.
 *
 * @category Structure
 */
export function KitchenDivider({ label, count, amber = false, gap = true }: KitchenDividerProps) {
  return (
    <div
      className={
        'ml-kdiv'
        + (amber ? ' ml-kdiv--amber' : '')
        + (gap ? ' ml-kdiv--gap' : '')
      }
    >
      <span className="ml-kdiv__label">{label}</span>
      {/* Decorative: the label and the count carry the meaning, and a screen reader announcing a
          rule between them would be reading the furniture. */}
      <span className="ml-kdiv__rule" aria-hidden="true" />
      {count != null && <span className="ml-kdiv__count">{count}</span>}
    </div>
  )
}
