/**
 * Knowing that a newer panel is being served, and what to say about it afterwards.
 *
 * The moving parts live in `UpdateProvider`; what is here is the part that can be decided without a
 * browser — which build is which, and what a reload turned out to have done.
 */

import { clockLabel } from './dates'

/** Where the plate is in the sequence (`design_handoff_update_notice` → State). */
export type UpdateStatus = 'none' | 'ready' | 'applying' | 'restarting' | 'applied' | 'failed'

/**
 * A note the panel leaves itself on the way into a reload.
 *
 * <b>A reload is an amnesia, and the plate has something to say on the far side of it.</b> Nothing
 * in memory survives `location.reload()`, so an update that worked and an update that quietly did
 * nothing look identical to the app that comes back — same code, same screen, no history. Written
 * before the reload and read once after it, this is the only evidence either way.
 */
export interface UpdateHandoff {
  /** The build that was waiting when APPLY NOW was pressed. */
  expect: string
  /** The build the panel was running at that moment — what "still on" means if this fails. */
  from: string
  /** When it was pressed, epoch ms. Becomes "Applied at 16:57". */
  at: number
}

export const HANDOFF_KEY = 'homehub.update.handoff'

/** How long the applied plate stands before removing itself — "a few minutes" (README §04). */
export const APPLIED_VISIBLE_MS = 3 * 60_000

/**
 * Past which a handoff is not evidence about anything.
 *
 * The note is written seconds before a reload, so a live one is always young. An old one means the
 * reload never happened — the tab was closed mid-apply, the panel lost power — and the build running
 * now has no established relationship to it. Better to say nothing than to announce an update that
 * may have arrived some other way.
 */
export const HANDOFF_STALE_MS = 10 * 60_000

/**
 * The build stamp as a plate can carry it: `3fc6323+ · 2026-08-18 02:59Z` → `3fc6323+`.
 *
 * The commit is the identifier the household already sees in Config, and the `+` is not noise — it
 * marks a build made from an uncommitted tree, which is exactly the build somebody will later need
 * to recognise. A stamp with no commit in it (a checkout without git) falls back to its date; the
 * time of day is dropped, because a plate needs a name rather than a timestamp.
 */
export function shortVersion(stamp: string): string {
  const [head, tail] = stamp.split(' · ')
  if (tail) return head
  return head.slice(0, 10)
}

/** What the reload turned out to have done, decided once on the far side of it. */
export interface UpdateOutcome {
  status: 'applied' | 'failed'
  /** The build that was meant to land. */
  version: string
  /** The build that was running before — and, on a failure, still is. */
  from: string
  at: number
}

/**
 * Read the note, and say whether the update took.
 *
 * <b>The test is "did the build change", not "is it the build we expected".</b> Those differ when a
 * second deploy lands between the press and the reload, and in that case the panel is on newer code
 * than it went looking for — which is the thing succeeding, not failing. Only a panel that came back
 * running exactly what it left on has nothing to show for the press.
 */
export function outcomeOf(handoff: UpdateHandoff | null, currentBuild: string, now: number): UpdateOutcome | null {
  if (!handoff) return null
  if (now - handoff.at > HANDOFF_STALE_MS) return null
  const status = currentBuild === handoff.from ? 'failed' : 'applied'
  return { status, version: handoff.expect, from: handoff.from, at: handoff.at }
}

/**
 * Whether a worker sitting in `waiting` is actually offering anything.
 *
 * <b>A page can already be running the build its own service worker is waiting to install.</b>
 * Navigations are network-first (`sw.js`), so a reload after a deploy is served the *new* shell
 * straight from the server while the *old* worker is still the one controlling the page — and the
 * new worker, having installed behind it, sits in `waiting`. At that moment `__BUILD__` and the
 * waiting worker's build are the same string, and the panel is looking at an update it is already
 * running.
 *
 * Offered anyway, that is a plate the household cannot get rid of by doing what it asks: APPLY NOW
 * writes a handoff whose `from` is the build already loaded, hands over, reloads onto the same
 * build — and `outcomeOf` above, comparing the two, correctly reports that nothing changed. The
 * household sees the new panel, with its new features plainly there, being told the update failed.
 * Which is the report this exists to answer.
 *
 * <b>An unanswered `VERSION` is not a refusal.</b> `askVersion` gives up after three seconds and
 * resolves null, and a waiting worker that could not be reached is still much more likely to be a
 * genuine new build than not. Offered without a name, which is what the plate already says when it
 * has none.
 */
export function worthOffering(offered: string | null, running: string): boolean {
  if (offered === null) return true
  return offered !== running
}

/** The subset of `Storage` this needs, so the rules above can be tested without a browser. */
export interface HandoffStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function readHandoff(store: HandoffStore | null): UpdateHandoff | null {
  if (!store) return null
  let raw: string | null = null
  try {
    raw = store.getItem(HANDOFF_KEY)
  } catch {
    // Storage can be denied outright (private mode, a locked-down profile). The update still works;
    // it just cannot report on itself afterwards, which is a smaller loss than throwing at startup.
    return null
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<UpdateHandoff>
    if (typeof parsed?.expect !== 'string' || typeof parsed?.from !== 'string' || typeof parsed?.at !== 'number') {
      return null
    }
    return { expect: parsed.expect, from: parsed.from, at: parsed.at }
  } catch {
    return null
  }
}

export function writeHandoff(store: HandoffStore | null, handoff: UpdateHandoff): void {
  try {
    store?.setItem(HANDOFF_KEY, JSON.stringify(handoff))
  } catch {
    // See above — losing the note costs the panel its "NOW ON" plate, not its update.
  }
}

export function clearHandoff(store: HandoffStore | null): void {
  try {
    store?.removeItem(HANDOFF_KEY)
  } catch {
    // Nothing to do about it, and nothing depends on it having worked.
  }
}

/** The version a plate names, or null when nothing could establish which build is coming. */
export function plateVersion(version: string | null): string | null {
  return version ? shortVersion(version) : null
}

/**
 * "Applied at 4:57 PM" — the local clock, since that is the one the household was standing at.
 *
 * Twelve-hour like every other time the panel says out loud; it read `16:57` until the sweep that
 * took the header stamps 12-hour, and a plate that announces itself in a different dialect from the
 * header two inches above it is the kind of seam people notice without being able to name.
 */
export function appliedAt(at: number): string {
  return clockLabel(new Date(at))
}
