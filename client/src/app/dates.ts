/** Small date helpers for the calendar (local-time based; events are stored/exchanged as UTC ISO). */

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1)
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/**
 * The UTC bounds of one or more whole local days — what an all-day event is written as.
 *
 * <b>Resolved here because this is the only device that knows a zone.</b> There is no household
 * timezone anywhere in HomeHub: times are UTC end to end and rendered local by whatever is drawing
 * them, which has worked because every date so far arrived from somewhere else. An all-day event is
 * the first one the panel has to *construct*, and "midnight" is meaningless until somebody says
 * where. The confirming device answers that, and sends UTC.
 *
 * End is **exclusive** — midnight of the day after the last one — which matches both the range
 * queries the calendar already runs and Google's own all-day shape, so the server can hand it
 * straight over without a second convention.
 *
 * @param day any instant on the first day
 * @param days how many whole days the event covers; at least one
 */
export function allDayBounds(day: Date, days = 1): { startUtc: string; endUtc: string } {
  const start = startOfDay(day)
  const end = addDays(start, Math.max(1, days))
  return { startUtc: start.toISOString(), endUtc: end.toISOString() }
}

/** Day key "YYYY-MM-DD" in local time, for set membership. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 6×7 grid of days covering the month, Sunday-first, with adjacent-month spill. */
export function monthGrid(activeMonth: Date): Date[] {
  const first = startOfMonth(activeMonth)
  const gridStart = addDays(first, -first.getDay()) // back up to Sunday
  return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function monthName(d: Date): string {
  return MONTHS[d.getMonth()]
}

export function weekdayName(d: Date): string {
  return WEEKDAYS[d.getDay()]
}

/** Marcellus time split into number + meridiem, e.g. { time: "7:00", ampm: "PM" }. */
export function formatTime(d: Date): { time: string; ampm: string } {
  let h = d.getHours()
  const m = d.getMinutes()
  const ampm = h < 12 ? 'AM' : 'PM'
  h = h % 12 === 0 ? 12 : h % 12
  return { time: `${h}:${String(m).padStart(2, '0')}`, ampm }
}

/**
 * Minutes since local midnight as a spoken clock — `6:15 PM`.
 *
 * <b>Nothing the household reads is 24-hour.</b> The panel says `3:15 PM` in the Care log, the
 * litter log, the calendar and the dashboard clock, and it used to say `15:15` in the header stamps,
 * the meals start-and-serve times, the night-dim window and the update plate — all of them because
 * the value came out of something whose *storage* form is `HH:mm`. Storage and speech are different
 * jobs: `mealsDomain.formatClock` and `nightMode.toClock` still write the padded form, because it is
 * parsed straight back and an `<input type="time">` requires it. This is the reading end, and every
 * surface that shows a time to a person comes through here or its two wrappers below.
 *
 * Wraps across midnight, so a cook that starts before midnight for a meal after it still names a
 * real time rather than a negative one.
 */
export function clockFromMinutes(minutes: number): string {
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440
  const h24 = Math.floor(wrapped / 60)
  const ampm = h24 < 12 ? 'AM' : 'PM'
  const hour = h24 % 12 === 0 ? 12 : h24 % 12
  return `${hour}:${String(wrapped % 60).padStart(2, '0')} ${ampm}`
}

/** A wall-clock time as one string — `6:32 PM`. The header stamp's half of {@link formatTime}. */
export function clockLabel(d: Date): string {
  return clockFromMinutes(d.getHours() * 60 + d.getMinutes())
}

/**
 * A stored `HH:mm` setting, said out loud — `18:30` → `6:30 PM`.
 *
 * An unreadable value is returned untouched rather than blanked or guessed at: it is the household's
 * own setting, and a row that silently shows nothing where a time should be is harder to diagnose
 * than one showing exactly what is stored.
 */
export function clockFromStored(hhmm: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!match) return hhmm
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return hhmm
  return clockFromMinutes(hours * 60 + minutes)
}

/** Round a Date to the nearest N minutes (used to snap event steppers). */
export function snapMinutes(d: Date, step: number): Date {
  const out = new Date(d)
  out.setSeconds(0, 0)
  out.setMinutes(Math.round(out.getMinutes() / step) * step)
  return out
}
