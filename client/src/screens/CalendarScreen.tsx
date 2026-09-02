import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { ScreenShell, ScrollArea, SectionLabel } from '../components'
import { Icon } from '../icons/Icon'
import { useSession } from '../app/SessionProvider'
import { api, ApiError } from '../api/client'
import type { CalendarEventDto, ProfileDto } from '../api/types'
import { addMonths, dayKey, formatTime, isSameDay, monthGrid, monthName, startOfMonth, weekdayName } from '../app/dates'
import { isAllDay, markDefinition, markMeta, resolveDayMark, resolveMark } from '../app/calendarMarks'
import type { CalendarMarks, MarkKey, ResolvedMark } from '../app/calendarMarks'

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

/** Re-sync the visible month on a timer so Google-added events appear without navigating away. */
const REFRESH_MS = 30_000

/** Movement before a horizontal swipe is claimed, so a tap on a day is still a tap. */
const CLAIM_PX = 8

/** Vertical travel, with no horizontal claim, that hands the gesture back to the page for good. */
const GIVE_UP_PX = 24

/**
 * How far horizontal must lead vertical for a drag to count as a swipe.
 *
 * Below 1 on purpose, as on the Care pager: a thumb crossing a wall panel arcs, so a gesture a
 * person reads as sideways is very rarely sideways to the pixel. Demanding strict dominance makes
 * a swipe feel like it has to be drawn with a ruler.
 */
const AXIS_LEAD = 0.7

/**
 * A flick: short, fast, and over. Under {@link FLICK_MS}, {@link FLICK_PX} is enough to turn the
 * month — half the grid is a long way to ask a thumb to travel for something the arrows do in a tap.
 */
const FLICK_MS = 300
const FLICK_PX = 36

/** Otherwise, the share of the grid's width the finger has to cover to settle onto the next month. */
const SETTLE_FRACTION = 0.22

/**
 * How much of the finger's travel the grid follows.
 *
 * The month is hinged rather than carried: there is no next month drawn behind it to be dragged
 * into view, so a grid that tracked the finger one-to-one would pull a blank column in beside
 * itself. A third of the travel is enough to say "this is moving, and it is moving that way".
 */
const DRAG_FOLLOW = 0.35

/**
 * Calendar (spec 02): month grid + the selected day's agenda. Today is a brass block; days with
 * events get a brass dash. The header + opens the event editor; tapping an agenda row edits it.
 */
export function CalendarScreen() {
  const navigate = useNavigate()
  const { profiles, activeProfileId } = useSession()
  const [activeMonth, setActiveMonth] = useState(() => startOfMonth(new Date()))
  const [selected, setSelected] = useState(() => new Date())
  const [events, setEvents] = useState<CalendarEventDto[]>([])
  const [calendarMarks, setCalendarMarks] = useState<CalendarMarks>(() => new Map())

  const load = useCallback(async () => {
    const from = startOfMonth(activeMonth)
    const to = addMonths(activeMonth, 1)
    try {
      setEvents(await api.getEvents(from.toISOString(), to.toISOString()))
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
    }
  }, [activeMonth])

  useEffect(() => {
    void load()
    // Poll while the calendar is on screen (each getEvents re-syncs Google server-side), and also
    // refresh immediately after a write-queue replay. Pauses when the tab is hidden to avoid waste.
    const tick = () => { if (!document.hidden) void load() }
    const id = window.setInterval(tick, REFRESH_MS)
    const onVisible = () => { if (!document.hidden) void load() }
    window.addEventListener('homehub:sync', tick)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('homehub:sync', tick)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  // The household's calendar → mark assignments (spec 14, axis 2). Absent unless Google is
  // configured and linked; every failure just means no calendar marks, never a broken month.
  useEffect(() => {
    if (activeProfileId == null) {
      setCalendarMarks(new Map())
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const cals = await api.getCalendars(activeProfileId)
        if (cancelled) return
        const marks = new Map<string, MarkKey>()
        for (const c of cals) {
          const def = markDefinition(c.icon)
          if (def && def.icon) marks.set(c.calendarId, def.key)
        }
        setCalendarMarks(marks)
      } catch (err) {
        if (!(err instanceof ApiError)) throw err
        if (!cancelled) setCalendarMarks(new Map())
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeProfileId])

  /** One mark per day plus the count of events beyond it — the grid never draws a second icon. */
  const dayMarks = useMemo(() => {
    const byDay = new Map<string, CalendarEventDto[]>()
    for (const e of events) {
      const key = dayKey(new Date(e.startUtc))
      const list = byDay.get(key)
      if (list) list.push(e)
      else byDay.set(key, [e])
    }
    const out = new Map<string, ReturnType<typeof resolveDayMark>>()
    for (const [key, list] of byDay) out.set(key, resolveDayMark(list, calendarMarks))
    return out
  }, [events, calendarMarks])

  const grid = useMemo(() => monthGrid(activeMonth), [activeMonth])
  const today = new Date()

  const swipe = useMonthSwipe((delta) => setActiveMonth((m) => addMonths(m, delta)))

  const agenda = useMemo(
    () =>
      events
        .filter((e) => isSameDay(new Date(e.startUtc), selected))
        .sort((a, b) => a.startUtc.localeCompare(b.startUtc)),
    [events, selected],
  )

  const pickDay = (day: Date) => {
    // A swipe lifts off over some day of whichever month it turned to; that is not a choice of day.
    if (swipe.swiped()) return
    if (day.getMonth() !== activeMonth.getMonth()) setActiveMonth(startOfMonth(day))
    setSelected(day)
  }

  const header = (
    <header className="ml-header ml-cal-header">
      <span className="ml-cal-header__month serif">{monthName(activeMonth).toUpperCase()}</span>
      <span className="ml-cal-header__year serif">{activeMonth.getFullYear()}</span>
      <div className="ml-cal-header__actions">
        <button type="button" className="ml-iconbtn" onClick={() => setActiveMonth(addMonths(activeMonth, -1))} aria-label="Previous month">
          <Icon id="ico-back" size="1.125rem" />
        </button>
        <button type="button" className="ml-iconbtn" onClick={() => setActiveMonth(addMonths(activeMonth, 1))} aria-label="Next month">
          <Icon id="ico-chevron-right" size="1.125rem" />
        </button>
        <button
          type="button"
          className="ml-iconbtn ml-iconbtn--accent"
          onClick={() => navigate(`/calendar/new?date=${dayKey(selected)}`)}
          aria-label="New event"
        >
          <Icon id="ico-add" size="1.375rem" />
        </button>
      </div>
    </header>
  )

  return (
    <ScreenShell header={header}>
      <div className="ml-calgrid" {...swipe.surface}>
        {/* The weekday letters are the same in every month, so they hold still while it turns. */}
        <div className="ml-calgrid__dow">
          {DOW.map((d, i) => (
            <span key={i} className="ml-calgrid__dowlabel">{d}</span>
          ))}
        </div>
        <div {...swipe.cells}>
          {grid.map((day, i) => {
            const inMonth = day.getMonth() === activeMonth.getMonth()
            const isToday = isSameDay(day, today)
            const isSel = isSameDay(day, selected)
            // Adjacent-month cells draw no marks at all — the month's own shape must stay readable.
            const marks = inMonth ? dayMarks.get(dayKey(day)) : undefined
            return (
              <button
                key={i}
                type="button"
                className={
                  'ml-calcell' +
                  (inMonth ? '' : ' ml-calcell--adjacent') +
                  (isToday ? ' ml-calcell--today' : '') +
                  (isSel && !isToday ? ' ml-calcell--selected' : '')
                }
                onClick={() => pickDay(day)}
              >
                <span className="ml-calcell__num serif">{day.getDate()}</span>
                <DayMarks marks={marks} />
              </button>
            )
          })}
        </div>
      </div>

      <SectionLabel
        label={`${weekdayName(selected)} ${selected.getDate()}${isSameDay(selected, today) ? ' — Today' : ''}`}
        status={`${agenda.length} ${agenda.length === 1 ? 'engagement' : 'engagements'}`}
      />
      <ScrollArea caption="Scroll for more ▾">
        {agenda.length === 0 ? (
          <div className="ml-cal-empty">Nothing scheduled</div>
        ) : (
          agenda.map((e) => (
            <AgendaRow
              key={e.id}
              event={e}
              mark={resolveMark(e, calendarMarks)}
              profiles={profiles}
              onClick={() => navigate(`/calendar/edit/${e.id}`)}
            />
          ))
        )}
      </ScrollArea>
    </ScreenShell>
  )
}

/**
 * Turn the month with a horizontal swipe across the grid, exactly as the header arrows do.
 *
 * <b>The gesture is claimed on an axis, not on the first sample.</b> The grid sits above a page
 * that scrolls, and a thumb reaching across a wall panel almost always opens with a little vertical
 * drift — deciding on the first move would make the swipe feel dead as often as not. So neither
 * axis wins until one is clearly ahead: horizontal claims once it passes {@link CLAIM_PX} *and*
 * leads the vertical by {@link AXIS_LEAD}, and the gesture is only handed back once it has plainly
 * committed to a scroll ({@link GIVE_UP_PX} of vertical with no horizontal claim). Everything
 * between the two is still undecided and is re-examined on the next sample.
 *
 * <b>A claimed swipe is not a tap.</b> Pointer capture moves the eventual `click` off the day cell
 * the finger happened to lift over, but that is a browser behaviour rather than a guarantee, so
 * {@link swiped} is the thing `pickDay` actually asks. It is set the moment the swipe is claimed
 * and cleared on the next pointer-down, which is always after the click it is there to swallow.
 *
 * Months run in both directions without end, so there is nothing to bounce off and no rubber band:
 * a swipe either turns the month or springs back.
 */
function useMonthSwipe(turn: (delta: number) => void) {
  const cells = useRef<HTMLDivElement | null>(null)
  const startX = useRef<number | null>(null)
  const startY = useRef(0)
  const startedAt = useRef(0)
  const dragging = useRef(false)
  const claimed = useRef(false)
  /** Live finger travel in px while a swipe is in flight; 0 at rest. Raw, not damped — see render. */
  const [dx, setDx] = useState(0)
  /** True while the grid is travelling back to centre after a swipe that did not settle. */
  const [releasing, setReleasing] = useState(false)
  /** Which way the month that just arrived came from, until its animation finishes. */
  const [arriving, setArriving] = useState<'back' | 'forward' | null>(null)

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    startX.current = e.clientX
    startY.current = e.clientY
    startedAt.current = Date.now()
    dragging.current = false
    claimed.current = false
    setReleasing(false)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (startX.current == null) return
    const moved = e.clientX - startX.current
    const drift = e.clientY - startY.current

    if (!dragging.current) {
      const across = Math.abs(moved)
      const down = Math.abs(drift)
      // Plainly a scroll: hand it back and stop watching until the next touch.
      if (down > GIVE_UP_PX && across < down * AXIS_LEAD) {
        startX.current = null
        return
      }
      // Not yet enough to call either way — wait for the next sample rather than guessing.
      if (across < CLAIM_PX || across < down * AXIS_LEAD) return
      dragging.current = true
      claimed.current = true
      e.currentTarget.setPointerCapture(e.pointerId)
      setArriving(null)
    }

    setDx(moved)
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const from = startX.current
    startX.current = null
    if (!dragging.current || from == null) return
    dragging.current = false

    const moved = e.clientX - from
    const width = cells.current?.getBoundingClientRect().width ?? 0
    const flicked = Date.now() - startedAt.current < FLICK_MS && Math.abs(moved) > FLICK_PX
    const far = width > 0 && Math.abs(moved) > width * SETTLE_FRACTION

    if (flicked || far) {
      // Left takes the month forward, the way the page under a finger dragged leftwards would.
      const delta = moved < 0 ? 1 : -1
      // No spring back: the grid snaps to centre with no transition and the month that replaced it
      // animates in from the side the finger was heading, so one movement continues into the other.
      setDx(0)
      turn(delta)
      setArriving(delta > 0 ? 'forward' : 'back')
      return
    }

    setReleasing(true)
    setDx(0)
  }

  const onPointerCancel = () => {
    startX.current = null
    if (!dragging.current) return
    dragging.current = false
    setReleasing(true)
    setDx(0)
  }

  return {
    /** Whether the gesture that just ended was a swipe rather than a tap. */
    swiped: () => claimed.current,
    /** Spread on the grid frame: the whole month, weekday letters included, is the swipe surface. */
    surface: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
    /** Spread on the cells, which are the part that actually moves. */
    cells: {
      ref: cells,
      className:
        'ml-calgrid__cells' +
        (releasing ? ' ml-calgrid__cells--releasing' : '') +
        (arriving ? ` ml-calgrid__cells--from-${arriving}` : ''),
      style: dx ? { transform: `translateX(${dx * DRAG_FOLLOW}px)` } : undefined,
      onTransitionEnd: () => setReleasing(false),
      onAnimationEnd: () => setArriving(null),
    },
  }
}

/**
 * The mark row under a month-grid numeral: at most one 13px icon, plus a 6×2 rule for every event
 * beyond it. A day whose events resolve to no mark still carries the rule — otherwise an unmarked
 * calendar would render a busy Tuesday as an empty one.
 */
function DayMarks({ marks }: { marks?: { mark: ResolvedMark | null; drawn: number } }) {
  // The row keeps its 14px whether or not the day has anything in it, so every numeral in the month
  // sits on the same line.
  const drawn = marks?.drawn ?? 0
  return (
    <span className="ml-calcell__marks" aria-hidden="true">
      {marks?.mark?.icon && <Icon id={marks.mark.icon} size="0.8125rem" className={markClass(marks.mark, 'ml-mark--grid')} />}
      {drawn > 0 && (drawn > 1 || !marks?.mark) && <span className="ml-calcell__rule" />}
    </span>
  )
}

/** Tone classes: a title-inferred mark renders grey, medical terracotta, everything else brass. */
function markClass(mark: ResolvedMark, extra?: string): string {
  return (
    'ml-mark' +
    (extra ? ` ${extra}` : '') +
    (mark.source === 'inferred' ? ' ml-mark--inferred' : '') +
    (mark.key === 'medical' ? ' ml-mark--medical' : '')
  )
}

/** The 26px mark slot that leads every agenda row; an unmarked event keeps its place with a diamond. */
function AgendaMark({ mark }: { mark: ResolvedMark }) {
  return (
    <span className="ml-agenda__mark" aria-hidden="true">
      {mark.icon ? (
        <Icon id={mark.icon} size="1.375rem" className={markClass(mark)} />
      ) : (
        <span className="ml-agenda__nomark" />
      )}
    </span>
  )
}

function AgendaRow({
  event,
  mark,
  profiles,
  onClick,
}: {
  event: CalendarEventDto
  mark: ResolvedMark
  profiles: ProfileDto[]
  onClick: () => void
}) {
  const start = formatTime(new Date(event.startUtc))
  const owners = profiles.filter((p) => event.ownerIds.includes(p.id))
  const allDay = isAllDay(event)
  const meta = markMeta(event, mark)
  return (
    <button className="ml-row ml-row--tappable ml-agenda" onClick={onClick} type="button">
      <AgendaMark mark={mark} />
      <span className="ml-agenda__time serif">
        {allDay ? (
          <span className="ml-agenda__allday">All day</span>
        ) : (
          <>
            {start.time}
            <span className="ml-agenda__ampm">{start.ampm}</span>
          </>
        )}
      </span>
      <div className="ml-row__main">
        <div className="ml-row__title ml-clamp2">{event.title}</div>
        {event.location && <div className="ml-row__sub">{event.location}</div>}
        {meta && <div className="ml-agenda__meta">{meta}</div>}
        {/* Where this engagement came from, under its own sub-line. No badge and no fill: it is a
            quiet fact about the row, not a status somebody has to act on — and it stays whether or
            not the picture itself survived, because how an engagement reached the calendar is not a
            claim about bytes. */}
        {event.fromPhoto && (
          <div className="ml-agenda__source">
            <Icon id="ico-image" size="0.8125rem" />
            <span>From a photo</span>
          </div>
        )}
      </div>
      {/* A guess is still labelled as one. The converse badge — crediting Google when it stated the
          kind itself — was dropped: a birthday that is right needs no citation, and the row is
          narrow enough that the label cost more than it explained. */}
      {mark.source === 'inferred' && <span className="ml-agenda__chip">Inferred</span>}
      <div className="ml-agenda__owners">
        {owners.map((o) => (
          <span key={o.id} className="ml-ownerchip">{o.initial}</span>
        ))}
      </div>
    </button>
  )
}
