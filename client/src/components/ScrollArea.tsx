import { useEffect, useRef, useState, type ReactNode } from 'react'

interface ScrollAreaProps {
  children: ReactNode
  /** Optional hint shown at the bottom while more content lies below (e.g. "Scroll for evening ▾"). */
  caption?: string
}

/**
 * Vertical scroll region for drill-in lists. No native scrollbar; scrollability is signalled by
 * (a) a bottom fade-out gradient, (b) a 3px brass position tick riding a hairline track, and
 * (c) an optional caption — the three indicators the dense-data spec (11) calls for.
 *
 * **The only thing that scrolls on a Kitchen screen** (design_handoff_kitchen_lists §2). It used to
 * host `CutFitProvider`, which shared the room left over at the bottom of this scroller between the
 * fixed-height groups inside it; those groups are gone, so a screen now has exactly one scrolling
 * region and the header, search row, shelf switch and action bar all sit outside it.
 *
 * @category Structure
 */
export function ScrollArea({ children, caption }: ScrollAreaProps) {
  const innerRef = useRef<HTMLDivElement>(null)
  const [thumb, setThumb] = useState<{ top: number; height: number } | null>(null)
  const [atEnd, setAtEnd] = useState(true)

  useEffect(() => {
    const el = innerRef.current
    if (!el) return
    const update = () => {
      const { scrollTop, scrollHeight, clientHeight } = el
      const overflow = scrollHeight - clientHeight
      if (overflow <= 4) {
        setThumb(null)
        setAtEnd(true)
        return
      }
      const height = Math.max(0.12, clientHeight / scrollHeight)
      setThumb({ top: (scrollTop / overflow) * (1 - height), height })
      setAtEnd(scrollTop >= overflow - 4)
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [children])

  return (
    <div className={'ml-scroll' + (atEnd ? ' ml-scroll--end' : '')}>
      <div className="ml-scroll__inner" ref={innerRef}>
        {children}
      </div>
      {thumb && (
        <div className="ml-scroll__track" aria-hidden="true">
          <div className="ml-scroll__tick" style={{ top: `${thumb.top * 100}%`, height: `${thumb.height * 100}%` }} />
        </div>
      )}
      {caption && !atEnd && <div className="ml-scroll__caption" aria-hidden="true">{caption}</div>}
    </div>
  )
}
