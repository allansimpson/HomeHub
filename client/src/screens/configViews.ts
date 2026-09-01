/**
 * Which sections Config has, and which of them a given profile is allowed to reach.
 *
 * Its own module rather than part of the screen, for the same reason `lockGating` is: this is the
 * decision, and a decision about who may see the household roster is worth being able to state in
 * a test without mounting a settings page around it.
 */

export type ConfigView =
  | 'index' | 'lists' | 'calendars' | 'privacy' | 'thresholds' | 'display' | 'household' | 'member'
  | 'assist' | 'weather' | 'notifications'
export const CONFIG_TITLES: Record<ConfigView, string> = {
  index: 'Config',
  lists: 'Lists',
  calendars: 'Calendars',
  privacy: 'Privacy & Lock',
  thresholds: 'Alert Thresholds',
  display: 'Display',
  household: 'Household',
  member: 'Member',
  assist: 'Assist',
  weather: 'Weather',
  notifications: 'Notifications',
}
/**
 * The views that manage the household roster, and are therefore an administrator's alone.
 *
 * `household` is the roster itself — add, rename, delete, clear a PIN — and `member` is one row of
 * it opened up. The server has refused all three writes to a non-administrator since AUDIT A1.4
 * (`ProfilesController`), so what is added here is the affordance rather than the rule: a Member
 * was being shown a door that would not open.
 */
const ADMIN_VIEWS: ReadonlySet<ConfigView> = new Set<ConfigView>(['household', 'member'])

/**
 * Which section of Config the URL is asking for, and whether this profile may see it.
 *
 * <b>An admin-only view resolves to the index rather than redirecting to it.</b> `isAdmin` is not
 * restored from the device — `sessionTrust.ts` keeps identity and deliberately not privilege — so
 * it is false on every cold start until the server answers, and it goes false again whenever the
 * panel drops offline. A redirect would fire in that window and rewrite the address, which loses
 * the deep link an administrator arrived with for no better reason than the session not having
 * come back yet. Collapsing the view leaves `/settings/household` in the bar and shows the index
 * beneath it; the moment `isAdmin` arrives the same URL resolves to the roster on its own.
 *
 * Failing closed is the right direction for the gap: an administrator sees the index for a moment
 * longer than they need to, where the reverse would show the roster to somebody who is not one.
 */
export function asConfigView(section: string | undefined, isAdmin: boolean): ConfigView {
  const view = section && section in CONFIG_TITLES && section !== 'index' ? (section as ConfigView) : 'index'
  return ADMIN_VIEWS.has(view) && !isAdmin ? 'index' : view
}
