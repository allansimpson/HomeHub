/**
 * Client-side TODO view preferences: whether the special "Today" and "All" tabs appear. They're
 * app-level views (not Microsoft lists), so they live in localStorage and are read by both the TODO
 * screen (to show/hide the tabs) and Settings (to toggle them). Default on.
 */
const SHOW_TODAY = 'homehub.todo.showToday'
const SHOW_ALL = 'homehub.todo.showAll'

export const getShowToday = (): boolean => localStorage.getItem(SHOW_TODAY) !== 'false'
export const getShowAll = (): boolean => localStorage.getItem(SHOW_ALL) !== 'false'
export const setShowToday = (v: boolean): void => localStorage.setItem(SHOW_TODAY, String(v))
export const setShowAll = (v: boolean): void => localStorage.setItem(SHOW_ALL, String(v))

/**
 * The last list tab a member had open, remembered per profile.
 *
 * Per profile rather than per panel because the tabs *are* the member's own Microsoft lists: one
 * shared value would hand the next person to sign in a list they do not have, and the tab-validity
 * guard would immediately discard it — so the panel would look like it forgot, for both of them.
 *
 * localStorage, not session state, so it survives signing out and back in. Nothing here is private:
 * it is the name of a list, and the tasks themselves never persist client-side.
 */
const ACTIVE_LIST_PREFIX = 'homehub.todo.activeList'

const activeListKey = (profileId: number | null): string =>
  profileId == null ? ACTIVE_LIST_PREFIX : `${ACTIVE_LIST_PREFIX}.${profileId}`

export function getActiveList(profileId: number | null): string | null {
  const stored = localStorage.getItem(activeListKey(profileId))
  if (stored) return stored
  // One-time carry-over from the single shared key this replaced, so an upgrade does not read as
  // the panel forgetting the tab someone had been using.
  return profileId == null ? null : localStorage.getItem(ACTIVE_LIST_PREFIX)
}

export const setActiveList = (profileId: number | null, list: string): void =>
  localStorage.setItem(activeListKey(profileId), list)
