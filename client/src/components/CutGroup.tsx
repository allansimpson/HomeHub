import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cutHeight } from '../app/kitchenDomain'
import { useCutFit } from './cutFit'

interface CutGroupProps {
  /**
   * How many rows are fully visible. The next one is deliberately cut in half.
   *
   * Four on a location shelf, two on `WORTH USING SOON` — see `PANTRY_SHELVES` §1, which fixes both
   * because four groups at those heights fill P1's content area exactly.
   *
   * **A floor rather than a fixed figure.** The number is the reference design's, chosen against a
   * 540 × 1169 canvas; on a screen with more room than that the group grows past it a whole row at
   * a time ({@link CutFitProvider}). It is never reduced, so the drawn panel is always at least
   * what the design asked for.
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
  const el = useRef<HTMLDivElement>(null)
  const fit = useCutFit()

  /*
   * The row count the viewport turned out to have room for.
   *
   * Starts at the drawn figure and is only ever raised — `Math.max` below is what guarantees that,
   * so a fit arriving late, or not at all outside a `ScrollArea`, leaves the panel exactly as the
   * reference draws it.
   */
  const [fitted, setFitted] = useState(rows)
  const shown = Math.max(rows, fitted)

  useEffect(() => {
    const node = el.current
    if (!fit || !node) return
    return fit.join({ el: node, rowHeight, baseRows: rows, apply: setFitted })
  }, [fit, rowHeight, rows])

  // Rows arriving is the commonest reason a group's content changes height, and it moves nothing
  // the ResizeObserver on the scroller can see — the group is capped, so its own box holds still.
  useEffect(() => { fit?.schedule() }, [fit, children])

  // The arithmetic lives in `kitchenDomain` so it can be tested against the sentence that
  // justifies it; 1rem is 16 canvas pixels, and the panel is really driving a 4K portrait screen.
  const height = cutHeight(shown, rowHeight) / 16

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
      ref={el}
      className={'ml-cut' + (className ? ` ${className}` : '')}
      style={{ maxHeight: `${height}rem` }}
    >
      {children}
    </div>
  )
}
