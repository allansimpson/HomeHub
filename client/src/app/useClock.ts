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
  return { time, ampm, date }
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
