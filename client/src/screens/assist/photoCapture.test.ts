import { describe, expect, it } from 'vitest'
import { confirmationProse, declaresIntent, offersAnEvent, receiptLines, spokenTime } from './photoCapture'
import type { DraftEventDto } from '../../api/types'
import type { WrittenEvent } from './EventConfirmSheet'

const written = (over: Partial<WrittenEvent> = {}): WrittenEvent => ({
  id: 1,
  opId: null,
  title: 'Summer Camp Open House',
  startUtc: new Date(2026, 8, 14, 10, 0).toISOString(),
  isAllDay: false,
  calendarName: 'Theo · school',
  ...over,
})

describe('declaresIntent', () => {
  it('hears somebody who has already decided', () => {
    expect(declaresIntent("here's the camp flyer, add it to the calendar")).toBe(true)
    expect(declaresIntent('put this in the diary')).toBe(true)
  })

  /*
   * The asymmetry this rule is built around. Skipping the offer on a question puts a confirm sheet
   * in front of somebody who asked what a photo said — worse than asking a question they had already
   * answered, which costs one tap.
   */
  it('stays quiet about a question that merely mentions the calendar', () => {
    expect(declaresIntent('what does this say about the camp?')).toBe(false)
    expect(declaresIntent('is this the same week as the school calendar thing?')).toBe(false)
    expect(declaresIntent('add milk to the list')).toBe(false)
  })

  it('does not let one word play both halves of the rule', () => {
    expect(declaresIntent('the paddock schedule is unreadable')).toBe(false)
  })
})

describe('offersAnEvent', () => {
  const draft = (title: string): DraftEventDto => ({
    id: '0', title, date: '2026-09-14', allDay: true, begins: null, ends: null,
    where: null, note: null, lowConfidence: [], assumed: [],
  })

  it('speaks when something on the photograph has a name', () => {
    expect(offersAnEvent([draft('Open House')])).toBe(true)
  })

  /* A date with no name is as likely to be a price or a phone number as an engagement. */
  it('stays silent when nothing found has a name', () => {
    expect(offersAnEvent([draft(''), draft('   ')])).toBe(false)
    expect(offersAnEvent([])).toBe(false)
  })
})

describe('spokenTime', () => {
  it('says the hour the way a person would', () => {
    expect(spokenTime(new Date(2026, 8, 14, 10, 0))).toBe('10 AM')
    expect(spokenTime(new Date(2026, 8, 14, 19, 30))).toBe('7:30 PM')
    expect(spokenTime(new Date(2026, 8, 14, 0, 0))).toBe('12 AM')
    expect(spokenTime(new Date(2026, 8, 14, 12, 0))).toBe('12 PM')
  })
})

describe('confirmationProse', () => {
  it('names the engagement, when, and where it went', () => {
    expect(confirmationProse([written()]))
      .toBe('Written down — Summer Camp Open House, Monday 14 September at 10 AM, on Theo · school.')
  })

  /* An all-day engagement has no hour to name, and inventing one in the receipt would contradict the
     sheet that just declined to invent one. */
  it('leaves the hour out of an all-day engagement', () => {
    const prose = confirmationProse([written({ isAllDay: true, startUtc: new Date(2026, 8, 14).toISOString() })])
    expect(prose).toBe('Written down — Summer Camp Open House, Monday 14 September, on Theo · school.')
  })

  it('counts the dates for a term letter rather than naming one of them', () => {
    const batch = [
      written({ startUtc: new Date(2026, 8, 14).toISOString() }),
      written({ startUtc: new Date(2026, 8, 20).toISOString() }),
      written({ startUtc: new Date(2026, 8, 30).toISOString() }),
    ]
    expect(confirmationProse(batch))
      .toBe('Written down — three dates, 14 September, 20 September and 30 September, on Theo · school.')
  })
})

describe('receiptLines', () => {
  it('states the calendar and the photo', () => {
    expect(receiptLines([written()], true)).toEqual([
      'Theo · school was written to',
      'The photo is kept with the engagement',
    ])
  })

  it('pluralises for a batch', () => {
    expect(receiptLines([written(), written(), written(), written()], true)).toEqual([
      'Theo · school was written to · 4 engagements',
      'The photo is kept with all four',
    ])
  })

  /*
   * Retention off in Config, or a format the panel will not store. The engagement still says it came
   * off a photograph — that is a fact about the event — but the receipt must stop claiming a picture
   * was kept, because somebody will go looking for it.
   */
  it('drops the photo line when nothing was kept', () => {
    expect(receiptLines([written()], false)).toEqual(['Theo · school was written to'])
  })

  it('falls back to naming the shared calendar when there is no name', () => {
    expect(receiptLines([written({ calendarName: null })], false)).toEqual(['The shared calendar was written to'])
  })
})
