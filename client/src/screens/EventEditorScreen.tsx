import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ScreenShell, SectionLabel, Stepper } from '../components'
import { Icon } from '../icons/Icon'
import { useSession } from '../app/SessionProvider'
import { useCalendar } from '../app/CalendarProvider'
import { api, ApiError } from '../api/client'
import { formatTime, snapMinutes, weekdayName, monthName } from '../app/dates'

const STEP = 15 // minutes

function nextHour(): Date {
  const d = new Date()
  d.setMinutes(0, 0, 0)
  d.setHours(d.getHours() + 1)
  return d
}

/**
 * New / Edit Event (spec 10): fully touch-driven — big day/time steppers and WHO chips, no
 * dropdowns. Full-screen over the calendar. Save/Cancel in the header; Edit mode adds Delete.
 */
export function EventEditorScreen() {
  const navigate = useNavigate()
  const { id } = useParams()
  const editId = id ? Number(id) : null
  const { profiles } = useSession()
  const { refresh } = useCalendar()

  const [title, setTitle] = useState('')
  const [start, setStart] = useState<Date>(() => nextHour())
  const [end, setEnd] = useState<Date>(() => new Date(nextHour().getTime() + 60 * 60_000))
  const [ownerIds, setOwnerIds] = useState<number[]>([])
  const [location, setLocation] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

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
      } catch (err) {
        if (!(err instanceof ApiError)) throw err
      }
    })()
    return () => {
      cancelled = true
    }
  }, [editId])

  const shiftDay = (delta: number) => {
    setStart((s) => { const n = new Date(s); n.setDate(n.getDate() + delta); return n })
    setEnd((e) => { const n = new Date(e); n.setDate(n.getDate() + delta); return n })
  }

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
    }
    try {
      if (editId == null) await api.createEvent(input)
      else await api.updateEvent(editId, input)
      await refresh()
      navigate('/calendar')
    } catch (err) {
      setSaving(false)
      if (!(err instanceof ApiError)) throw err
    }
  }, [title, start, end, location, notes, ownerIds, editId, saving, refresh, navigate])

  const remove = useCallback(async () => {
    if (editId == null) return
    try {
      await api.deleteEvent(editId)
      await refresh()
      navigate('/calendar')
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
    }
  }, [editId, refresh, navigate])

  const startT = formatTime(start)
  const endT = formatTime(end)

  const header = (
    <header className="ml-header ml-editor-header">
      <button type="button" className="ml-editor-header__cancel" onClick={() => navigate('/calendar')}>
        Cancel
      </button>
      <span className="ml-editor-header__title serif">{editId == null ? 'New Engagement' : 'Edit Engagement'}</span>
      <button type="button" className="ml-editor-header__save" onClick={save} disabled={!title.trim() || saving}>
        Save
      </button>
    </header>
  )

  return (
    <ScreenShell header={header} nav={false}>
      <div className="ml-editor">
        <SectionLabel label="Title" />
        <input
          className="ml-titleinput serif"
          value={title}
          placeholder="Add a title…"
          onChange={(e) => setTitle(e.target.value)}
          autoFocus={editId == null}
        />

        <SectionLabel label="Date" />
        <div className="ml-datestep">
          <button type="button" className="ml-iconbtn" onClick={() => shiftDay(-1)} aria-label="Previous day">
            <Icon id="ico-back" size="1.25rem" />
          </button>
          <div className="ml-datestep__label">
            <span className="serif ml-datestep__date">{`${weekdayName(start)} ${start.getDate()} ${monthName(start)}`}</span>
          </div>
          <button type="button" className="ml-iconbtn" onClick={() => shiftDay(1)} aria-label="Next day">
            <Icon id="ico-chevron-right" size="1.25rem" />
          </button>
        </div>

        <div className="ml-timecols">
          <div className="ml-timecol">
            <SectionLabel label="Begins" />
            <div className="ml-timestep">
              <Stepper direction="minus" onStep={() => shiftStart(-STEP)} label="Earlier start" />
              <span className="ml-timestep__time serif">{startT.time}<span className="ml-timestep__ampm">{startT.ampm}</span></span>
              <Stepper direction="plus" onStep={() => shiftStart(STEP)} label="Later start" />
            </div>
          </div>
          <div className="ml-timecol">
            <SectionLabel label="Ends" />
            <div className="ml-timestep">
              <Stepper direction="minus" onStep={() => shiftEnd(-STEP)} label="Earlier end" />
              <span className="ml-timestep__time serif">{endT.time}<span className="ml-timestep__ampm">{endT.ampm}</span></span>
              <Stepper direction="plus" onStep={() => shiftEnd(STEP)} label="Later end" />
            </div>
          </div>
        </div>

        <SectionLabel label="Who" />
        <div className="ml-whochips">
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
        </div>

        <SectionLabel label="Where & Notes" />
        <input className="ml-fieldinput" value={location} placeholder="Add a location…" onChange={(e) => setLocation(e.target.value)} />
        <input className="ml-fieldinput" value={notes} placeholder="Add a note…" onChange={(e) => setNotes(e.target.value)} />

        {editId != null && (
          <button type="button" className="ml-editor__delete" onClick={remove}>
            Delete engagement
          </button>
        )}
      </div>
    </ScreenShell>
  )
}
