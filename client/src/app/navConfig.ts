import type { IconId } from '../icons/Icon'

export interface NavSection {
  path: string
  label: string
  icon: IconId
}

/**
 * The eight **routed** bottom-nav sections, in order:
 * Home · Cal · Kitchen · Baby · Devices · Weather · Lists · Assist.
 *
 * Down from ten (NAV.md). Baby and Cat became one **Care** section with a subject switcher, and
 * Pantry folded into Meals as a third segment.
 *
 * **`KITCHEN`, not `MEALS`.** The slot used to hold meal planning with a pantry segment bolted on;
 * it now holds the whole loop — plan, review, shop, put away, cook, and the leftovers that go back
 * to plan. `MEALS` named one station in that loop and made the other four look like sub-features of
 * it, which is exactly how the pantry ended up as a third segment nobody could find. The section
 * keeps the meals glyph: a steaming dish still reads as the room, and drawing a new one would be
 * changing the thing people recognise the tab by for no gain.
 *
 * **Assist is a destination again**, and this list is the eighth entry rather than a special case
 * beside it. It was previously excluded on the principle that *you invoke an assistant, you do not
 * navigate to one* — sound while Assist was a modal you raised over the screen you were on. The
 * revamped design (ASSIST.md) makes it the household's messaging surface: an inbox of chats with
 * unread counts, pinning and an archive. You do navigate to an inbox. The wake word still interrupts
 * from anywhere, but it now navigates here rather than covering what was showing.
 *
 * **`CAL`, and this file used to forbid exactly that.** The old note said the abbreviation was a
 * symptom of a crowded ten-tab bar and must never come back. That reasoning was sound for what it
 * described — a label shortened because there was no room — and it does not cover this. Here the
 * bar is eight equal cells of 67.5 mock px (`design_handoff_bottom_nav/BOTTOM_NAV.md`), and
 * `CALENDAR` at 73 px is the one word that cannot fit one. It is not being shortened to survive
 * crowding; it is what buys every icon a regular pitch, and it was agreed on that basis.
 *
 * The rest of the labels keep their words. **Confirm on the real 4K portrait panel** — `WEATHER`
 * and `KITCHEN` are jointly the widest at seven characters, `WEATHER` measuring 58 px with 9.5 px
 * of air. If anything clips, the sanctioned order of fixes is tracking to 0.20em, then the icon
 * to 24px. Do *not* put the cells back on content sizing: the
 * uneven icon pitch is the fault the spacing pass removed.
 *
 * **Config is deliberately not here.** The account avatar opens `/settings` from every screen, so
 * it does not spend a nav slot; `activeSectionPath` returns '' for it and nothing in the bar
 * lights up.
 */
export const NAV_SECTIONS: NavSection[] = [
  { path: '/', label: 'Home', icon: 'ico-home' },
  { path: '/calendar', label: 'Cal', icon: 'ico-calendar' },
  { path: '/kitchen', label: 'Kitchen', icon: 'ico-meals' },
  /*
   * The CARE split (design_handoff_baby_devices).
   *
   * Care held Conrad and Mika behind a subject switcher, on the reasoning that a baby and a litter
   * robot share a five-part structure. They do — but they share nothing anybody actually does: the
   * baby is a log you write to many times a day, the robot is a machine you check when it complains.
   * So the baby keeps the tab and is called BABY again, and the robot moves in with the air
   * conditioners under DEVICES.
   *
   * CLIMATE leaves the bar with them: each AC is a device, and the room it reads is inside it.
   */
  { path: '/care', label: 'Baby', icon: 'ico-baby' },
  { path: '/devices', label: 'Devices', icon: 'ico-devices' },
  { path: '/weather', label: 'Weather', icon: 'ico-weather' },
  // `LISTS`, not `TO DO`. The tab holds the household's lists — groceries, household, whatever
  // Microsoft To Do is syncing — and naming it after one of them read as a single checklist.
  // Renamed while nothing had bookmarked it, which is the only cheap moment to move a route.
  { path: '/lists', label: 'Lists', icon: 'ico-todo' },
  // Rightmost, at the household's request (NAV.md). A tab and a route both, now that it is an inbox.
  { path: '/assist', label: 'Assist', icon: 'ico-assist' },
]

/**
 * Secondary (drill-in) routes that should still light up a parent nav section. Only needed for
 * drill-ins whose path sits *outside* their section — `/care/*` and `/kitchen/*` already match on
 * prefix below.
 */
const SECTION_FOR_PATH: Record<string, string> = {
  // A probe's history is a device's history now. `/climate` redirects rather than rendering, so it
  // never needs a section of its own.
  '/sensor': '/devices',
  // The pre-Kitchen screens, both still routed and both still reachable from inside the section —
  // the recipe editor is `/meals/recipes/:id/edit` and is not drawn in the Kitchen handoff. A tab
  // that went dark on a screen you reached from it reads as having navigated somewhere else.
  '/meals': '/kitchen',
  '/pantry': '/kitchen',
}

/**
 * The nav section that should read active for a (possibly deep) route. Returns '' when nothing
 * should highlight — e.g. the event editor, which renders without the bottom nav.
 */
export function activeSectionPath(pathname: string): string {
  if (pathname === '/') return '/'
  // Prefix, not exact: `/climate/room/3` is as much a device detail as `/climate` is.
  const rehomed = Object.keys(SECTION_FOR_PATH).find((p) => pathname === p || pathname.startsWith(`${p}/`))
  if (rehomed) return SECTION_FOR_PATH[rehomed]
  const hit = NAV_SECTIONS.find((s) => s.path !== '/' && pathname.startsWith(s.path))
  return hit?.path ?? ''
}
