import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { MarkBox, MarkPicker, ScreenShell } from '../components'
import { Icon } from '../icons/Icon'
import { useSession } from '../app/SessionProvider'
import { useCalendar } from '../app/CalendarProvider'
import { useWriteQueue } from '../app/WriteQueueProvider'
import { api, ApiError } from '../api/client'
import type { SyncCalendarDto } from '../api/types'
import { formatTime, snapMinutes, monthName } from '../app/dates'
import { markDefinition } from '../app/calendarMarks'
import type { MarkKey } from '../app/calendarMarks'

const STEP = 15 // minutes

function nextHour(): Date {
  const d = new Date()
  d.setMinutes(0, 0, 0)
  d.setHours(d.getHours() + 1)
  return d
}

/** DATE field value, e.g. "Thu · 16 Jul". */
function dateLabel(d: Date): string {
  const wd = d.toLocaleDateString('en-US', { weekday: 'short' })
  const mon = d.toLocaleDateString('en-US', { month: 'short' })
  return `${wd} · ${d.getDate()} ${mon}`
}

/**
 * Start time for a new event: the next hour, moved onto the day the calendar had selected
 * (`?date=YYYY-MM-DD`). Without the param — e.g. opened from the dashboard — it stays on today.
 */
function initialStart(dateParam: string | null): Date {
  const base = nextHour()
  const [y, m, d] = (dateParam ?? '').split('-').map(Number)
  if (!y || !m || !d) return base
  base.setFullYear(y, m - 1, d)
  return base
}

/**
 * New / Edit Event (spec 10): fully touch-driven — big day/time steppers and WHO chips, no
 * dropdowns. Full-screen over the calendar. Save/Cancel in the header; Edit mode adds Delete.
 */
export function EventEditorScreen() {
  const navigate = useNavigate()
  const { id } = useParams()
  const [searchParams] = useSearchParams()
  const editId = id ? Number(id) : null
  const { profiles, activeProfileId } = useSession()
  const { refresh } = useCalendar()
  const { run } = useWriteQueue()

  const [title, setTitle] = useState('')
  const [start, setStart] = useState<Date>(() => initialStart(searchParams.get('date')))
  const [end, setEnd] = useState<Date>(() => new Date(initialStart(searchParams.get('date')).getTime() + 60 * 60_000))
  const [ownerIds, setOwnerIds] = useState<number[]>([])
  const [location, setLocation] = useState('')
  const [notes, setNotes] = useState('')
  const [version, setVersion] = useState(1)
  const [saving, setSaving] = useState(false)
  const [pickingDate, setPickingDate] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const bindHold = useHoldRepeat()

  /** The event's own mark, overriding its kind and its calendar's; null to inherit. */
  const [mark, setMark] = useState<string | null>(null)
  const [pickingMark, setPickingMark] = useState(false)

  /**
   * Which calendar a new event is written to. Null means the account's primary — the same default
   * the server applies, so an unlinked panel behaves exactly as before.
   */
  const [calendarId, setCalendarId] = useState<string | null>(null)
  const [calendars, setCalendars] = useState<SyncCalendarDto[]>([])
  const [calendarName, setCalendarName] = useState<string | null>(null)

  // Offer only calendars this account may write to *and* has chosen to display: an event written to
  // a hidden calendar would vanish the moment it saved, and a read-only one refuses it outright.
  useEffect(() => {
    if (activeProfileId == null) {
      setCalendars([])
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const all = await api.getCalendars(activeProfileId)
        if (cancelled) return
        const writable = all.filter((c) => c.selected && c.canWrite)
        setCalendars(writable)
        // Show the default rather than leaving it implied: a new event starts on the account's
        // primary calendar, which is exactly what an unset target resolves to server-side.
        setCalendarId((cur) => cur ?? writable.find((c) => c.isPrimary)?.calendarId ?? null)
      } catch (err) {
        if (!(err instanceof ApiError)) throw err
        if (!cancelled) setCalendars([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeProfileId])

  useEffect(() => {
    if (editId == null) return
    let cancelled = false
    ;(async () => {
      try {
        const e = await api.getEvent(editId)
        if (cancelled) return
        setTitle(e.title)
        setStart(new Date(e.startUtc))
        setEnd(new Date(e.endUtc))
        setOwnerIds(e.ownerIds)
        setLocation(e.location ?? '')
        setNotes(e.notes ?? '')
        setVersion(e.version)
        setMark(e.mark)
        setCalendarId(e.googleCalendarId)
        setCalendarName(e.calendarName)
      } catch (err) {
        if (!(err instanceof ApiError)) throw err
      }
    })()
    return () => {
      cancelled = true
    }
  }, [editId])

  const shiftDay = useCallback((delta: number) => {
    setStart((s) => { const n = new Date(s); n.setDate(n.getDate() + delta); return n })
    setEnd((e) => { const n = new Date(e); n.setDate(n.getDate() + delta); return n })
  }, [])

  // Jump start/end to a picked calendar day, preserving each end's time-of-day.
  const setDateTo = useCallback((day: Date) => {
    setStart((s) => { const n = new Date(day); n.setHours(s.getHours(), s.getMinutes(), 0, 0); return n })
    setEnd((e) => { const n = new Date(day); n.setHours(e.getHours(), e.getMinutes(), 0, 0); return n })
  }, [])

  const shiftStart = (deltaMin: number) => {
    setStart((s) => {
      const n = snapMinutes(new Date(s.getTime() + deltaMin * 60_000), STEP)
      setEnd((e) => (e.getTime() <= n.getTime() ? new Date(n.getTime() + STEP * 60_000) : e))
      return n
    })
  }

  const shiftEnd = (deltaMin: number) => {
    setEnd((e) => {
      const n = snapMinutes(new Date(e.getTime() + deltaMin * 60_000), STEP)
      return n.getTime() <= start.getTime() ? new Date(start.getTime() + STEP * 60_000) : n
    })
  }

  const toggleOwner = (pid: number) =>
    setOwnerIds((cur) => (cur.includes(pid) ? cur.filter((x) => x !== pid) : [...cur, pid]))

  const allSelected = profiles.length > 0 && profiles.every((p) => ownerIds.includes(p.id))
  const toggleAll = () => setOwnerIds(allSelected ? [] : profiles.map((p) => p.id))

  const save = useCallback(async () => {
    if (!title.trim() || saving) return
    setSaving(true)
    const input = {
      title: title.trim(),
      startUtc: start.toISOString(),
      endUtc: end.toISOString(),
      location: location.trim() || null,
      notes: notes.trim() || null,
      ownerIds,
      // New events are created on the active profile's Google account (per-profile calendars).
      profileId: activeProfileId ?? null,
      mark,
    }
    // Route through the offline write-queue: succeeds now, queues if offline, surfaces conflicts.
    if (editId == null) {
      // The target calendar is a create-time decision; moving an existing event between calendars is
      // a Google operation the panel does not perform, so edit leaves it where it is.
      await run({
        domain: 'calendar',
        method: 'POST',
        path: '/calendar/events',
        body: { ...input, googleCalendarId: calendarId },
        label: `Add “${input.title}”`,
      })
    } else {
      await run({ domain: 'calendar', method: 'PUT', path: `/calendar/events/${editId}`, body: input, baseVersion: version, label: `Edit “${input.title}”` })
    }
    await refresh()
    navigate('/calendar')
  }, [title, start, end, location, notes, ownerIds, activeProfileId, mark, calendarId, editId, version, saving, run, refresh, navigate])

  const remove = useCallback(async () => {
    if (editId == null) return
    await run({ domain: 'calendar', method: 'DELETE', path: `/calendar/events/${editId}`, baseVersion: version, label: `Delete “${title}”` })
    await refresh()
    navigate('/calendar')
  }, [editId, version, title, run, refresh, navigate])

  const startT = formatTime(start)
  const endT = formatTime(end)
  const markDef = markDefinition(mark)

  if (pickingMark) {
    return (
      <MarkPicker
        subject={title.trim() || 'this engagement'}
        value={mark}
        sample={`${title.trim() || 'New engagement'} · ${startT.time} ${startT.ampm}`}
        noneLabel="Inherit"
        showLocked={false}
        note="A mark chosen here belongs to this engagement alone, and replaces whatever its kind or its calendar would have given it. Inherit puts it back."
        onCancel={() => setPickingMark(false)}
        onSave={(next: MarkKey) => {
          setMark(next === 'none' ? null : next)
          setPickingMark(false)
        }}
      />
    )
  }

  const header = (
    <header className="ml-header ml-editor-header">
      <button type="button" className="ml-editor-header__cancel" onClick={() => navigate('/calendar')}>
        Cancel
      </button>
      <span className="ml-editor-header__title serif">{editId == null ? 'NEW ENGAGEMENT' : 'EDIT ENGAGEMENT'}</span>
      <button type="button" className="ml-editor-header__save" onClick={save} disabled={!title.trim() || saving}>
        Save
      </button>
    </header>
  )

  return (
    // A modal over Calendar, but the standard nav stays (CALENDAR lit); no avatar, no back button.
    <ScreenShell header={header} avatar={false}>
      <div className="ml-editor">
        {/* TITLE — stacked, Marcellus value + brass caret */}
        <div className="ml-evt__row ml-evt__row--stacked">
          <span className="ml-evt__label">Title</span>
          <span className="ml-evt__titlewrap">
            <input
              className="ml-evt__title serif"
              value={title}
              placeholder="Add a title…"
              onChange={(e) => setTitle(e.target.value)}
              autoFocus={editId == null}
            />
            <span className="ml-evt__caret" aria-hidden="true" />
          </span>
        </div>

        {/* DATE — ◂ / value / ▸ */}
        <div className="ml-evt__row">
          <span className="ml-evt__label">Date</span>
          <span className="ml-evt__ctrl">
            <button type="button" className="ml-evt__stepbtn" aria-label="Previous day (hold to scrub)" {...bindHold(() => shiftDay(-1))}>◂</button>
            <button
              type="button"
              className="ml-evt__value serif"
              onClick={() => setPickingDate((v) => !v)}
              aria-expanded={pickingDate}
            >
              {dateLabel(start)}
            </button>
            <button type="button" className="ml-evt__stepbtn" aria-label="Next day (hold to scrub)" {...bindHold(() => shiftDay(1))}>▸</button>
          </span>
        </div>
        {pickingDate && (
          <MonthGridPicker selected={start} onPick={setDateTo} onClose={() => setPickingDate(false)} />
        )}

        {/* BEGINS / ENDS — − / value / + at the same width so the columns line up */}
        <div className="ml-evt__row">
          <span className="ml-evt__label">Begins</span>
          <span className="ml-evt__ctrl">
            <button type="button" className="ml-evt__stepbtn ml-evt__stepbtn--pm" aria-label="Earlier start" {...bindHold(() => shiftStart(-STEP))}>−</button>
            <span className="ml-evt__value serif">{startT.time}<span className="ml-evt__ampm">{startT.ampm}</span></span>
            <button type="button" className="ml-evt__stepbtn ml-evt__stepbtn--pm" aria-label="Later start" {...bindHold(() => shiftStart(STEP))}>+</button>
          </span>
        </div>
        <div className="ml-evt__row">
          <span className="ml-evt__label">Ends</span>
          <span className="ml-evt__ctrl">
            <button type="button" className="ml-evt__stepbtn ml-evt__stepbtn--pm" aria-label="Earlier end" {...bindHold(() => shiftEnd(-STEP))}>−</button>
            <span className="ml-evt__value serif">{endT.time}<span className="ml-evt__ampm">{endT.ampm}</span></span>
            <button type="button" className="ml-evt__stepbtn ml-evt__stepbtn--pm" aria-label="Later end" {...bindHold(() => shiftEnd(STEP))}>+</button>
          </span>
        </div>

        {/* WHO — equal-width multi-select chips */}
        <div className="ml-evt__row ml-evt__row--stacked">
          <span className="ml-evt__label">Who</span>
          <span className="ml-evt__chips">
            {profiles.map((p) => (
              <button
                key={p.id}
                type="button"
                className={'ml-chip' + (ownerIds.includes(p.id) ? ' ml-chip--active' : '')}
                onClick={() => toggleOwner(p.id)}
              >
                {p.name}
              </button>
            ))}
            <button type="button" className={'ml-chip' + (allSelected ? ' ml-chip--active' : '')} onClick={toggleAll}>
              All
            </button>
          </span>
        </div>

        {/* CALENDAR — which one the event is written to. Chosen on create; stated on edit, because
            moving an event between Google calendars is not something the panel does. */}
        {editId == null
          ? calendars.length > 1 && (
              <div className="ml-evt__row ml-evt__row--stacked">
                <span className="ml-evt__label">Calendar</span>
                <span className="ml-evt__chips">
                  {calendars.map((c) => (
                    <button
                      key={c.calendarId}
                      type="button"
                      // Single-select: an event lands on exactly one calendar, so there is no
                      // "none" to toggle back to.
                      className={'ml-chip' + (calendarId === c.calendarId ? ' ml-chip--active' : '')}
                      onClick={() => setCalendarId(c.calendarId)}
                    >
                      {c.name}
                    </button>
                  ))}
                </span>
              </div>
            )
          : calendarName && (
              <div className="ml-evt__row">
                <span className="ml-evt__label">Calendar</span>
                <span className="ml-evt__stated">{calendarName}</span>
              </div>
            )}

        {/* MARK — this event's own icon, overriding its kind and its calendar's (spec 14) */}
        <div className="ml-evt__row">
          <span className="ml-evt__label">Mark</span>
          <span className="ml-evt__mark">
            <MarkBox mark={markDef} onClick={() => setPickingMark(true)} label={title.trim() || 'this engagement'} />
            <button type="button" className="ml-evt__markname" onClick={() => setPickingMark(true)}>
              {markDef?.icon ? markDef.label : 'Inherited from its kind or calendar'}
            </button>
          </span>
        </div>

        {/* WHERE — label left, plain value right */}
        <div className="ml-evt__row">
          <span className="ml-evt__label">Where</span>
          <input className="ml-evt__where" value={location} placeholder="Add a location…" onChange={(e) => setLocation(e.target.value)} />
        </div>

        {/* NOTE — open multi-line block closed by a hairline */}
        <div className="ml-evt__row ml-evt__row--stacked">
          <span className="ml-evt__label">Note</span>
          <textarea className="ml-evt__note" value={notes} placeholder="Add a note…" onChange={(e) => setNotes(e.target.value)} />
        </div>

        {editId != null && (
          <button
            type="button"
            className={'ml-editor__delete' + (confirmDelete ? ' ml-editor__delete--confirm' : '')}
            onClick={() => (confirmDelete ? void remove() : setConfirmDelete(true))}
            onBlur={() => setConfirmDelete(false)}
          >
            {confirmDelete ? 'Tap again to delete' : 'Delete engagement'}
          </button>
        )}
      </div>
    </ScreenShell>
  )
}

/** Press-and-hold repeat for the day arrows: fires once on press, then accelerates while held. */
function useHoldRepeat() {
  const timer = useRef<number | null>(null)
  const stop = useCallback(() => {
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null }
  }, [])
  useEffect(() => stop, [stop])
  return useCallback(
    (fn: () => void) => {
      const start = () => {
        fn()
        let delay = 320
        const tick = () => {
          fn()
          delay = Math.max(70, delay - 45)
          timer.current = window.setTimeout(tick, delay)
        }
        timer.current = window.setTimeout(tick, delay)
      }
      return { onPointerDown: start, onPointerUp: stop, onPointerLeave: stop, onPointerCancel: stop }
    },
    [stop],
  )
}

const DOW_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

/** Compact month grid for the DATE field (spec 10:29): tap a day to jump the event's date. */
function MonthGridPicker({ selected, onPick, onClose }: { selected: Date; onPick: (d: Date) => void; onClose: () => void }) {
  const [view, setView] = useState(() => new Date(selected.getFullYear(), selected.getMonth(), 1))
  const year = view.getFullYear()
  const month = view.getMonth()
  const startPad = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const cells: (Date | null)[] = []
  for (let i = 0; i < startPad; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d))
  const isSel = (d: Date) =>
    d.getFullYear() === selected.getFullYear() && d.getMonth() === selected.getMonth() && d.getDate() === selected.getDate()

  return (
    <div className="ml-datepicker">
      <div className="ml-datepicker__head">
        <button type="button" className="ml-iconbtn" onClick={() => setView(new Date(year, month - 1, 1))} aria-label="Previous month">
          <Icon id="ico-back" size="1.1rem" />
        </button>
        <span className="serif ml-datepicker__month">{`${monthName(view)} ${year}`}</span>
        <button type="button" className="ml-iconbtn" onClick={() => setView(new Date(year, month + 1, 1))} aria-label="Next month">
          <Icon id="ico-chevron-right" size="1.1rem" />
        </button>
      </div>
      <div className="ml-datepicker__grid">
        {DOW_INITIALS.map((d, i) => (
          <span key={`dow-${i}`} className="ml-datepicker__dow">{d}</span>
        ))}
        {cells.map((d, i) =>
          d ? (
            <button
              key={`day-${i}`}
              type="button"
              className={'ml-datepicker__day serif' + (isSel(d) ? ' ml-datepicker__day--sel' : '')}
              onClick={() => { onPick(d); onClose() }}
            >
              {d.getDate()}
            </button>
          ) : (
            <span key={`pad-${i}`} />
          ),
        )}
      </div>
    </div>
  )
}
