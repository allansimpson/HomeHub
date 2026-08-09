import type { IconId } from '../icons/Icon'

export interface NavSection {
  path: string
  label: string
  icon: IconId
}

/**
 * The eight **routed** bottom-nav sections, in order:
 * Home · Calendar · Meals · Care · Climate · Weather · Todo · Assist.
 *
 * Down from ten (NAV.md). Baby and Cat became one **Care** section with a subject switcher, and
 * Pantry folded into Meals as a third segment.
 *
 * **Assist is a destination again**, and this list is the eighth entry rather than a special case
 * beside it. It was previously excluded on the principle that *you invoke an assistant, you do not
 * navigate to one* — sound while Assist was a modal you raised over the screen you were on. The
 * revamped design (ASSIST.md) makes it the household's messaging surface: an inbox of chats with
 * unread counts, pinning and an archive. You do navigate to an inbox. The wake word still interrupts
 * from anywhere, but it now navigates here rather than covering what was showing.
 *
 * Eight cells on the 32.75rem track give 4.09rem each — still enough for both fallbacks the crowded
 * bar had spent to come back: `CALENDAR` is spelled out again, and the labels are back off the
 * 0.12em squeeze to 0.28em at 9px. Icons went 22px → 25px with the room. **Confirm on the real 4K
 * portrait panel** — `WEATHER` is the widest label. If anything clips, the sanctioned order of
 * fixes is tracking to 0.24em, then the icon to 24px. Do *not* re-shorten `CALENDAR`: that was the
 * symptom the whole rework removed. The cell count is unchanged by Assist becoming a route — it was
 * always drawing eight.
 *
 * **Config is deliberately not here.** The account avatar opens `/settings` from every screen, so
 * it does not spend a nav slot; `activeSectionPath` returns '' for it and nothing in the bar
 * lights up.
 */
export const NAV_SECTIONS: NavSection[] = [
  { path: '/', label: 'Home', icon: 'ico-home' },
  { path: '/calendar', label: 'Calendar', icon: 'ico-calendar' },
  { path: '/meals', label: 'Meals', icon: 'ico-meals' },
  // Conrad and Mika. Baby and Litter shared a five-part structure — live status, today's log, quick
  // actions, history, settings — so they share one frame with a subject switcher for a header.
  { path: '/care', label: 'Care', icon: 'ico-care' },
  { path: '/climate', label: 'Climate', icon: 'ico-climate' },
  { path: '/weather', label: 'Weather', icon: 'ico-weather' },
  // Two words. The bar uppercases it, so this reads `TO DO` — the way the lists themselves are
  // named, and the way Microsoft To Do spells it.
  { path: '/todo', label: 'To Do', icon: 'ico-todo' },
  // Rightmost, at the household's request (NAV.md). A tab and a route both, now that it is an inbox.
  { path: '/assist', label: 'Assist', icon: 'ico-assist' },
]

/**
 * Secondary (drill-in) routes that should still light up a parent nav section. Only needed for
 * drill-ins whose path sits *outside* their section — `/care/*` and `/meals/*` already match on
 * prefix below.
 */
const SECTION_FOR_PATH: Record<string, string> = {
  '/sensor': '/climate', // house / sensors sit under Climate
  '/pantry': '/meals',   // legacy Pantry paths light Meals
}

/**
 * The nav section that should read active for a (possibly deep) route. Returns '' when nothing
 * should highlight — e.g. the event editor, which renders without the bottom nav.
 */
export function activeSectionPath(pathname: string): string {
  if (pathname === '/') return '/'
  if (SECTION_FOR_PATH[pathname]) return SECTION_FOR_PATH[pathname]
  const hit = NAV_SECTIONS.find((s) => s.path !== '/' && pathname.startsWith(s.path))
  return hit?.path ?? ''
}
