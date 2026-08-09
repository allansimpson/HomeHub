import { NAV_SECTIONS } from './navConfig'

/**
 * Which motion a route change gets, for the View Transitions API (`data-vt`, styled in ledger.css).
 *
 * Drilling into a deeper screen rises, backing out settles down, and anything lateral cross-fades.
 * Depth is inferred from the path, which is why peer groups below exist.
 */
export type RouteMotion = 'fade' | 'slideup' | 'slidedown'

const SECTION_PATHS = new Set(NAV_SECTIONS.map((s) => s.path))

/**
 * Routes that are peers of one another rather than parent and child.
 *
 * Inferring depth from the path is right for drill-ins and wrong for a segmented control. MEALS
 * spreads `WEEK · RECIPES · PANTRY` across three routes, so `/meals/recipes` only *looks* deeper
 * than `/meals` — tapping a segment is a lateral move, the same kind of move as tab ↔ tab.
 *
 * Reading it as depth gave every segment switch the drill-in rise: the incoming screen started
 * 1.25rem low and settled upward, so the tab strip visibly dropped and came back on each tap. That
 * strip is the one thing on those screens that must not move — it is what you are aiming at.
 *
 * Only exact roots belong here. `/meals/recipes/42` is a genuine drill-in and must keep its rise.
 */
export const PEER_GROUPS: readonly (readonly string[])[] = [
  ['/meals', '/meals/recipes', '/meals/pantry'],
]

/** True when both paths sit in the same peer group — a lateral move, not a drill-in. */
export function arePeers(from: string, to: string): boolean {
  return PEER_GROUPS.some((group) => group.includes(from) && group.includes(to))
}

export function directionFor(from: string, to: string): RouteMotion {
  // Before the depth checks: these paths nest, so depth alone would misread them as a drill-in.
  if (arePeers(from, to)) return 'fade'
  const toSection = SECTION_PATHS.has(to)
  if (!toSection) return 'slideup' // into a drill-in (event editor, sensor history, config sub-page)
  if (!SECTION_PATHS.has(from)) return 'slidedown' // out of a drill-in, back to a tab
  return 'fade' // tab ↔ tab
}
