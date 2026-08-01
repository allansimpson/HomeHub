import type { IconId } from '../icons/Icon'

export interface NavSection {
  path: string
  label: string
  icon: IconId
}

/**
 * The ten persistent bottom-nav sections, in the spec order:
 * Home · Cal · Meals · Pantry · Baby · Cat · Climate · Weather · TODO · Assist.
 *
 * Order is fixed. Meals sits third, directly after Calendar, putting the two planning surfaces
 * together (MEALS_NAV.md); Pantry sits fourth, immediately after Meals, because the two reference
 * each other constantly (PANTRY_NAV.md §1). Both are nav tabs rather than dashboard rows because
 * they are daily-use surfaces — "what's for dinner" and "have we got any" are asked every day, and
 * a row on Home is not where you go to answer either.
 *
 * **Ten items is the crowded end of this bar and everyone knows it.** The track is 32.75rem, so
 * cells go 3.64rem → 3.28rem. `CALENDAR` was already the binding label at nine, which is why it is
 * `Cal` here — PANTRY_NAV.md lists that shortening as fallback (1), and it was spent one stage
 * early. `.ml-nav__item` caps at 3.25rem and the labels track at 0.12em; the widest remaining label
 * is `WEATHER`. **Confirm on the real 4K portrait panel.** If anything clips, the remaining
 * sanctioned fixes are dropping the icon 22px → 20px, then a two-row bar — but do *not* move Pantry
 * to a dashboard row, which is the one thing PANTRY_NAV.md rules out.
 *
 * **Config is deliberately not here.** The account avatar in the top-right of every screen already
 * opens `/settings`, and a second route to the same place spends a nav slot on a duplicate. Config
 * is still a normal route; it just isn't a tab, so nothing in the bar lights up while it's open.
 */
export const NAV_SECTIONS: NavSection[] = [
  { path: '/', label: 'Home', icon: 'ico-home' },
  // `CAL`, not `CALENDAR`. At nine tabs it was the binding label — half again as wide as its
  // neighbours — and the one thing forcing every other gap in the bar to close up around it.
  // MEALS_NAV.md lists shortening it as the first sanctioned fix, ahead of dropping the icon size.
  { path: '/calendar', label: 'Cal', icon: 'ico-calendar' },
  { path: '/meals', label: 'Meals', icon: 'ico-meals' },
  { path: '/pantry', label: 'Pantry', icon: 'ico-pantry' },
  { path: '/baby', label: 'Baby', icon: 'ico-baby' },
  // Reads CAT, not LITTER: the tab is the household's cat, of which the Litter-Robot is currently
  // the only instrumented part — deliberately wider than what the section shows today. Nothing else
  // is renamed; the route, the screen and the specs stay Litter, because those really are about the
  // robot (NAV_CAT_TAB.md).
  { path: '/litter', label: 'Cat', icon: 'ico-litter' },
  { path: '/climate', label: 'Climate', icon: 'ico-climate' },
  { path: '/weather', label: 'Weather', icon: 'ico-weather' },
  { path: '/todo', label: 'Todo', icon: 'ico-todo' },
  { path: '/assistant', label: 'Assist', icon: 'ico-assist' },
]

/**
 * Secondary (drill-in) routes that should still light up a parent nav section. Only needed for
 * drill-ins whose path sits *outside* their section — `/baby/*` and `/litter/*` already match on
 * prefix below.
 */
const SECTION_FOR_PATH: Record<string, string> = {
  '/sensor': '/climate', // house / sensors sit under Climate
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
