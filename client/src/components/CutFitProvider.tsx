import {
  useCallback, useEffect, useMemo, useRef,
  type ReactNode, type RefObject,
} from 'react'
import { cutHeight } from '../app/kitchenDomain'
import { CutFitContext, type CutFit, type CutMember } from './cutFit'

/**
 * Coordinates the cut groups inside one scroller.
 *
 * It has to be one owner rather than each group measuring for itself: the room at the foot of the
 * scroller is *shared*, and two groups that each read "there are 300px going spare" would both take
 * them. The provider is rendered by {@link ScrollArea}, which is the element every panel in the
 * section already scrolls inside.
 */
export function CutFitProvider({
  scroller,
  children,
}: {
  /** The scrolling element — `ScrollArea`'s inner. */
  scroller: RefObject<HTMLElement | null>
  children: ReactNode
}) {
  const members = useRef(new Set<CutMember>())
  const frame = useRef(0)

  const fit = useCallback(() => {
    frame.current = 0
    const inner = scroller.current
    const list = [...members.current].filter((m) => m.el.isConnected)
    if (!inner || !list.length) return

    // Canvas px → real px. Everything in the panel is drawn against a 540×960 canvas at
    // 1rem = 16 canvas px, and `app/remScale.ts` is what maps that onto the device.
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    const real = (canvasPx: number) => (canvasPx * rem) / 16

    /*
     * How tall the scroller's content is — measured off the children rather than read from
     * `scrollHeight`.
     *
     * `scrollHeight` is `max(content, clientHeight)`, so on exactly the screens this exists to fix
     * — the ones whose content stops short — it reports the full height of the box and the room
     * going spare comes out as zero. The one number that must be right is the one that is wrong by
     * construction.
     */
    const box = inner.getBoundingClientRect()
    let bottom = box.top
    for (const child of inner.children) {
      bottom = Math.max(bottom, child.getBoundingClientRect().bottom)
    }
    const content = bottom - box.top + inner.scrollTop

    // Everything in the scroller that is not a group: headers, bands, prose, footer buttons. It
    // does not move when a group grows, so the room the groups may share is what is left of the
    // scroller once it has had its share.
    let occupied = 0
    for (const m of list) occupied += m.el.offsetHeight
    const room = inner.clientHeight - (content - occupied)
    if (room <= 0) {
      for (const m of list) m.apply(m.baseRows)
      return
    }

    /** How tall group `i` would stand at `n` rows — never taller than what it actually holds. */
    const natural = list.map((m) => m.el.scrollHeight)
    const heightAt = (i: number, n: number) =>
      Math.min(real(cutHeight(n, list[i].rowHeight)), natural[i])

    const rows = list.map((m) => m.baseRows)
    let used = rows.reduce((total, n, i) => total + heightAt(i, n), 0)

    /*
     * Hand out the room one row at a time, always to the group showing the least of what it holds.
     *
     * A row at a time rather than a proportional split because a group's height may only ever land
     * on `N × rowH + rowH/2`; a proportional share lands between two of those and has to be rounded
     * back to one, which is this same arithmetic done twice and the second time badly. Going to the
     * hungriest group each round is what makes the result proportional — a group holding forty rows
     * behind its cut takes more of the slack than one holding two, without either being told so.
     *
     * The guard is a backstop against a pathological row height, not an expected limit: each pass
     * either grows a group by one row or stops, and the room is finite.
     */
    for (let guard = 0; guard < 500; guard++) {
      let pick = -1
      let leastShown = Infinity
      for (let i = 0; i < list.length; i++) {
        // Nothing queued behind this cut — it is already showing everything it has.
        if (natural[i] <= heightAt(i, rows[i]) + 1) continue
        const shown = heightAt(i, rows[i]) / natural[i]
        if (shown < leastShown) {
          leastShown = shown
          pick = i
        }
      }
      if (pick < 0) break
      const grown = used - heightAt(pick, rows[pick]) + heightAt(pick, rows[pick] + 1)
      if (grown > room) break
      rows[pick]++
      used = grown
    }

    for (let i = 0; i < list.length; i++) list[i].apply(rows[i])
  }, [scroller])

  /*
   * One fit per frame. Data landing on a panel with three groups fires three schedules in the same
   * tick, and every one of them would measure the same layout.
   */
  const schedule = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(fit)
  }, [fit])

  const value = useMemo<CutFit>(() => ({
    join: (member) => {
      members.current.add(member)
      schedule()
      return () => {
        members.current.delete(member)
        schedule()
      }
    },
    schedule,
  }), [schedule])

  useEffect(() => {
    const inner = scroller.current
    if (!inner) return
    // The scroller's own box changing is a rotation, a keyboard, or a window being dragged — all of
    // them change how much room there is. A group growing does not change it, so this cannot be the
    // loop it looks like.
    const ro = new ResizeObserver(schedule)
    ro.observe(inner)
    schedule()
    return () => {
      ro.disconnect()
      if (frame.current) cancelAnimationFrame(frame.current)
      frame.current = 0
    }
  }, [scroller, schedule])

  return <CutFitContext.Provider value={value}>{children}</CutFitContext.Provider>
}
