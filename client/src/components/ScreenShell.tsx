import type { ReactNode } from 'react'
import { BottomNav } from './BottomNav'
import { DoubleRule } from './DoubleRule'

interface ScreenShellProps {
  /** The screen header (DashboardHeader or DrillInHeader). */
  header: ReactNode
  children: ReactNode
  /** Full-bleed banner rendered ABOVE the header (e.g. a severe-weather alert), per spec 05. */
  banner?: ReactNode
  /** Show the double-rule motif under the header (default true). */
  rule?: boolean
  /** Show the bottom nav (default true; the Lock screen hides it). */
  nav?: boolean
  /** Dashboard is the idle display and must never scroll its content. */
  fixedContent?: boolean
}

/**
 * Full-height screen scaffold: [banner] → header → double-rule → content → bottom nav. Portrait,
 * 4K-scaled. Every screen composes this so chrome and structure stay consistent.
 */
export function ScreenShell({
  header,
  children,
  banner,
  rule = true,
  nav = true,
  fixedContent = false,
}: ScreenShellProps) {
  return (
    <div className="ml-shell">
      {banner}
      {header}
      {rule && <DoubleRule />}
      <div className={'ml-shell__content' + (fixedContent ? ' ml-shell__content--fixed' : '')}>
        {children}
      </div>
      {nav && <BottomNav />}
    </div>
  )
}
