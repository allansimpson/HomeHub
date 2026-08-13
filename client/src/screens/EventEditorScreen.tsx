import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { MarkBox, MarkPicker, ScreenShell } from '../components'
import { Icon } from '../icons/Icon'
import { useSession } from '../app/SessionProvider'
import { useCalendar } from '../app/CalendarProvider'
import { useWriteQueue } from '../app/WriteQueueProvider'
import { api, ApiError } from '../api/client'
import type { SyncCalendarDto } from '../api/types'
import { allDayBounds, formatTime, snapMinutes, monthName } from '../app/dates'
import { localDay } from '../app/eventDrafts'
import { markDefinition } from '../app/calendarMarks'
import {
  NothingToTake, PhotoOffer, ReadFromPhotoRow, ReadFromSheet, ReadingBlock, SourceStrip, TakeUndo,
} from './FormPhoto'
import { useFormPhoto } from './useFormPhoto'
import type { FormField } from '../app/formFill'
import { FIELD_NAMES } from '../app/formFill'
import type { EventDraft } from '../app/eventDrafts'
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
 * What the confirm sheet's EDIT hands over: an engagement read off a photograph, and the photograph.
 *
 * The sheet is a confirmation, not an editor — a flyer that needs real correcting needs the screen
 * built for correcting, which is this one. The photo travels with it so an engagement that took the
 * long way round still keeps its source and still says FROM A PHOTO.
 */
interface PhotoHandoff {
  draft: {
    title: string
    date: string
    allDay: boolean
    begins: number | null
    ends: number | null
    where: string
    note: string
  }
  photo: { base64: string | null; takenAt: string | null }
}

/** A local date and a minutes-past-midnight, as one instant on this device. */
function at(day: Date, minutes: number): Date {
  const when = new Date(day)
  when.setHours(0, minutes, 0, 0)
  return when
}

/**
 * New / Edit Event (spec 10): fully touch-driven — big day/time steppers and WHO chips, no
 * dropdowns. Full-screen over the calendar. Save/Cancel in the header; Edit mode adds Delete.
 */
export function EventEditorScreen() {
  const navigate = useNavigate()
  const { id } = useParams()
  const [searchParams] = useSearchParams()
  const { state } = useLocation()
  const editId = id ? Number(id) : null
  /*
   * Read once, on the first render, and never again — this is a starting point rather than a binding.
   * Re-reading it would undo whatever somebody had typed since, every time the router re-rendered
   * this screen for an unrelated reason.
   */
  const [handoff] = useState<PhotoHandoff | null>(() => (state as PhotoHandoff | null)?.draft ? (state as PhotoHandoff) : null)
  const { profiles, activeProfileId } = useSession()
  const { refresh } = useCalendar()
  const { run } = useWriteQueue()

  const [title, setTitle] = useState(() => handoff?.draft.title ?? '')
  const [start, setStart] = useState<Date>(() => (
    handoff ? at(localDay(handoff.draft.date), handoff.draft.begins ?? 10 * 60) : initialStart(searchParams.get('date'))
  ))
  const [end, setEnd] = useState<Date>(() => (
    handoff
      ? at(localDay(handoff.draft.date), handoff.draft.ends ?? (handoff.draft.begins ?? 10 * 60) + 60)
      : new Date(initialStart(searchParams.get('date')).getTime() + 60 * 60_000)
  ))
  /**
   * Whole days rather than an hour of one.
   *
   * Its own field rather than a shape read off the times, because the two are different statements:
   * an event that happens to run midnight to midnight is not the same as one the household said had
   * no hour in it, and only the declared one may reach Google as a bare date.
   */
  const [allDay, setAllDay] = useState(() => handoff?.draft.allDay ?? false)
  const [ownerIds, setOwnerIds] = useState<number[]>([])
  const [location, setLocation] = useState(() => handoff?.draft.where ?? '')
  const [notes, setNotes] = useState(() => handoff?.draft.note ?? '')
  const [version, setVersion] = useState(1)
  const [saving, setSaving] = useState(false)
  const [pickingDate, setPickingDate] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const bindHold = useHoldRepeat()

  /*
   * Which rows the household has actually written in.
   *
   * <b>Touched, not non-empty.</b> This form opens with today's date and next-o'clock already in
   * its rows, so "has a value" would describe every time field on a form nobody has typed into —
   * and a reading would be reduced to offering back what it had just read. A default is not
   * somebody's answer; only an edit is. See `app/formFill`.
   */
  const [touched, setTouched] = useState<Set<FormField>>(new Set())
  /** What a taken date or hour replaced, kept as an instant so UNDO restores it exactly. */
  const undoValues = useRef<Partial<Record<FormField, Date>>>({})
  const mark_ = useCallback((field: FormField) => setTouched((cur) => new Set(cur).add(field)), [])

  /** Apply the fields a reading is allowed to write — see the merge rule. */
  const applyFill = useCallback((draft: EventDraft, fields: readonly FormField[]) => {
    const day = draft.date
    for (const field of fields) {
      if (field === 'title') setTitle(draft.title)
      if (field === 'where') setLocation(draft.where)
      if (field === 'note') setNotes(draft.note)
      if (field === 'kind') setAllDay(draft.allDay)
      if (field === 'date') {
        setStart((s) => at(day, s.getHours() * 60 + s.getMinutes()))
        setEnd((e) => at(day, e.getHours() * 60 + e.getMinutes()))
      }
      if (field === 'begins' && draft.begins !== null) setStart(at(day, draft.begins))
      if (field === 'ends' && draft.ends !== null) setEnd(at(day, draft.ends))
    }
  }, [])

  const photo = useFormPhoto(applyFill)
  const untouched = touched.size === 0 && photo.stage === 'idle'

  /** What a held-back value reads as under its row. */
  const offerLabel = useCallback((field: FormField): string => {
    const d = photo.draft
    if (!d) return ''
    if (field === 'title') return d.title
    if (field === 'where') return d.where
    if (field === 'note') return d.note
    if (field === 'kind') return d.allDay ? 'All day' : 'Timed'
    if (field === 'date') return dateLabel(d.date)
    const minutes = field === 'begins' ? d.begins : d.ends
    if (minutes === null) return ''
    const t = formatTime(at(d.date, minutes))
    return `${t.time} ${t.ampm}`
  }, [photo.draft])

  /** Accept one offer: apply it, remember what it replaced so UNDO can put it back. */
  const takeOffer = useCallback((field: FormField) => {
    if (!photo.draft) return
    undoValues.current[field] =
      field === 'date' ? new Date(start) : field === 'begins' ? new Date(start) : field === 'ends' ? new Date(end) : undefined
    const previous =
      field === 'title' ? title
      : field === 'where' ? location
      : field === 'note' ? notes
      : field === 'kind' ? (allDay ? 'All day' : 'Timed')
      : field === 'date' ? dateLabel(start)
      : field === 'begins' ? `${formatTime(start).time} ${formatTime(start).ampm}`
      : `${formatTime(end).time} ${formatTime(end).ampm}`
    applyFill(photo.draft, [field])
    photo.take(field, previous)
  }, [photo, applyFill, title, location, notes, allDay, start, end])

  /**
   * Put back what a TAKE IT replaced (screen 24).
   *
   * Per take, not per photo — each accepted value is its own small decision, and undoing one must
   * not disturb the others. The label is what the row read before, which is enough to restore every
   * field this path can offer.
   */
  const undoTake = useCallback((field: FormField, previous: string) => {
    if (field === 'title') { setTitle(previous); return }
    if (field === 'where') { setLocation(previous); return }
    if (field === 'note') { setNotes(previous); return }
    if (field === 'kind') { setAllDay(previous === 'All day'); return }
    // Dates and hours are restored from the values they were parsed out of rather than re-parsed
    // from a label — see `undoValues`, filled at the moment the offer was taken.
    const held = undoValues.current[field]
    if (!held) return
    if (field === 'date') { setStart(held); setEnd(new Date(held.getTime() + (end.getTime() - start.getTime()))) }
    if (field === 'begins') setStart(held)
    if (field === 'ends') setEnd(held)
  }, [end, start])

  const offering = (field: FormField) =>
    photo.offers.includes(field) ? <PhotoOffer value={offerLabel(field)} onTake={() => takeOffer(field)} /> : null

  /** Amber marks a value that was read poorly or filled by rule — the same treatment as the sheet. */
  const amberOn = (field: 'title' | 'date' | 'begins' | 'ends' | 'where') =>
    photo.amber.has(field) && !touched.has(field) ? ' ml-evt__amber' : ''

  /** The event's own mark, overriding its kind and its calendar's; null to inherit. */
  const [mark, setMark] = useState<string | null>(null)
  const [pickingMark, setPickingMark] = useState(false)

  /** Where this engagement came from, when it came off a photograph. Null for a typed one. */
  const [source, setSource] = useState<EventSource | null>(null)

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
        setAllDay(e.isAllDay)
        setOwnerIds(e.ownerIds)
        setLocation(e.location ?? '')
        setNotes(e.notes ?? '')
        setVersion(e.version)
        setMark(e.mark)
        setCalendarId(e.googleCalendarId)
        setCalendarName(e.calendarName)
        setSource(e.fromPhoto ? { hasPhoto: e.hasPhoto, takenUtc: e.photoTakenUtc, addedUtc: e.createdUtc } : null)
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
    // An all-day event is written as whole local days, not as the hours the steppers happen to be
    // holding — those are kept untouched so switching back to TIMED restores what was there.
    const bounds = allDay ? allDayBounds(start) : { startUtc: start.toISOString(), endUtc: end.toISOString() }
    const input = {
      title: title.trim(),
      ...bounds,
      isAllDay: allDay,
      location: location.trim() || null,
      notes: notes.trim() || null,
      ownerIds,
      // New events are created on the active profile's Google account (per-profile calendars).
      profileId: activeProfileId ?? null,
      mark,
      // Only on the way in from a photograph. An engagement corrected here still came off one, and
      // the provenance is a fact about the event rather than about which screen finished it.
      // Read on this screen, or handed over from the confirm sheet's EDIT — either way the
      // photograph is stored by the press that writes the engagement, never by the reading.
      ...(editId == null && photo.photo?.base64
        ? { photoBase64: photo.photo.base64, photoTakenUtc: photo.photo.takenAt, fromPhoto: true }
        : handoff && editId == null
          ? { photoBase64: handoff.photo.base64, photoTakenUtc: handoff.photo.takenAt, fromPhoto: true }
          : {}),
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
  }, [title, start, end, allDay, location, notes, ownerIds, activeProfileId, mark, calendarId, editId, version, saving, handoff, photo.photo, run, refresh, navigate])

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
        {/* The photo affordance, and whatever it turned into.

            Only on a new engagement: an event that already exists was written by somebody, and
            offering to re-read it off a picture is a different act than filling a blank form. */}
        {editId == null && (
          <>
            {untouched && photo.stage === 'idle' && <ReadFromPhotoRow onOpen={photo.open} />}
            {photo.stage === 'reading' && <ReadingBlock preview={photo.photo?.preview ?? null} />}
            {photo.stage === 'none' && (
              <NothingToTake message={photo.refusal} onAnother={photo.open} onDismiss={photo.dismiss} />
            )}
            {photo.stage === 'filled' && (
              <>
                <SourceStrip
                  preview={photo.photo?.preview ?? null}
                  summary={photo.summary}
                  onReplace={photo.replace}
                />
                {photo.undoable && (
                  <TakeUndo
                    field={FIELD_NAMES[photo.undoable.field]}
                    onUndo={() => {
                      undoTake(photo.undoable!.field, photo.undoable!.label)
                      photo.clearUndo()
                    }}
                  />
                )}
              </>
            )}
          </>
        )}

        {/* TITLE — stacked, Marcellus value + brass caret */}
        <div className="ml-evt__row ml-evt__row--stacked">
          <span className="ml-evt__label">Title</span>
          <span className="ml-evt__titlewrap">
            <input
              className="ml-evt__title serif"
              value={title}
              placeholder="Add a title…"
              onChange={(e) => { setTitle(e.target.value); mark_('title') }}
              autoFocus={editId == null}
            />
            <span className="ml-evt__caret" aria-hidden="true" />
          </span>
          {offering('title')}
        </div>

        {/* DATE — ◂ / value / ▸ */}
        <div className="ml-evt__row">
          <span className="ml-evt__label">Date</span>
          <span className="ml-evt__ctrl">
            <button type="button" className="ml-evt__stepbtn" aria-label="Previous day (hold to scrub)" {...bindHold(() => { shiftDay(-1); mark_('date') })}>◂</button>
            <button
              type="button"
              className={'ml-evt__value serif' + amberOn('date')}
              onClick={() => setPickingDate((v) => !v)}
              aria-expanded={pickingDate}
            >
              {dateLabel(start)}
            </button>
            <button type="button" className="ml-evt__stepbtn" aria-label="Next day (hold to scrub)" {...bindHold(() => { shiftDay(1); mark_('date') })}>▸</button>
          </span>
          {offering('date')}
        </div>
        {pickingDate && (
          <MonthGridPicker selected={start} onPick={setDateTo} onClose={() => setPickingDate(false)} />
        )}

        {/* KIND — timed or whole-day. Collapses BEGINS and ENDS out when ALL DAY is lit, because an
            all-day engagement has no begin and no finish to show; the steppers keep their values so
            switching back restores them rather than inventing an hour. */}
        <div className="ml-evt__row">
          <span className="ml-evt__label">Kind</span>
          <span className="ml-evt__kind">
            <button
              type="button"
              className={'ml-chip' + (allDay ? '' : ' ml-chip--active')}
              onClick={() => { setAllDay(false); mark_('kind') }}
              aria-pressed={!allDay}
            >
              Timed
            </button>
            <button
              type="button"
              className={'ml-chip' + (allDay ? ' ml-chip--active' : '')}
              onClick={() => { setAllDay(true); mark_('kind') }}
              aria-pressed={allDay}
            >
              All day
            </button>
          </span>
          {offering('kind')}
        </div>

        {/* BEGINS / ENDS — − / value / + at the same width so the columns line up */}
        {!allDay && (
        <>
        <div className="ml-evt__row">
          <span className="ml-evt__label">Begins</span>
          <span className="ml-evt__ctrl">
            <button type="button" className="ml-evt__stepbtn ml-evt__stepbtn--pm" aria-label="Earlier start" {...bindHold(() => { shiftStart(-STEP); mark_('begins') })}>−</button>
            <span className={'ml-evt__value serif' + amberOn('begins')}>{startT.time}<span className="ml-evt__ampm">{startT.ampm}</span></span>
            <button type="button" className="ml-evt__stepbtn ml-evt__stepbtn--pm" aria-label="Later start" {...bindHold(() => { shiftStart(STEP); mark_('begins') })}>+</button>
          </span>
          {offering('begins')}
        </div>
        <div className="ml-evt__row">
          <span className="ml-evt__label">Ends</span>
          <span className="ml-evt__ctrl">
            <button type="button" className="ml-evt__stepbtn ml-evt__stepbtn--pm" aria-label="Earlier end" {...bindHold(() => { shiftEnd(-STEP); mark_('ends') })}>−</button>
            <span className={'ml-evt__value serif' + amberOn('ends')}>{endT.time}<span className="ml-evt__ampm">{endT.ampm}</span></span>
            <button type="button" className="ml-evt__stepbtn ml-evt__stepbtn--pm" aria-label="Later end" {...bindHold(() => { shiftEnd(STEP); mark_('ends') })}>+</button>
          </span>
          {offering('ends')}
        </div>
        </>
        )}

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
          <input
            className={'ml-evt__where' + amberOn('where')}
            value={location}
            placeholder="Add a location…"
            onChange={(e) => { setLocation(e.target.value); mark_('where') }}
          />
          {offering('where')}
        </div>

        {/* NOTE — open multi-line block closed by a hairline */}
        <div className="ml-evt__row ml-evt__row--stacked">
          <span className="ml-evt__label">Note</span>
          <textarea className="ml-evt__note" value={notes} placeholder="Add a note…" onChange={(e) => { setNotes(e.target.value); mark_('note') }} />
          {offering('note')}
        </div>

        {/* SOURCE — the photograph this engagement was read off (screens 13 and 14). Only ever drawn
            for an engagement that came off one; a typed engagement has no source to state. */}
        {editId != null && source && <SourceBlock eventId={editId} source={source} />}

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

      {/* Over the form at reduced opacity, dismissed by NEVER MIND only — the same kiosk rule the
          confirm sheet follows. */}
      {photo.stage === 'picking' && (
        <ReadFromSheet
          onPick={(file) => { void photo.read(file, touched) }}
          onCancel={photo.close}
        />
      )}
    </ScreenShell>
  )
}

/** What an engagement read off a photograph knows about where it came from. */
interface EventSource {
  /** Whether the picture itself is still there to show. */
  hasPhoto: boolean
  /** EXIF `DateTimeOriginal`, or null for a screenshot. Decides TAKEN against ADDED. */
  takenUtc: string | null
  /** When the engagement was written down. The ADDED form's date. */
  addedUtc: string | null
}

/** "12 Aug". */
function sourceDay(iso: string): string {
  const d = new Date(iso)
  return `${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'short' })}`
}

/**
 * SOURCE — the photograph an engagement was read off (screens 13 and 14).
 *
 * <b>Two label forms, and the difference is not cosmetic.</b> A camera photo carries an EXIF original
 * date, so the block can say when somebody pointed a camera at the flyer: TAKEN. A screenshot of a
 * text message carries none — and a screenshot of a text was one of the three inputs this feature was
 * asked for — so that case says ADDED and means it, rather than passing off a file's timestamp as a
 * moment of photography.
 *
 * <b>And two shapes.</b> When nothing was kept — an unrenderable format, retention switched off in
 * Config, or a file since removed — this is a plain row saying so, never an image frame with nothing
 * in it. A broken frame reads as a failure to load and invites somebody to reload a screen that is
 * already showing them everything it has.
 */
function SourceBlock({ eventId, source }: { eventId: number; source: EventSource }) {
  const stamp = source.takenUtc ?? source.addedUtc
  const label = stamp
    ? `${source.takenUtc ? 'Taken' : 'Added'} ${sourceDay(stamp)} · read by Barnaby`
    : 'Read by Barnaby'

  if (!source.hasPhoto) {
    return (
      <div className="ml-evt__row">
        <span className="ml-evt__label">Source</span>
        <span className="ml-evt__stated">Read from a photo · not kept</span>
      </div>
    )
  }

  return (
    <div className="ml-evt__row ml-evt__row--stacked">
      <span className="ml-evt__label">Source</span>
      <span className="ml-evt__sourcelabel">{label}</span>
      <img className="ml-evt__sourcephoto" src={api.eventPhotoUrl(eventId)} alt="The photograph this engagement was read from" />
    </div>
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
