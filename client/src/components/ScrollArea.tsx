import type { ReactNode } from 'react'

interface ScrollAreaProps {
  children: ReactNode
}

/**
 * Vertical scroll region for drill-in lists. No native scrollbar; scrollability is signalled
 * by the bottom fade-out gradient (a brass position tick is added per-screen where useful).
 */
export function ScrollArea({ children }: ScrollAreaProps) {
  return (
    <div className="ml-scroll">
      <div className="ml-scroll__inner">{children}</div>
    </div>
  )
}
