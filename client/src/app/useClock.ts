import { useEffect, useState } from 'react'
import { formatTime } from './dates'

function format(now: Date) {
  // Twelve-hour, split into the number and its meridiem, through the same helper the calendar's
  // NEXT rows use. The panel was already 12-hour everywhere it says a time — events, the Care log,
  // the litter event log all read `3:15 PM` — and this clock was the one 24-hour surface left.
  const { time, ampm } = formatTime(now)
  const date = now
    .toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
    .toUpperCase()

  /*
   * The same day, month before the number: `MONDAY AUGUST 10` rather than `MONDAY 10 AUGUST`.
   *
   * Weather's header reads this one; the dashboard and the lock screen keep `date`. Two orders is a
   * deliberate cost — Weather stacks the day over the time in a narrow right-hand column, and there
   * the number wants to be last, where the eye lands after the month rather than between two words.
   *
   * Composed from parts rather than switching the locale to `en-US`, which formats this as
   * "Monday, August 10". The comma is the whole reason: every other date on the panel is spaced, not
   * punctuated, and one comma in one header is the kind of difference nobody can name but everybody
   * sees.
   */
  const weekday = now.toLocaleDateString('en-GB', { weekday: 'long' })
  const month = now.toLocaleDateString('en-GB', { month: 'long' })
  const dateMonthFirst = `${weekday} ${month} ${now.getDate()}`.toUpperCase()

  return { time, ampm, date, dateMonthFirst }
}

/** Live wall-clock, updated every 10s. Drives the dashboard clock and date line. */
export function useClock() {
  const [value, setValue] = useState(() => format(new Date()))
  useEffect(() => {
    const tick = () => setValue(format(new Date()))
    tick()
    const id = window.setInterval(tick, 10_000)
    return () => window.clearInterval(id)
  }, [])
  return value
}
