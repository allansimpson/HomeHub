import type { IconId } from '../icons/Icon'

export interface NavSection {
  path: string
  label: string
  icon: IconId
}

/** The five persistent bottom-nav sections, in display order. */
export const NAV_SECTIONS: NavSection[] = [
  { path: '/', label: 'Home', icon: 'ico-home' },
  { path: '/calendar', label: 'Calendar', icon: 'ico-calendar' },
  { path: '/climate', label: 'Climate', icon: 'ico-climate' },
  { path: '/weather', label: 'Weather', icon: 'ico-weather' },
  { path: '/assistant', label: 'Assist', icon: 'ico-assist' },
]
