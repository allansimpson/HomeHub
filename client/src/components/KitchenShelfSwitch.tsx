/** One entry in the run: what it is called, how many rows are on it, and whether it is a state. */
export interface ShelfSwitchEntry<K extends string> {
  key: K
  /** Shown in caps at 13px/0.2em. */
  label: string
  count: number
  /**
   * Amber while inactive.
   *
   * True for `SOON` only. It is a *state*, not a place — the same jar is on a shelf and also
   * turning — so it keeps the temperature it had when it was an amber band, which is what stops it
   * reading as a fourth cupboard.
   */
  amber?: boolean
}

interface KitchenShelfSwitchProps<K extends string> {
  entries: ShelfSwitchEntry<K>[]
  active: K
  onSelect: (key: K) => void
  /** Names the run for a screen reader — the entries alone do not say what is being switched. */
  label: string
}

/**
 * The run of shelves above the Pantry list (design_handoff_kitchen_lists §3).
 *
 * **This replaced four stacked shelf sections.** The pantry used to draw Soon / Fridge / Cupboard /
 * Freezer one under another, each capped at four rows with the fifth bisected, which meant the
 * screen showed sixteen of forty-one things and no shelf could ever be read to its end. One shelf
 * at a time, full length, is the trade the handoff makes: you lose the glance across all four and
 * gain the ability to actually finish reading one.
 *
 * **There is no `All`.** It would be the stacked view again under a different name, and it is the
 * view this replaced.
 *
 * The order is fixed — `SOON · FRIDGE · CUPBOARD · FREEZER` — and four entries fit one line at the
 * 540px canvas, so the run itself never scrolls sideways. A fifth shelf would break that, which is
 * why the order is a constant in `kitchenDomain` rather than something a caller passes.
 *
 * @category Structure
 */
export function KitchenShelfSwitch<K extends string>({
  entries, active, onSelect, label,
}: KitchenShelfSwitchProps<K>) {
  return (
    <>
      <div className="ml-shelfswitch" role="tablist" aria-label={label}>
        {entries.map((entry) => {
          const isActive = entry.key === active
          return (
            <button
              key={entry.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={
                'ml-shelfswitch__entry'
                + (isActive ? ' ml-shelfswitch__entry--on' : '')
                + (entry.amber && !isActive ? ' ml-shelfswitch__entry--soon' : '')
              }
              onClick={() => onSelect(entry.key)}
            >
              {entry.label}
              {/* Inside the label, not beside it: the count belongs to the word the way `41 THINGS`
                  belongs to `PANTRY`, and spacing it out as a sibling turned a four-entry run into
                  eight things to read. */}
              <span className="ml-shelfswitch__count">{entry.count}</span>
            </button>
          )
        })}
      </div>
      {/* The rule under the run, inset to the gutter. It is what the active entry's brass underline
          sits proud of — without it the underline is a mark floating under a word. */}
      <div className="ml-shelfswitch__rule" aria-hidden="true" />
    </>
  )
}
