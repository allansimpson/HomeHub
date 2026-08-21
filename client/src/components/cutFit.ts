import { createContext, useContext } from 'react'

/**
 * Fitting the bisected cut to the screen it is actually on.
 *
 * `CutGroup` sizes itself `N × rowH + rowH/2`, where N is the figure the reference design chose
 * against a 540 × 1169 canvas. On the canvas that is exactly right: four groups at those heights
 * fill the pantry's content area and each one cuts its last row in half. On a phone it is a budget
 * written for a screen nobody is holding — `design_handoff_kitchen_shell` §F3 measured a quarter to
 * two thirds of six panels sitting empty while rows were still queued behind those heights.
 *
 * The handoff offers three ways out and prefers the second: **groups keep proportional heights of
 * the real viewport**, so the cut survives, more rows show per group, and the arithmetic recomputes
 * against the height there actually is. That is what this does. The design's N becomes a floor
 * rather than a fixed figure, and the room left over at the foot of the scroller is handed out a
 * row at a time until it is gone.
 *
 * Two things it deliberately does not do:
 *
 * - **It never shrinks a group below its drawn N.** A shorter viewport is already answered — the
 *   surrounding `ScrollArea` gives up the height and scrolls. Taking rows away as well would remove
 *   rows somebody can currently see in order to avoid a scroll they already have.
 * - **It never lands a group on a row boundary.** Every height it produces still comes out of
 *   {@link cutHeight}, so the boundary stays inside a row's text box and the half-row that says
 *   "this continues" survives. That rule is the whole reason the component exists (`RECIPES` §6
 *   records it going wrong three times in one segment), and filling dead space is not worth
 *   breaking it for.
 */

/** One `CutGroup`, as the fit sees it. */
export interface CutMember {
  /** The group's own element — the scroller whose height is being set. */
  el: HTMLElement
  /** One row's height in canvas px, the same figure the group cuts on. */
  rowHeight: number
  /** The reference design's row count. A floor, never reduced. */
  baseRows: number
  /** Hand the group the row count it should render at. */
  apply: (rows: number) => void
}

export interface CutFit {
  /** Register a group; returns the unregister. */
  join: (member: CutMember) => () => void
  /** Ask for a re-fit — after data lands, or anything else that changes what a group holds. */
  schedule: () => void
}

export const CutFitContext = createContext<CutFit | null>(null)

/** The fit a `CutGroup` belongs to, or `null` when it is not inside a `ScrollArea`. */
export function useCutFit(): CutFit | null {
  return useContext(CutFitContext)
}

