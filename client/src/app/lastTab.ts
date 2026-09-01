import { NAV_SECTIONS } from './navConfig'

/**
 * Come back to the tab you were on.
 *
 * <b>The manifest starts at `/`, and a closed app has no memory of its own.</b> Android is free to
 * kill a backgrounded PWA whenever it wants the memory, a panel reboots after a power cut, and a
 * browser tab gets closed at the end of an evening — in all three the app comes back on the
 * dashboard as though it had never been open. On a tab somebody is using across a night, or a shop
 * they are halfway through, that is a small tax paid over and over. It is not a bug in the launch:
 * `/` is the correct `start_url` for a cold open, and there is no way for the manifest to know the
 * app was open five minutes ago.
 *
 * <b>Recency is the rule, not the size of the screen.</b> This used to restore on handhelds only,
 * and exclude the wall panel on the reasoning that the dashboard is what a panel exists to show
 * across a room — a panel that rebooted overnight should not come up on whatever tab was open at
 * 3am. That objection is right and it is about *time*, not about the device: the same is true of a
 * phone picked up the next morning, and false of a panel relaunched two minutes after somebody
 * walked away from the shopping list. So the tab is restored on every device, and only while it is
 * still recent — see {@link FRESH_FOR_MS}. A panel that has been off all night still opens on the
 * house, which is the behaviour the exclusion was protecting.
 *
 * The tab, never the drill-in. Somebody killed mid-way through a recipe is returned to KITCHEN, not
 * to the recipe: a deep screen restored out of context is a place you did not ask to be, and its
 * data may be long stale. "Which tab" is the whole of what is worth remembering.
 */

const KEY = 'homehub.lasttab.v1'

/**
 * How long a remembered tab is worth returning to.
 *
 * <b>Four hours, chosen against a gap rather than a clock.</b> It has to cover the ordinary shape of
 * this — put the phone down after breakfast, pick it up before lunch; the panel restarts while
 * somebody is still in the kitchen — and expire across the one gap that has a right answer already,
 * which is overnight. Anything that spans a night comes back to the dashboard, on a phone as much as
 * on the panel, because a tab you left open yesterday is not where you are today.
 *
 * The stamp is rewritten on every tab change (`rememberTab`), so this measures time since the app
 * was last *used*, not since the tab was first opened.
 */
const FRESH_FOR_MS = 4 * 60 * 60_000

const TAB_PATHS = new Set(NAV_SECTIONS.map((s) => s.path))

/** A tab, and when it was last in view. Both halves are needed to decide anything. */
export interface RememberedTab {
  path: string
  /** `Date.now()` at the moment the tab was noted. */
  atMs: number
}

/**
 * Which tab a launch should open on, or null to leave it where it landed.
 *
 * Pure, and separate from the doing, because every clause is a case where restoring would be wrong
 * and each has to be checked rather than assumed.
 */
export function tabToRestore(
  { at, remembered, now }: { at: string; remembered: RememberedTab | null; now: number },
): string | null {
  /*
   * Only a launch that landed on the start URL.
   *
   * Anything else is a deliberate destination — a deep link somebody followed, a bookmark, a
   * reload of the screen they are actually on — and redirecting it would be overriding an explicit
   * request with a remembered one.
   */
  if (at !== '/') return null
  // Nothing remembered, or the dashboard *is* what was remembered, so there is nothing to do.
  if (!remembered || remembered.path === '/') return null
  // A path from an older build whose tab has since been renamed or removed. Refuse rather than
  // navigate somewhere that no longer routes.
  if (!TAB_PATHS.has(remembered.path)) return null

  /*
   * Stale, or stamped in the future.
   *
   * A negative age means the clock moved backwards under us — a panel that lost power and came back
   * before NTP caught up will do exactly this — and the honest answer to "how long ago was that?"
   * is then "no idea". The dashboard is the safe thing to be wrong with.
   */
  const age = now - remembered.atMs
  if (age < 0 || age > FRESH_FOR_MS) return null

  return remembered.path
}

/**
 * Read what was stored, or null.
 *
 * <b>Exported because the shape can be wrong in three ways and each is worth pinning down.</b> A
 * value written by the build before this one is a bare path with no stamp; it parses as nothing and
 * is quietly replaced the next time a tab is noted, which costs the household one restore, once.
 */
export function parseRemembered(raw: string | null): RememberedTab | null {
  if (!raw) return null
  try {
    const held = JSON.parse(raw) as Partial<RememberedTab>
    if (typeof held?.path !== 'string' || !Number.isFinite(held.atMs)) return null
    return { path: held.path, atMs: held.atMs as number }
  } catch {
    // Not JSON at all — the older format, or a truncated write.
    return null
  }
}

/** Note the tab in view. Anything that is not a tab root is ignored, not stored as one. */
export function rememberTab(path: string, now: number = Date.now()): void {
  if (!TAB_PATHS.has(path)) return
  try {
    localStorage.setItem(KEY, JSON.stringify({ path, atMs: now } satisfies RememberedTab))
  } catch {
    // A full or disabled store costs the household this convenience and nothing else.
  }
}

export function forgetTab(): void {
  try {
    localStorage.removeItem(KEY)
  } catch { /* best effort */ }
}

function remembered(): RememberedTab | null {
  try {
    return parseRemembered(localStorage.getItem(KEY))
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
  const target = tabToRestore({
    at: window.location.pathname,
    remembered: remembered(),
    now: Date.now(),
  })
  if (target) window.history.replaceState(null, '', target)
}
