import { useCallback, useEffect, useMemo, useState } from 'react'
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

  const agenda = useMemo(
    () =>
      events
        .filter((e) => isSameDay(new Date(e.startUtc), selected))
        .sort((a, b) => a.startUtc.localeCompare(b.startUtc)),
    [events, selected],
  )

  const pickDay = (day: Date) => {
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
      <div className="ml-calgrid">
        <div className="ml-calgrid__dow">
          {DOW.map((d, i) => (
            <span key={i} className="ml-calgrid__dowlabel">{d}</span>
          ))}
        </div>
        <div className="ml-calgrid__cells">
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
