import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, ApiError } from '../../api/client'
import { useSession } from '../../app/SessionProvider'
import { useWriteQueue } from '../../app/WriteQueueProvider'
import {
  amber, boundsFor, canWrite, clashesWith, countWord, defaultCalendar, footnoteFor, sheetHeader,
  toDraft, writable,
} from '../../app/eventDrafts'
import type { EventDraft } from '../../app/eventDrafts'
import { addDays, formatTime } from '../../app/dates'
import type { CalendarEventDto, DraftEventDto, DraftField, SyncCalendarDto } from '../../api/types'

/** The photograph an engagement was read off, as the sheet needs it. */
export interface SheetPhoto {
  /** Base64 without a data-URL prefix — sent again with the write, because storage is a decision. */
  base64: string | null
  mediaType: string | null
  /** An object URL for VIEW SOURCE. Owned by the composer; the sheet only draws it. */
  preview: string | null
  /** EXIF `DateTimeOriginal`, read before the downscale. Null for a screenshot. */
  takenAt: string | null
}

/**
 * One engagement this sheet wrote, as the confirmation turn needs to describe and undo it.
 *
 * <b>Two shapes, because there are two ways a write can succeed.</b> One reached the server and has
 * an id; one is in the offline queue and has an op instead. Undo has to keep its promise for both,
 * and they are taken back by different means — see `AssistScreen`'s receipt.
 */
export interface WrittenEvent {
  /** The stored event's id, or null when the write is still queued. */
  id: number | null
  /** The queued op's id, or null when the write landed. */
  opId: string | null
  title: string
  startUtc: string
  isAllDay: boolean
  calendarName: string | null
}

interface Props {
  drafts: readonly DraftEventDto[]
  photo: SheetPhoto
  /** What the member typed with the photo. Read only for the calendar chip's default. */
  context: string
  /** DISCARD, and the only way out — this is a kiosk, so there is no tap-outside. */
  onDiscard: () => void
  /** ADD TO CALENDAR landed. The caller writes the confirmation turn and its receipt. */
  onAdded: (written: WrittenEvent[], photoKept: boolean) => void
  /** EDIT — hand this draft to the full New Event modal, pre-filled. */
  onEdit: (draft: EventDraft, photo: SheetPhoto) => void
}

/**
 * The confirm sheet: what was read off the photograph, before any of it is true.
 *
 * <b>The only path to a write, and deliberately the slow one.</b> Everything upstream of this is a
 * reading — a model looking at a picture of a flyer — and a reading is exactly the kind of thing that
 * is right often enough to stop being checked. So nothing reaches the calendar without somebody
 * looking at these fields, the amber ones say which values were guessed rather than printed, and the
 * clash block says what is already on that hour.
 *
 * Screens 05–09 of `design_handoff_photo_event`.
 */
export function EventConfirmSheet({ drafts, photo, context, onDiscard, onAdded, onEdit }: Props) {
  const { activeProfileId, profiles } = useSession()
  const { run } = useWriteQueue()

  const [items, setItems] = useState<EventDraft[]>(() => drafts.map(toDraft))
  const [calendars, setCalendars] = useState<SyncCalendarDto[]>([])
  const [calendarId, setCalendarId] = useState<string | null>(null)
  const [dayEvents, setDayEvents] = useState<CalendarEventDto[]>([])
  const [showSource, setShowSource] = useState(false)
  const [saving, setSaving] = useState(false)
  /** Set by ADD IT ANYWAY: the household has seen the clash and said yes to it. */
  const [clashAccepted, setClashAccepted] = useState(false)

  const multi = items.length > 1
  const single = items[0]

  // Writable calendars only. An event written to a read-only calendar is refused by Google, and one
  // written to a calendar the household has hidden vanishes the moment it saves.
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
        const options = all.filter((c) => c.selected && c.canWrite)
        setCalendars(options)
        // The best guess from context, as an actual rule — see `defaultCalendar`. Never overwrites a
        // chip somebody has already pressed.
        setCalendarId((cur) => cur ?? defaultCalendar(options, profiles, context))
      } catch (err) {
        if (!(err instanceof ApiError)) throw err
        // No calendar list is the single-writable degrade, not an error worth a sentence: the write
        // goes to the account's primary, which is exactly where an unset target resolves server-side.
        if (!cancelled) setCalendars([])
      }
    })()
    return () => { cancelled = true }
  }, [activeProfileId, profiles, context])

  /*
   * What is already on that day, for the clash block.
   *
   * Fetched per day rather than per chip: the calendar a draft lands on changes which events count,
   * but not which day they are on, so the filtering is local and only the day is a round trip. The
   * events table is an offline mirror of Google, which is why the block says "already on that hour"
   * rather than claiming an hour is free.
   */
  useEffect(() => {
    const day = single?.date
    if (!day || multi) return
    let cancelled = false
    void (async () => {
      try {
        const from = new Date(day)
        from.setHours(0, 0, 0, 0)
        const found = await api.getEvents(from.toISOString(), addDays(from, 1).toISOString())
        if (!cancelled) setDayEvents(found)
      } catch (err) {
        if (!(err instanceof ApiError)) throw err
        if (!cancelled) setDayEvents([])
      }
    })()
    return () => { cancelled = true }
  }, [single?.date, multi])

  const clashes = useMemo(
    () => (single && !multi ? clashesWith(single, dayEvents, calendarId) : []),
    [single, multi, dayEvents, calendarId],
  )

  const patch = useCallback((id: string, change: Partial<EventDraft>) => {
    setItems((cur) => cur.map((d) => (d.id === id ? { ...d, ...change } : d)))
  }, [])

  const ready = writable(items)
  const blocked = clashes.length > 0 && !clashAccepted
  const calendarName = calendars.find((c) => c.calendarId === calendarId)?.name ?? null

  const add = useCallback(async () => {
    if (saving || ready.length === 0) return
    setSaving(true)

    const written: WrittenEvent[] = []
    let photoKept = false
    for (const draft of ready) {
      const bounds = boundsFor(draft)
      const outcome = await run({
        domain: 'calendar',
        method: 'POST',
        path: '/calendar/events',
        body: {
          title: draft.title.trim(),
          ...bounds,
          isAllDay: draft.allDay,
          location: draft.where.trim() || null,
          notes: draft.note.trim() || null,
          ownerIds: [],
          profileId: activeProfileId ?? null,
          googleCalendarId: calendarId,
          // The bytes travel with every one of them. One photograph shared by four engagements is
          // stored once — the server addresses it by content hash — and released only when the last
          // of them lets go of it.
          photoBase64: photo.base64,
          photoTakenUtc: photo.takenAt,
          fromPhoto: true,
        },
        label: `Add “${draft.title.trim()}”`,
      })

      if (outcome.kind === 'ok') {
        const stored = outcome.data as CalendarEventDto | undefined
        if (stored?.hasPhoto) photoKept = true
        written.push({
          id: stored?.id ?? null,
          opId: null,
          title: draft.title.trim(),
          startUtc: bounds.startUtc,
          isAllDay: draft.allDay,
          calendarName: stored?.calendarName ?? calendarName,
        })
      } else if (outcome.kind === 'queued') {
        written.push({
          id: null,
          opId: outcome.opId,
          title: draft.title.trim(),
          startUtc: bounds.startUtc,
          isAllDay: draft.allDay,
          calendarName,
        })
      }
      // Anything else — a refusal, a conflict — is already surfaced by the write queue's own strip.
      // Reporting it twice would put two explanations of one failure on the same screen.
    }

    setSaving(false)
    onAdded(written, photoKept)
  }, [saving, ready, run, activeProfileId, calendarId, photo, calendarName, onAdded])

  return (
    <div className="ml-sheetwrap">
      {/* Dismiss by DISCARD only. A tap-outside on a wall panel is something a sleeve does. */}
      <div className="ml-sheet__scrim" />
      <section className="ml-sheet" role="dialog" aria-label="Found on the photo">
        <header className="ml-sheet__head">
          <span className="ml-sheet__title">{sheetHeader(items, clashes.length)}</span>
          {photo.preview && (
            <button type="button" className="ml-sheet__source" onClick={() => setShowSource((v) => !v)}>
              {showSource ? 'Hide source' : 'View source'}
            </button>
          )}
        </header>

        {showSource && photo.preview && (
          <img className="ml-sheet__photo" src={photo.preview} alt="The photograph this was read from" />
        )}

        {multi
          ? <TickList items={items} onToggle={(id, selected) => patch(id, { selected })} />
          : single && <Fields draft={single} onChange={(change) => patch(single.id, change)} />}

        <CalendarRow
          calendars={calendars}
          value={calendarId}
          onPick={setCalendarId}
          // Re-asked the moment the target changes: what clashes is a question about a calendar, and
          // an answer carried over from the previous chip would be about the wrong one.
          onChange={() => setClashAccepted(false)}
        />

        {clashes.length > 0 && <ClashBlock clashes={clashes} />}

        {!multi && single && <Footnote draft={single} />}

        <div className="ml-sheet__actions">
          {blocked ? (
            <>
              <button type="button" className="ml-sheet__btn ml-sheet__btn--go ml-sheet__btn--wide" onClick={() => setClashAccepted(true)}>
                Add it anyway
              </button>
              <div className="ml-sheet__actions ml-sheet__actions--second">
                <button type="button" className="ml-sheet__btn ml-sheet__btn--alt" onClick={() => single && onEdit(single, photo)}>
                  Move the other
                </button>
                <button type="button" className="ml-sheet__btn" onClick={onDiscard}>Discard</button>
              </div>
            </>
          ) : (
            <>
              <button type="button" className="ml-sheet__btn" onClick={onDiscard}>Discard</button>
              {!multi && single && (
                <button type="button" className="ml-sheet__btn ml-sheet__btn--alt" onClick={() => onEdit(single, photo)}>
                  Edit
                </button>
              )}
              <button
                type="button"
                className="ml-sheet__btn ml-sheet__btn--go"
                onClick={() => void add()}
                disabled={ready.length === 0 || saving}
              >
                {multi ? `Add ${countWord(ready.length)} engagement${ready.length === 1 ? '' : 's'}` : 'Add to calendar'}
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  )
}

/** Minutes since local midnight, as the sheet says them. */
function timeParts(minutes: number): { time: string; ampm: string } {
  const d = new Date(2000, 0, 1)
  d.setHours(0, minutes, 0, 0)
  return formatTime(d)
}

const STEP = 15 // minutes, matching the event editor's steppers

/**
 * The fields of a single engagement.
 *
 * <b>A value that was read is a value; a value that was guessed is a control.</b> That is the whole
 * layout rule here. An amber field arrives with a stepper already open at the proposed answer, so
 * confirming it is a glance and correcting it is one press — and a field that came off the
 * photograph cleanly is not dressed up as something needing attention.
 */
function Fields({ draft, onChange }: { draft: EventDraft; onChange: (change: Partial<EventDraft>) => void }) {
  const marked = amber(draft)
  const cls = (field: DraftField, base: string) => base + (marked.has(field) ? ' ml-sheet__amber' : '')

  const shiftDate = (days: number) => onChange({ date: addDays(draft.date, days) })
  const shiftTime = (field: 'begins' | 'ends', delta: number) => {
    const cur = draft[field] ?? 0
    onChange({ [field]: Math.max(0, Math.min(24 * 60 - STEP, cur + delta)) })
  }

  const begins = draft.begins === null ? null : timeParts(draft.begins)
  const ends = draft.ends === null ? null : timeParts(draft.ends)

  return (
    <>
      <div className="ml-sheet__row ml-sheet__row--stacked">
        <span className="ml-sheet__label">Title</span>
        <span className={cls('title', 'ml-sheet__value ml-sheet__value--title serif')}>
          {draft.title || 'No name on it'}
        </span>
      </div>

      <div className="ml-sheet__row">
        <span className="ml-sheet__label">Date</span>
        {marked.has('date') ? (
          <span className="ml-sheet__ctrl">
            <button type="button" className="ml-sheet__step" aria-label="Previous day" onClick={() => shiftDate(-1)}>◂</button>
            <span className="ml-sheet__value ml-sheet__amber serif">{dayLabel(draft.date)}</span>
            <button type="button" className="ml-sheet__step" aria-label="Next day" onClick={() => shiftDate(1)}>▸</button>
          </span>
        ) : (
          <span className="ml-sheet__value serif">{dayLabel(draft.date)}</span>
        )}
      </div>

      {/* An all-day engagement has no begin and no finish to show, so these leave the sheet entirely
          rather than sitting there empty (screen 06). */}
      {!draft.allDay && (
        <>
          <TimeRow
            label="Begins" parts={begins} marked={marked.has('begins')}
            onStep={(d) => shiftTime('begins', d)}
          />
          <TimeRow
            label="Ends" parts={ends} marked={marked.has('ends')}
            onStep={(d) => shiftTime('ends', d)}
          />
        </>
      )}

      <div className="ml-sheet__row">
        <span className="ml-sheet__label">Where</span>
        <span className={cls('where', 'ml-sheet__where') + (draft.where ? '' : ' ml-sheet__where--none')}>
          {draft.where || 'Not given'}
        </span>
      </div>

      {/*
        NOTE — shown because it is written.

        <b>It was written without ever being drawn</b>, which quietly broke the rule the whole sheet
        exists to keep: nothing reaches the calendar that a person has not seen. A flyer's note is
        usually "bring a packed lunch", and occasionally it is whatever else was printed on the page —
        a reading of a hostile flyer puts that text here, verbatim and by design, because reporting it
        as content is exactly what the extractor is told to do with words that look like instructions.
        Content the household never sees is content nobody agreed to, and it does not stay unseen: it
        lands on the engagement, and the agent reads engagements back through `get_calendar`.
      */}
      {draft.note && (
        <div className="ml-sheet__row ml-sheet__row--stacked">
          <span className="ml-sheet__label">Note</span>
          <span className="ml-sheet__note">{draft.note}</span>
        </div>
      )}

      <div className="ml-sheet__row">
        <span className="ml-sheet__label">Kind</span>
        <span className="ml-sheet__kind">
          <button
            type="button"
            className={'ml-chip' + (draft.allDay ? '' : ' ml-chip--active')}
            aria-pressed={!draft.allDay}
            // Switching to timed needs an hour to switch to. Ten in the morning is the sheet's own
            // proposal rather than a reading, so it arrives marked like every other proposal.
            onClick={() => onChange({
              allDay: false,
              begins: draft.begins ?? 10 * 60,
              ends: draft.ends ?? 11 * 60,
              assumed: draft.begins === null ? [...draft.assumed, 'begins', 'ends'] : draft.assumed,
            })}
          >
            Timed
          </button>
          <button
            type="button"
            className={'ml-chip' + (draft.allDay ? ' ml-chip--active' : '')}
            aria-pressed={draft.allDay}
            onClick={() => onChange({ allDay: true })}
          >
            All day
          </button>
        </span>
      </div>
    </>
  )
}

function TimeRow({ label, parts, marked, onStep }: {
  label: string
  parts: { time: string; ampm: string } | null
  marked: boolean
  onStep: (delta: number) => void
}) {
  const value = (
    <span className={'ml-sheet__value serif' + (marked ? ' ml-sheet__amber' : '')}>
      {parts ? parts.time : '—'}
      {parts && <span className="ml-sheet__ampm">{parts.ampm}</span>}
    </span>
  )
  return (
    <div className="ml-sheet__row">
      <span className="ml-sheet__label">{label}</span>
      {marked ? (
        <span className="ml-sheet__ctrl">
          <button type="button" className="ml-sheet__step" aria-label={`Earlier ${label.toLowerCase()}`} onClick={() => onStep(-STEP)}>−</button>
          {value}
          <button type="button" className="ml-sheet__step" aria-label={`Later ${label.toLowerCase()}`} onClick={() => onStep(STEP)}>+</button>
        </span>
      ) : value}
    </div>
  )
}

/** "Sat · 14 Sep" — the same shape the event editor's DATE field uses. */
function dayLabel(d: Date): string {
  const wd = d.toLocaleDateString('en-US', { weekday: 'short' })
  const mon = d.toLocaleDateString('en-US', { month: 'short' })
  return `${wd} · ${d.getDate()} ${mon}`
}

/**
 * A term letter's worth of dates, one ticked row each.
 *
 * Every row starts ticked: the reading found them, and a list that arrives empty asks somebody to
 * re-do the work of reading the photograph. Unticking is the cheap direction.
 */
function TickList({ items, onToggle }: { items: readonly EventDraft[]; onToggle: (id: string, selected: boolean) => void }) {
  return (
    <ul className="ml-sheet__list">
      {items.map((d) => {
        const bad = !canWrite(d)
        return (
          <li key={d.id}>
            <button
              type="button"
              className={'ml-sheet__tick' + (d.selected && !bad ? ' ml-sheet__tick--on' : '')}
              onClick={() => onToggle(d.id, !d.selected)}
              disabled={bad}
              aria-pressed={d.selected && !bad}
            >
              <span className="ml-sheet__box" aria-hidden="true">{d.selected && !bad ? '✓' : ''}</span>
              <span className="ml-sheet__tickbody">
                <span className="ml-sheet__ticktitle">{d.title || 'No name on it'}</span>
                <span className="ml-sheet__tickmeta">
                  {dayLabel(d.date)}
                  {d.allDay ? ' · All day' : d.begins !== null ? ` · ${timeParts(d.begins).time} ${timeParts(d.begins).ampm}` : ''}
                </span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Which calendar this lands on.
 *
 * <b>One option is a fact, not a choice.</b> A single chip is a control that cannot be operated, and
 * drawing it as one asks somebody to consider a decision that has already been made — so it degrades
 * to a plain value row (screen 06). No options at all means the same thing: the write goes to the
 * account's primary, which is where an unset target resolves anyway.
 */
function CalendarRow({ calendars, value, onPick, onChange }: {
  calendars: readonly SyncCalendarDto[]
  value: string | null
  onPick: (id: string) => void
  onChange: () => void
}) {
  if (calendars.length === 0) return null
  if (calendars.length === 1) {
    return (
      <div className="ml-sheet__row">
        <span className="ml-sheet__label">Calendar</span>
        <span className="ml-sheet__stated">{calendars[0].name}</span>
      </div>
    )
  }
  return (
    <div className="ml-sheet__row ml-sheet__row--stacked">
      <span className="ml-sheet__label">Calendar</span>
      <span className="ml-sheet__caption">Calendars you can write to</span>
      <span className="ml-sheet__chips">
        {calendars.map((c) => (
          <button
            key={c.calendarId}
            type="button"
            className={'ml-chip' + (value === c.calendarId ? ' ml-chip--active' : '')}
            onClick={() => { onPick(c.calendarId); onChange() }}
          >
            {c.name}
          </button>
        ))}
      </span>
    </div>
  )
}

/** What is already on that hour. A warning drawn from a mirror, and worded as one. */
function ClashBlock({ clashes }: { clashes: readonly CalendarEventDto[] }) {
  return (
    <div className="ml-sheet__clash">
      <span className="ml-sheet__clashlabel">Already on that hour</span>
      {clashes.map((e) => {
        const at = new Date(e.startUtc)
        const parts = formatTime(at)
        return (
          <div key={e.id} className="ml-sheet__clashrow">
            <span className="ml-sheet__clashtitle">{e.title}</span>
            <span className="ml-sheet__clashmeta">
              {`${parts.time} ${parts.ampm}`}{e.calendarName ? ` · ${e.calendarName}` : ''}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** The line under the fields: brass states, amber warns. */
function Footnote({ draft }: { draft: EventDraft }) {
  const note = footnoteFor(draft)
  if (!note) return null
  return (
    <div className="ml-sheet__foot">
      <span className={'ml-sheet__square' + (note.tone === 'amber' ? ' ml-sheet__square--amber' : '')} aria-hidden="true" />
      <span className="ml-sheet__footnote">{note.text}</span>
    </div>
  )
}
