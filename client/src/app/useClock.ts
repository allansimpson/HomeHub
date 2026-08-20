import { useEffect, useState } from 'react'
import { clockLabel, formatTime } from './dates'
import { planKey, shortDate } from './mealsDomain'

function format(now: Date) {
  // Twelve-hour, split into the number and its meridiem, through the same helper the calendar's
  // NEXT rows use. The panel was already 12-hour everywhere it says a time — events, the Care log,
  // the litter event log all read `3:15 PM` — and this clock was the one 24-hour surface left.
  const { time, ampm } = formatTime(now)
  const date = now
    .toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
    .toUpperCase()

  /*
   * The drill-in header stamp: `SUN 17 AUG · 2:32 PM`, one line.
   *
   * Meals has read exactly this since it shipped, and Weather and Devices read it too — a panel that
   * writes the day two ways in two headers is one nobody trusts to have written either on purpose.
   * Abbreviated day and month keep it inside the space left beside a title, which is what the
   * stacked two-row weather header was working around.
   *
   * <b>The time half was 24-hour and is not any more.</b> It came from the meals domain's
   * `formatClock`, which formats a stored `HH:mm` setting — right for the value it was written for,
   * wrong for a clock somebody reads: the panel says `3:15 PM` in the Care log, the litter log, the
   * calendar and the dashboard clock, and these three headers were the last surfaces answering in
   * 24-hour. See `dates.clockLabel`.
   */
  const stamp = `${shortDate(planKey(now))} · ${clockLabel(now)}`

  return { time, ampm, date, stamp }
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
