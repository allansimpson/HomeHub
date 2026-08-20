import { NAV_SECTIONS } from './navConfig'

/**
 * Come back to the tab you were on, on a phone.
 *
 * <b>The manifest starts at `/`, and Android is free to kill a backgrounded PWA whenever it wants
 * the memory.</b> Those two together mean putting the phone down on the Baby tab and picking it up
 * again lands on the dashboard — the app looks like it was never open, and on a tab somebody is
 * using across a night that is a small tax paid over and over. It is not a bug in the launch: `/`
 * is the correct `start_url` for a cold open, and there is no way for the manifest to know the app
 * was open five minutes ago.
 *
 * <b>The wall panel is deliberately excluded.</b> It is always on, it is rarely relaunched, and the
 * dashboard is its resting state — it is the screen the household reads from across a room, and a
 * panel that rebooted overnight should be showing the house rather than whatever tab somebody left
 * open at 3am. Only a hand-held viewport restores.
 *
 * The tab, never the drill-in. Somebody killed mid-way through a recipe is returned to KITCHEN, not
 * to the recipe: a deep screen restored out of context is a place you did not ask to be, and its
 * data may be long stale. "Which tab" is the whole of what is worth remembering.
 */

const KEY = 'homehub.lasttab.v1'

/** The panel is 2160 CSS px across and a phone is under 500, so this sits far from both. */
const HANDHELD_MAX_PX = 820

const TAB_PATHS = new Set(NAV_SECTIONS.map((s) => s.path))

/**
 * Which tab a launch should open on, or null to leave it where it landed.
 *
 * Pure, and separate from the doing, because every clause is a case where restoring would be wrong
 * and each has to be checked rather than assumed.
 */
export function tabToRestore(
  { at, remembered, handheld }: { at: string; remembered: string | null; handheld: boolean },
): string | null {
  // A wall panel opens on the house. See above.
  if (!handheld) return null
  /*
   * Only a launch that landed on the start URL.
   *
   * Anything else is a deliberate destination — a deep link somebody followed, a bookmark, a
   * reload of the screen they are actually on — and redirecting it would be overriding an explicit
   * request with a remembered one.
   */
  if (at !== '/') return null
  // Nothing remembered, or the dashboard *is* what was remembered, so there is nothing to do.
  if (!remembered || remembered === '/') return null
  // A path from an older build whose tab has since been renamed or removed. Refuse rather than
  // navigate somewhere that no longer routes.
  if (!TAB_PATHS.has(remembered)) return null
  return remembered
}

/** Note the tab in view. Anything that is not a tab root is ignored, not stored as one. */
export function rememberTab(path: string): void {
  if (!TAB_PATHS.has(path)) return
  try {
    localStorage.setItem(KEY, path)
  } catch {
    // A full or disabled store costs the household this convenience and nothing else.
  }
}

export function forgetTab(): void {
  try {
    localStorage.removeItem(KEY)
  } catch { /* best effort */ }
}

function remembered(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

/**
 * Put the URL back before anything renders.
 *
 * <b>Called before the router mounts, which is what makes this invisible.</b> Doing it from an
 * effect would paint the dashboard first and swap a frame later — a flash of the wrong screen on
 * every single launch, which reads worse than the problem it fixes. `BrowserRouter` reads
 * `window.location` when it mounts, so rewriting the address beforehand means it simply starts
 * where it should have.
 *
 * `replaceState`, not a push: the dashboard was never a place anybody visited, and leaving it in
 * the history would put it one back gesture away — see `backGuard.ts` for why that matters here.
 */
export function restoreLastTab(): void {
  const handheld = window.matchMedia(`(max-width: ${HANDHELD_MAX_PX}px)`).matches
  const target = tabToRestore({ at: window.location.pathname, remembered: remembered(), handheld })
  if (target) window.history.replaceState(null, '', target)
}
