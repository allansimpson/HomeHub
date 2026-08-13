import { describe, expect, it } from 'vitest'
import {
  amber, boundsFor, canWrite, clashesWith, defaultCalendar, footnoteFor, localDay, sheetHeader,
  toDraft, writable,
} from './eventDrafts'
import type { CalendarEventDto, DraftEventDto } from '../api/types'

/**
 * The half of the confirm sheet that can be wrong without looking wrong.
 *
 * Every one of these is a rule the household will never see stated: which values are marked as
 * guesses, what midnight means, whether a press is allowed to write. A component test would render
 * all of it and check almost none of it.
 */

const dto = (over: Partial<DraftEventDto> = {}): DraftEventDto => ({
  id: '0',
  title: 'Summer Camp Open House',
  date: '2026-09-14',
  allDay: false,
  begins: '10:00:00',
  ends: '11:00:00',
  where: 'The school hall',
  note: null,
  lowConfidence: [],
  assumed: [],
  ...over,
})

const event = (over: Partial<CalendarEventDto> = {}): CalendarEventDto => ({
  id: 1,
  title: 'Dentist',
  startUtc: '2026-09-14T09:30:00.000Z',
  endUtc: '2026-09-14T10:30:00.000Z',
  isAllDay: false,
  location: null,
  notes: null,
  ownerIds: [],
  source: 'google',
  version: 1,
  profileId: null,
  calendarName: 'Theo · school',
  googleCalendarId: 'theo-school',
  kind: null,
  mark: null,
  fromPhoto: false,
  hasPhoto: false,
  photoTakenUtc: null,
  ...over,
} as CalendarEventDto)

describe('localDay', () => {
  /*
   * `new Date('2026-09-14')` is midnight *UTC*, which is the previous evening for most of the
   * western hemisphere — so a flyer read in Denver would land the engagement on the 13th.
   */
  it('reads a printed date as a local day, not a UTC instant', () => {
    const day = localDay('2026-09-14')
    expect(day.getFullYear()).toBe(2026)
    expect(day.getMonth()).toBe(8)
    expect(day.getDate()).toBe(14)
  })
})

describe('amber', () => {
  it('marks what was read badly and what was filled by rule alike', () => {
    const draft = toDraft(dto({ lowConfidence: ['ends'], assumed: ['year'] }))
    expect([...amber(draft)].sort()).toEqual(['date', 'ends'])
  })

  /* There is no year row on the sheet. The doubt belongs to the date, which is where it is drawn. */
  it('moves an assumed year onto the date row', () => {
    expect(amber(toDraft(dto({ assumed: ['year'] })))).toEqual(new Set(['date']))
  })

  it('drops hour doubts from an all-day engagement, which shows no hours', () => {
    const draft = toDraft(dto({ allDay: true, begins: null, ends: null, lowConfidence: ['begins', 'where'] }))
    expect(amber(draft)).toEqual(new Set(['where']))
  })
})

describe('boundsFor', () => {
  it('resolves a printed hour against this device’s zone', () => {
    const { startUtc, endUtc } = boundsFor(toDraft(dto()))
    expect(startUtc).toBe(new Date(2026, 8, 14, 10, 0).toISOString())
    expect(endUtc).toBe(new Date(2026, 8, 14, 11, 0).toISOString())
  })

  it('writes an all-day engagement as local midnight to local midnight, end exclusive', () => {
    const { startUtc, endUtc } = boundsFor(toDraft(dto({ allDay: true, begins: null, ends: null })))
    expect(startUtc).toBe(new Date(2026, 8, 14).toISOString())
    expect(endUtc).toBe(new Date(2026, 8, 15).toISOString())
  })

  /* Reachable only by stepping the finish back past the start. An hour is the least surprising repair. */
  it('will not write a finish at or before the start', () => {
    const draft = { ...toDraft(dto()), begins: 10 * 60, ends: 9 * 60 }
    const { startUtc, endUtc } = boundsFor(draft)
    expect(Date.parse(endUtc) - Date.parse(startUtc)).toBe(60 * 60_000)
  })
})

describe('canWrite', () => {
  it('accepts a proposed value as filled — that is what the amber underline is for', () => {
    expect(canWrite(toDraft(dto({ assumed: ['year', 'ends'] })))).toBe(true)
  })

  it('accepts an all-day engagement with no hours at all', () => {
    expect(canWrite(toDraft(dto({ allDay: true, begins: null, ends: null })))).toBe(true)
  })

  it('refuses a timed engagement with no start, which is genuinely unfillable', () => {
    expect(canWrite({ ...toDraft(dto()), allDay: false, begins: null })).toBe(false)
  })

  it('refuses an engagement with no name on it', () => {
    expect(canWrite(toDraft(dto({ title: '' })))).toBe(false)
  })
})

describe('writable', () => {
  it('is what one press would write — ticked, and possible', () => {
    const drafts = [
      toDraft(dto({ id: '0' })),
      { ...toDraft(dto({ id: '1' })), selected: false },
      toDraft(dto({ id: '2', title: '' })),
    ]
    expect(writable(drafts).map((d) => d.id)).toEqual(['0'])
  })
})

describe('clashesWith', () => {
  /*
   * Built from the draft's own resolved bounds rather than from literal instants. The draft says
   * "10 AM" and means 10 AM wherever this test is running, so a fixture written as `09:30Z` would
   * overlap it in London and miss it entirely in Denver — the test would then be asserting the
   * machine's timezone rather than the rule.
   */
  const draft = toDraft(dto())
  const { startUtc, endUtc } = boundsFor(draft)
  const shifted = (fromMs: number, toMs: number) => ({
    startUtc: new Date(Date.parse(startUtc) + fromMs).toISOString(),
    endUtc: new Date(Date.parse(startUtc) + toMs).toISOString(),
  })
  const HOUR = 60 * 60_000

  it('finds an engagement already on that hour', () => {
    expect(clashesWith(draft, [event(shifted(-HOUR / 2, HOUR / 2))], 'theo-school')).toHaveLength(1)
  })

  it('does not count touching ends as a collision', () => {
    const after = event({ startUtc: endUtc, endUtc: new Date(Date.parse(endUtc) + HOUR).toISOString() })
    const before = event(shifted(-HOUR, 0))
    expect(clashesWith(draft, [after, before], null)).toHaveLength(0)
  })

  it('ignores what is on another calendar — the chip decides what counts', () => {
    const overlapping = event({ ...shifted(-HOUR / 2, HOUR / 2), googleCalendarId: 'work' })
    expect(clashesWith(draft, [overlapping], 'theo-school')).toHaveLength(0)
  })

  /* A whole-day marker overlaps everything on its day. A block that fires on every school holiday
     is one nobody reads. */
  it('says nothing about all-day engagements, on either side', () => {
    const overlapping = shifted(-HOUR / 2, HOUR / 2)
    expect(clashesWith(draft, [event({ ...overlapping, isAllDay: true })], null)).toHaveLength(0)
    const allDay = toDraft(dto({ allDay: true, begins: null, ends: null }))
    expect(clashesWith(allDay, [event(overlapping)], null)).toHaveLength(0)
  })
})

describe('sheetHeader', () => {
  it('counts engagements in words when there are several', () => {
    const drafts = [0, 1, 2, 3].map((i) => toDraft(dto({ id: String(i) })))
    expect(sheetHeader(drafts, 0)).toBe('FOUR ENGAGEMENTS FOUND')
  })

  it('names gaps for a single engagement', () => {
    expect(sheetHeader([toDraft(dto({ lowConfidence: ['ends'], assumed: ['year'] }))], 0))
      .toBe('ONE ENGAGEMENT · TWO GAPS')
  })

  /* A clash is about the engagement landing on something else; a gap is about the engagement being
     wrong. Only one of them can lead. */
  it('lets a clash outrank a gap', () => {
    expect(sheetHeader([toDraft(dto({ assumed: ['year'] }))], 1)).toBe('ONE ENGAGEMENT · ONE CLASH')
  })

  it('says nothing alarming when everything was read cleanly', () => {
    expect(sheetHeader([toDraft(dto())], 0)).toBe('FOUND ON THE PHOTO')
  })
})

describe('footnoteFor', () => {
  it('counts the lines it struggled with', () => {
    const note = footnoteFor(toDraft(dto({ lowConfidence: ['ends', 'where'] })))
    expect(note).toEqual({ tone: 'amber', text: 'Two lines were hard to read. Amber means check it.' })
  })

  it('names what was not on the photograph at all', () => {
    const note = footnoteFor(toDraft(dto({ assumed: ['year', 'ends'] })))
    expect(note?.text).toBe("The year and the finish weren't on it. Amber means check it.")
  })

  /* Brass, not amber: an all-day engagement having no hours is the feature working correctly, and
     drawing it as a warning would train the household to ignore the real ones. */
  it('states the all-day case in brass rather than warning about it', () => {
    const note = footnoteFor(toDraft(dto({ allDay: true, begins: null, ends: null })))
    expect(note).toEqual({ tone: 'brass', text: 'All day, so it carries no begin or finish.' })
  })

  it('says nothing at all when everything was read off the photograph', () => {
    expect(footnoteFor(toDraft(dto()))).toBeNull()
  })
})

describe('defaultCalendar', () => {
  const calendars = [
    { calendarId: 'mine', name: 'Personal', isPrimary: true },
    { calendarId: 'theo-school', name: 'Theo · school', isPrimary: false },
    { calendarId: 'work', name: 'Work', isPrimary: false },
  ]
  const people = [{ name: 'Theo' }, { name: 'Ada' }]

  it('follows the person the message named', () => {
    expect(defaultCalendar(calendars, people, "here's Theo's camp flyer")).toBe('theo-school')
  })

  it('falls back to the primary when nobody is named', () => {
    expect(defaultCalendar(calendars, people, 'what does this say?')).toBe('mine')
  })

  /* Named in passing, with no calendar of their own. Not a reason to pick somebody else's. */
  it('ignores a person with no calendar to their name', () => {
    expect(defaultCalendar(calendars, people, 'Ada gave me this one')).toBe('mine')
  })

  it('is not fooled by a name inside a longer word', () => {
    expect(defaultCalendar(calendars, [{ name: 'Ada' }], 'the parade is on Saturday')).toBe('mine')
  })

  it('treats a name with punctuation as text, not as a pattern', () => {
    const odd = [{ calendarId: 'aj', name: 'A.J. · swimming', isPrimary: false }, ...calendars]
    expect(defaultCalendar(odd, [{ name: 'A.J.' }], 'A.J. brought this home')).toBe('aj')
    // The literal name, not the regex it would otherwise be: "AXJY" must not match "A.J.".
    expect(defaultCalendar(odd, [{ name: 'A.J.' }], 'AXJY brought this home')).toBe('mine')
  })

  it('says nothing when the account has no writable calendars at all', () => {
    expect(defaultCalendar([], people, "Theo's flyer")).toBeNull()
  })
})
