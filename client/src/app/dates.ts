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

/** Round a Date to the nearest N minutes (used to snap event steppers). */
export function snapMinutes(d: Date, step: number): Date {
  const out = new Date(d)
  out.setSeconds(0, 0)
  out.setMinutes(Math.round(out.getMinutes() / step) * step)
  return out
}
