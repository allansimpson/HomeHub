import { describe, expect, it } from 'vitest'
import { clockFromMinutes, clockFromStored, clockLabel, formatTime } from './dates'

/**
 * The one place a time becomes words.
 *
 * Nothing the household reads is 24-hour: the header stamps, the meals start-and-serve times, the
 * night-dim window and the update plate all said `18:30` at some point, each because the value came
 * out of something whose *storage* form is `HH:mm`. These assertions are the rule stated once.
 */
describe('saying a time', () => {
  it('reads as a twelve-hour clock with a meridiem', () => {
    expect(clockFromMinutes(18 * 60 + 30)).toBe('6:30 PM')
    expect(clockFromMinutes(9 * 60 + 5)).toBe('9:05 AM')
  })

  it('gets noon and midnight right — the two the arithmetic drops', () => {
    // `12 % 12` is 0, which is how a clock ends up claiming `0:00 PM`.
    expect(clockFromMinutes(12 * 60)).toBe('12:00 PM')
    expect(clockFromMinutes(0)).toBe('12:00 AM')
    expect(clockFromMinutes(12 * 60 + 59)).toBe('12:59 PM')
  })

  it('wraps across midnight, so a cook that starts the night before still names a real time', () => {
    // A 90-minute dish for a 00:30 table starts at −60 minutes, which is 11 PM yesterday.
    expect(clockFromMinutes(-60)).toBe('11:00 PM')
    expect(clockFromMinutes(1440)).toBe('12:00 AM')
  })

  it('says a Date the same way it says the minutes', () => {
    const at = new Date(2026, 7, 18, 18, 32)

    expect(clockLabel(at)).toBe('6:32 PM')
    // The dashboard splits the same value in two; the halves have to agree with the whole.
    const { time, ampm } = formatTime(at)
    expect(`${time} ${ampm}`).toBe(clockLabel(at))
  })
})

describe('a stored setting, said out loud', () => {
  it('turns the wire form into the reading form', () => {
    expect(clockFromStored('18:30')).toBe('6:30 PM')
    expect(clockFromStored('07:00')).toBe('7:00 AM')
    expect(clockFromStored(' 21:15 ')).toBe('9:15 PM')
  })

  it('hands back anything it cannot read, rather than blanking the row or guessing', () => {
    // It is the household's own setting; showing exactly what is stored is what makes a bad one
    // fixable, where an empty slot just looks broken.
    expect(clockFromStored('half six')).toBe('half six')
    expect(clockFromStored('25:00')).toBe('25:00')
    expect(clockFromStored('')).toBe('')
  })
})
