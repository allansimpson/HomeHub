import { useEffect, useState } from 'react'

function format(now: Date) {
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const date = now
    .toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
    .toUpperCase()
  return { time, date }
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
