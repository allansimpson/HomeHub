import type { ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { NAV_SECTIONS } from './navConfig'

const SECTION_PATHS = new Set(NAV_SECTIONS.map((s) => s.path))

/**
 * Restrained route motion. Switching bottom-nav sections is a quick fade; drilling into a
 * deeper screen (a non-nav path) slides up + fades, per the design system. Keying the
 * wrapper by pathname retriggers the CSS animation on each navigation.
 */
export function ScreenTransition({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const isSection = SECTION_PATHS.has(pathname)
  const variant = isSection ? 'ml-transition--fade' : 'ml-transition--slideup'
  return (
    <div key={pathname} className={`ml-transition ${variant}`}>
      {children}
    </div>
  )
}
