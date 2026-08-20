import { useCallback, useMemo, useState } from 'react'

type Meridiem = 'AM' | 'PM'
type Day = 'TODAY' | 'YESTERDAY'

/**
 * The shared time picker — view 3, and the only reason a Care entry can be a 2am feed typed at 6am.
 *
 * <b>It replaces the panel's contents in place rather than stacking a second layer.</b> Hence a
 * hook and two pieces rather than a self-contained component: the caller keeps one `CarePanel`
 * mounted and swaps what is inside it, so the height never changes and the panel never re-rises.
 * Stacking a second sheet over the first was the obvious build and it is wrong — two shadows, two
 * handles, and a drag that has to decide which layer it belongs to.
 */
export interface WhenDraft {
  /** The time as currently typed. */
  at: Date
  /** False when the digits so far do not name a real time — `13:__`, `8:75`. SET refuses. */
  valid: boolean
  hour: number
  minute: number
  meridiem: Meridiem
  day: Day
  /** `29 MINUTES AGO` — the line that catches a mis-typed hour before it is saved. */
  elapsed: string
  press: (key: number | 'back' | 'now') => void
  setMeridiem: (m: Meridiem) => void
  setDay: (d: Day) => void
  /** Seed the draft from a time — called when the row is tapped, not on every render. */
  open: (from: Date) => void
}

// eslint-disable-next-line react-refresh/only-export-components
export function useWhenDraft(): WhenDraft {
  const [seed, setSeed] = useState<Date>(() => new Date())
  const [typed, setTyped] = useState('')
  const [meridiem, setMeridiem] = useState<Meridiem>('AM')
  const [day, setDay] = useState<Day>('TODAY')

  const open = useCallback((from: Date) => {
    setSeed(from)
    setTyped('')
    setMeridiem(from.getHours() < 12 ? 'AM' : 'PM')
    setDay(isYesterday(from) ? 'YESTERDAY' : 'TODAY')
  }, [])

  /**
   * Digits fill left to right, the way a phone takes a time: `8` is 8:00, `840` is 8:40, `1215` is
   * 12:15. Right-to-left fill (`8` → 0:08) is the other convention and it is wrong on a 12-hour
   * clock, where a single digit is nearly always the hour somebody means.
   */
  const { hour, minute } = useMemo(() => {
    if (typed.length === 0) return { hour: seed.getHours() % 12 || 12, minute: seed.getMinutes() }
    if (typed.length <= 2) return { hour: Number(typed), minute: 0 }
    if (typed.length === 3) return { hour: Number(typed[0]), minute: Number(typed.slice(1)) }
    return { hour: Number(typed.slice(0, 2)), minute: Number(typed.slice(2)) }
  }, [typed, seed])

  const valid = hour >= 1 && hour <= 12 && minute >= 0 && minute <= 59

  const at = useMemo(() => {
    const d = new Date(seed)
    if (day === 'YESTERDAY' && !isYesterday(seed)) d.setDate(d.getDate() - 1)
    if (day === 'TODAY' && isYesterday(seed)) d.setDate(d.getDate() + 1)
    if (!valid) return d
    d.setHours(meridiem === 'PM' ? (hour % 12) + 12 : hour % 12, minute, 0, 0)
    return d
  }, [seed, day, meridiem, hour, minute, valid])

  const press = useCallback((key: number | 'back' | 'now') => {
    if (key === 'now') {
      const now = new Date()
      setSeed(now)
      setTyped('')
      setMeridiem(now.getHours() < 12 ? 'AM' : 'PM')
      setDay('TODAY')
      return
    }
    if (key === 'back') {
      setTyped((t) => t.slice(0, -1))
      return
    }
    setTyped((t) => (t.length >= 4 ? t : t + String(key)))
  }, [])

  return {
    at, valid, hour, minute, meridiem, day,
    elapsed: valid ? elapsedWords(at) : 'Not a time',
    press, setMeridiem, setDay, open,
  }
}

/** The panel body while the picker is up: display, qualifiers, keypad. */
export function WhenPickerBody({ draft }: { draft: WhenDraft }) {
  const digits = [1, 2, 3, 4, 5, 6, 7, 8, 9]

  return (
    <div className="ml-when">
      <div className="ml-when__display">
        <span className="ml-when__clock serif">
          {draft.hour}:{String(draft.minute).padStart(2, '0')}
        </span>
        <span className="ml-when__meridiem">{draft.meridiem}</span>
      </div>
      {/* Under the digits, not beside them: it is a check on what was just typed, and it is the
          only thing on this view that can catch 9:09 entered as 9:90. */}
      <div className={'ml-when__elapsed' + (draft.valid ? '' : ' ml-when__elapsed--bad')}>
        {draft.elapsed}
      </div>

      <div className="ml-when__quals">
        {(['AM', 'PM'] as const).map((m) => (
          <button
            key={m}
            type="button"
            className={'ml-carechip' + (draft.meridiem === m ? ' ml-carechip--on' : '')}
            onClick={() => draft.setMeridiem(m)}
          >
            {m}
          </button>
        ))}
        {/* YESTERDAY earns its place at 1am, when what is being logged happened before midnight. */}
        {(['TODAY', 'YESTERDAY'] as const).map((d) => (
          <button
            key={d}
            type="button"
            className={'ml-carechip' + (draft.day === d ? ' ml-carechip--on' : '')}
            onClick={() => draft.setDay(d)}
          >
            {d}
          </button>
        ))}
      </div>

      <div className="ml-when__pad">
        {digits.map((d) => (
          <button key={d} type="button" className="ml-when__key serif" onClick={() => draft.press(d)}>
            {d}
          </button>
        ))}
        <button type="button" className="ml-when__key ml-when__key--word" onClick={() => draft.press('now')}>
          Now
        </button>
        <button type="button" className="ml-when__key serif" onClick={() => draft.press(0)}>0</button>
        <button
          type="button"
          className="ml-when__key ml-when__key--glyph"
          onClick={() => draft.press('back')}
          aria-label="Backspace"
        >
          ⌫
        </button>
      </div>
    </div>
  )
}

/**
 * The picker's footer: the note, then BACK and SET.
 *
 * Both return to the panel that called it — the difference is only whether the typed time comes
 * back with them. Dragging the panel down from here abandons the whole entry, not just the time,
 * which is why neither of these is the drag.
 */
export function WhenPickerFoot({
  note, draft, onBack, onSet,
}: {
  note: string
  draft: WhenDraft
  onBack: () => void
  onSet: () => void
}) {
  return (
    <>
      <p className="ml-carepanel__review">{note}</p>
      <div className="ml-when__actions">
        <button type="button" className="ml-when__back" onClick={onBack}>Back</button>
        <button type="button" className="ml-carepanel__save" onClick={onSet} disabled={!draft.valid}>
          Set
        </button>
      </div>
    </>
  )
}

/** `29 minutes ago`, `2 hours 23 minutes ago`, `in 20 minutes` — words, not `2H 23M`. */
function elapsedWords(at: Date, now: Date = new Date()): string {
  const minutes = Math.round((now.getTime() - at.getTime()) / 60_000)
  if (minutes === 0) return 'Just now'
  // A time in the future is not an error — somebody typing 9:09 PM at 9:08 is one minute early —
  // but it must read as what it is rather than as a negative age.
  if (minutes < 0) return `In ${plural(-minutes, 'minute')}`
  if (minutes < 60) return `${plural(minutes, 'minute')} ago`

  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  const head = plural(hours, 'hour')
  return rest === 0 ? `${head} ago` : `${head} ${plural(rest, 'minute')} ago`
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function isYesterday(d: Date): boolean {
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  return d.toDateString() === yesterday.toDateString()
}
