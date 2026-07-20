import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ScreenShell, ScrollArea, SectionLabel, BackButton } from '../components'
import { Icon } from '../icons/Icon'
import { useSession } from '../app/SessionProvider'
import { api, ApiError } from '../api/client'
import type { CalendarEventDto, ProfileDto } from '../api/types'
import { addMonths, dayKey, formatTime, isSameDay, monthGrid, monthName, startOfMonth, weekdayName } from '../app/dates'

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

/**
 * Calendar (spec 02): month grid + the selected day's agenda. Today is a brass block; days with
 * events get a brass dash. The header + opens the event editor; tapping an agenda row edits it.
 */
export function CalendarScreen() {
  const navigate = useNavigate()
  const { profiles } = useSession()
  const [activeMonth, setActiveMonth] = useState(() => startOfMonth(new Date()))
  const [selected, setSelected] = useState(() => new Date())
  const [events, setEvents] = useState<CalendarEventDto[]>([])

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
  }, [load])

  const eventDays = useMemo(() => new Set(events.map((e) => dayKey(new Date(e.startUtc)))), [events])
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
      <BackButton onClick={() => navigate('/')} />
      <span className="ml-cal-header__month serif">{monthName(activeMonth).toUpperCase()}</span>
      <span className="ml-cal-header__year serif">{activeMonth.getFullYear()}</span>
      <div className="ml-cal-header__actions">
        <button type="button" className="ml-iconbtn" onClick={() => setActiveMonth(addMonths(activeMonth, -1))} aria-label="Previous month">
          <Icon id="ico-back" size="1.125rem" />
        </button>
        <button type="button" className="ml-iconbtn" onClick={() => setActiveMonth(addMonths(activeMonth, 1))} aria-label="Next month">
          <Icon id="ico-chevron-right" size="1.125rem" />
        </button>
        <button type="button" className="ml-iconbtn ml-iconbtn--accent" onClick={() => navigate('/calendar/new')} aria-label="New event">
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
            const hasEvents = eventDays.has(dayKey(day))
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
                {hasEvents && <span className="ml-calcell__dot" aria-hidden="true" />}
              </button>
            )
          })}
        </div>
      </div>

      <SectionLabel
        label={`${weekdayName(selected)} ${selected.getDate()}${isSameDay(selected, today) ? ' — Today' : ''}`}
        status={`${agenda.length} ${agenda.length === 1 ? 'engagement' : 'engagements'}`}
      />
      <ScrollArea>
        {agenda.length === 0 ? (
          <div className="ml-cal-empty">Nothing scheduled</div>
        ) : (
          agenda.map((e) => (
            <AgendaRow key={e.id} event={e} profiles={profiles} onClick={() => navigate(`/calendar/edit/${e.id}`)} />
          ))
        )}
      </ScrollArea>
    </ScreenShell>
  )
}

function AgendaRow({ event, profiles, onClick }: { event: CalendarEventDto; profiles: ProfileDto[]; onClick: () => void }) {
  const start = formatTime(new Date(event.startUtc))
  const owners = profiles.filter((p) => event.ownerIds.includes(p.id))
  return (
    <button className="ml-row ml-row--tappable ml-agenda" onClick={onClick} type="button">
      <span className="ml-agenda__time serif">
        {start.time}
        <span className="ml-agenda__ampm">{start.ampm}</span>
      </span>
      <div className="ml-row__main">
        <div className="ml-row__title">{event.title}</div>
        {event.location && <div className="ml-row__sub">{event.location}</div>}
      </div>
      <div className="ml-agenda__owners">
        {owners.map((o) => (
          <span key={o.id} className="ml-ownerchip">{o.initial}</span>
        ))}
      </div>
    </button>
  )
}
