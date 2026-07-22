import type { IconId } from '../icons/Icon'

export interface NavSection {
  path: string
  label: string
  icon: IconId
}

/** The six persistent bottom-nav sections, in display order (TODO promoted to its own tab, spec 03). */
export const NAV_SECTIONS: NavSection[] = [
  { path: '/', label: 'Home', icon: 'ico-home' },
  { path: '/todo', label: 'Todo', icon: 'ico-todo' },
  { path: '/calendar', label: 'Calendar', icon: 'ico-calendar' },
  { path: '/climate', label: 'Climate', icon: 'ico-climate' },
  { path: '/weather', label: 'Weather', icon: 'ico-weather' },
  { path: '/assistant', label: 'Assist', icon: 'ico-assist' },
]

/** Secondary (drill-in) routes that should still light up a parent nav section. */
const SECTION_FOR_PATH: Record<string, string> = {
  '/sensor': '/climate', // house / sensors sit under Climate
  '/settings': '/', // settings reached from Home / Lock
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
