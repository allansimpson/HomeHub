import type { ReactNode } from 'react'
import { cutHeight } from '../app/kitchenDomain'

interface CutGroupProps {
  /**
   * How many rows are fully visible. The next one is deliberately cut in half.
   *
   * Four on a location shelf, two on `WORTH USING SOON` — see `PANTRY_SHELVES` §1, which fixes both
   * because four groups at those heights fill P1's content area exactly.
   */
  rows: number
  /**
   * One row's height in canvas pixels.
   *
   * **No default, on purpose.** Row heights run 40–69px depending on what a row carries, and a
   * shared default is exactly how one panel's height ends up cutting another panel's rows in the
   * wrong place — which reads as a clipping bug rather than as an affordance.
   */
  rowHeight: number
  children: ReactNode
  className?: string
}

/**
 * A fixed-height scroller whose last row is visibly bisected — the section's only scroll affordance.
 *
 * Locked in `PANTRY_SHELVES` §1 and inherited by every panel after it: the native scrollbar is
 * hidden and there is no track, so the half-row showing at the cut is the entire signal that the
 * group continues. The arithmetic is `N × rowH + rowH/2`, which lands the boundary **inside** a
 * row's text box. A height landing on a row boundary clips only padding, and the group then reads
 * as a complete list with nothing below it — which is the failure this component exists to prevent.
 *
 * The canvas is 540px wide and 1rem is 16 of those pixels, so the height converts rather than being
 * written in px: the panel is really driving a 4K portrait screen.
 *
 * @category Layout
 */
export function CutGroup({ rows, rowHeight, children, className }: CutGroupProps) {
  // The arithmetic lives in `kitchenDomain` so it can be tested against the sentence that
  // justifies it; 1rem is 16 canvas pixels, and the panel is really driving a 4K portrait screen.
  const height = cutHeight(rows, rowHeight) / 16

  /*
   * A ceiling, not a height.
   *
   * The bisected half-row is a *scroll affordance* — it says "there is more below". A group holding
   * fewer rows than it is sized for has nothing below, so a fixed height there is not an affordance
   * at all: it is a band of empty shade under the last row, which reads as a rendering fault. With
   * `max-height` a short group shrinks to its content and a long one still cuts its last row in
   * half, which is the behaviour the rule was always describing.
   */
  return (
    <div
      className={'ml-cut' + (className ? ` ${className}` : '')}
      style={{ maxHeight: `${height}rem` }}
    >
      {children}
    </div>
  )
}
