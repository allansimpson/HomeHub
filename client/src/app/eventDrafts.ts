import { allDayBounds } from './dates'
import type { CalendarEventDto, DraftEventDto, DraftField } from '../api/types'

/**
 * An engagement read off a photograph, as the confirm sheet holds it while somebody looks at it.
 *
 * <b>Nothing here has been written, and nothing here is a fact yet.</b> The whole point of the sheet
 * is the gap between what a reading produced and what the household agreed to, so this carries both:
 * the values, and which of them were guessed. {@link amber} is the only thing on screen separating an
 * assumption from something that was actually printed on the flyer, which is why it is computed here
 * rather than left to the component to remember.
 *
 * Times are minutes since local midnight rather than instants, for the reason the whole feature keeps
 * running into: a flyer says "10 AM" and does not say where on earth it is. They become an instant at
 * confirm, on the device doing the confirming — see {@link boundsFor}.
 */
export interface EventDraft {
  id: string
  title: string
  /** Local calendar day. Midnight local, never used as an instant. */
  date: Date
  allDay: boolean
  /** Minutes since local midnight, or null when {@link allDay}. */
  begins: number | null
  ends: number | null
  where: string
  note: string
  /** Read badly, or filled by rule. Both draw the amber underline; they differ in the footnote. */
  lowConfidence: readonly DraftField[]
  assumed: readonly DraftField[]
  /** Ticked in the multi-engagement list. Everything found starts ticked. */
  selected: boolean
}

/** `HH:MM:SS` as minutes since midnight, or null. */
function minutesOf(time: string | null): number | null {
  if (!time) return null
  const [h, m] = time.split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  return h * 60 + m
}

/** `YYYY-MM-DD` as a local midnight. Deliberately not `new Date(string)`, which reads it as UTC. */
export function localDay(date: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

/** What the sheet starts from, one draft at a time. */
export function toDraft(dto: DraftEventDto): EventDraft {
  return {
    id: dto.id,
    title: dto.title,
    date: localDay(dto.date),
    allDay: dto.allDay,
    begins: minutesOf(dto.begins),
    ends: minutesOf(dto.ends),
    where: dto.where ?? '',
    note: dto.note ?? '',
    lowConfidence: dto.lowConfidence,
    assumed: dto.assumed,
    selected: true,
  }
}

/**
 * The fields that carry the amber underline.
 *
 * Low confidence and assumption are one treatment on screen and two sentences underneath: the
 * household does not need to know which kind of doubt a value carries in order to check it, but they
 * do need to know whether it came off the photograph at all.
 *
 * `year` is an assumption about the *date* row, which is where it has to be drawn — there is no year
 * field on the sheet to underline.
 */
export function amber(draft: EventDraft): Set<DraftField> {
  const fields = new Set<DraftField>()
  for (const f of draft.lowConfidence) fields.add(f)
  for (const f of draft.assumed) fields.add(f === 'year' ? 'date' : f)
  // An all-day engagement has no begin and no finish on the sheet, so doubt about them has nothing
  // to sit under — and drawing amber on a row that is not there would leave the footnote counting
  // lines nobody can see.
  if (draft.allDay) {
    fields.delete('begins')
    fields.delete('ends')
  }
  return fields
}

/**
 * The UTC boundaries to write, resolved on the confirming device.
 *
 * <b>Here rather than on the server, and that is a decision with a cost.</b> There is no household
 * timezone anywhere in HomeHub — times are UTC end to end and rendered local by the browser, which
 * has worked because every date so far arrived from somewhere else already anchored. This is the
 * first feature that has to *construct* an instant out of a printed date, and the device somebody is
 * standing at is the only thing in the system that knows a zone. The consequence is accepted rather
 * than hidden: a phone in another timezone produces a different midnight than the panel would.
 *
 * An all-day engagement sidesteps it entirely — the provider writes Google's bare `date` form, which
 * carries no zone at all.
 */
export function boundsFor(draft: EventDraft): { startUtc: string; endUtc: string } {
  if (draft.allDay) return allDayBounds(draft.date)

  const start = new Date(draft.date)
  start.setHours(0, draft.begins ?? 0, 0, 0)
  const end = new Date(draft.date)
  end.setHours(0, draft.ends ?? (draft.begins ?? 0) + 60, 0, 0)
  // A finish at or before the start is the one shape the write cannot take. It reaches here only by
  // somebody stepping the finish back past the start, so an hour is the least surprising repair.
  if (end.getTime() <= start.getTime()) end.setTime(start.getTime() + 60 * 60_000)
  return { startUtc: start.toISOString(), endUtc: end.toISOString() }
}

/**
 * Whether this draft can be written.
 *
 * <b>A proposed value counts as filled.</b> An assumed year and a finish an hour after the start are
 * confirmations, not blanks — they arrive under an amber underline, and blocking on them would ask
 * the household to retype something the panel has already got right. Only a genuinely unfillable
 * required field makes the action inert: no title, no date, or a timed engagement with no start.
 */
export function canWrite(draft: EventDraft): boolean {
  if (draft.title.trim().length === 0) return false
  if (Number.isNaN(draft.date.getTime())) return false
  return draft.allDay || draft.begins !== null
}

/** The drafts a press would write: everything ticked that can be written. */
export function writable(drafts: readonly EventDraft[]): EventDraft[] {
  return drafts.filter((d) => d.selected && canWrite(d))
}

/**
 * What is already on the chosen calendar at that hour.
 *
 * <b>Read from a mirror, and the copy says so.</b> The events table is an offline reflection of
 * Google, so an engagement somebody added on their phone ten minutes ago may not be in it yet. That
 * makes this an honest warning and not a guarantee, which is why the block says "already on that
 * hour" rather than claiming the hour is free when it finds nothing.
 *
 * All-day engagements are excluded on purpose: a whole-day marker overlaps everything on its day by
 * construction, and a clash block that fires on every school holiday is one nobody reads.
 */
export function clashesWith(
  draft: EventDraft,
  events: readonly CalendarEventDto[],
  calendarId: string | null,
): CalendarEventDto[] {
  if (draft.allDay) return []
  const { startUtc, endUtc } = boundsFor(draft)
  const from = Date.parse(startUtc)
  const to = Date.parse(endUtc)

  return events.filter((e) => {
    if (e.isAllDay) return false
    if (calendarId !== null && e.googleCalendarId !== null && e.googleCalendarId !== calendarId) return false
    const start = Date.parse(e.startUtc)
    const end = Date.parse(e.endUtc)
    // Touching ends do not overlap: an engagement that finishes at 10 and one that starts at 10 are
    // a morning, not a collision.
    return start < to && end > from
  })
}

/** So a household member called "A.J." cannot turn into a wildcard. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whether `text` says `word` as a word, rather than inside a longer one.
 *
 * <b>The boundary is applied per end, and only where there is one to apply.</b> `\b` sits between a
 * word character and a non-word character, so a name that begins or ends in punctuation has no
 * boundary to anchor against — `\bA\.J\.\b` never matches "A.J. brought this home", because the
 * full stop and the space that follows it are both non-word characters. A household member called
 * A.J. would silently stop being recognised, which is the sort of bug that only appears in one
 * house.
 */
function mentions(text: string, word: string): boolean {
  const left = /^\w/.test(word) ? '\\b' : ''
  const right = /\w$/.test(word) ? '\\b' : ''
  return new RegExp(`${left}${literal(word)}${right}`, 'i').test(text)
}

/**
 * Which calendar a photographed engagement should land on before anybody touches the chips.
 *
 * <b>The design asked for "the best guess from context", which is not a rule until somebody writes
 * one.</b> This is that rule, and it is deliberately two lines long: if the message the photo came
 * with names a household member, and that member has a writable calendar, use it — "here's Theo's
 * camp flyer" is somebody telling you whose it is. Otherwise the profile's primary calendar, which
 * is where a new engagement goes everywhere else in the product.
 *
 * <b>Nothing is read off the flyer itself.</b> The extractor never learns which calendars exist and
 * this never looks at what it returned; the guess is made from what a person typed and from the
 * account's own list. A photograph cannot influence where it lands, which is the same line the
 * tool-less seam draws one layer down.
 *
 * A wrong guess costs one tap on a chip that is right there. That is what makes a guess acceptable
 * here at all — and why it never silently picks a calendar the household cannot see the alternatives
 * to.
 */
export function defaultCalendar(
  calendars: readonly { calendarId: string; name: string; isPrimary: boolean }[],
  people: readonly { name: string }[],
  context: string,
): string | null {
  for (const person of people) {
    const name = person.name.trim()
    if (!name || !mentions(context, name)) continue
    // The calendar has to name them too. A household member mentioned in passing, with no calendar
    // of their own, is not a reason to pick somebody else's.
    const theirs = calendars.find((c) => mentions(c.name, name))
    if (theirs) return theirs.calendarId
  }
  return calendars.find((c) => c.isPrimary)?.calendarId ?? calendars[0]?.calendarId ?? null
}

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']

/** A small count as a word, because the sheet's headers are sentences and not counters. */
export function countWord(n: number): string {
  return WORDS[n] ?? String(n)
}

/**
 * The sheet's header line.
 *
 * It states what is in front of somebody before they read a single field: how many engagements, and
 * whether there is anything about them that needs a second look. A clash outranks a gap — one is
 * about this engagement being wrong, the other about it landing on top of something else.
 */
export function sheetHeader(drafts: readonly EventDraft[], clashes: number): string {
  const ticked = drafts.filter((d) => d.selected)
  if (drafts.length > 1) return `${countWord(drafts.length)} engagements found`.toUpperCase()

  const only = ticked[0] ?? drafts[0]
  if (!only) return 'FOUND ON THE PHOTO'
  if (clashes > 0) {
    return `one engagement · ${countWord(clashes)} ${clashes === 1 ? 'clash' : 'clashes'}`.toUpperCase()
  }
  const gaps = amber(only).size
  if (gaps > 0) return `one engagement · ${countWord(gaps)} ${gaps === 1 ? 'gap' : 'gaps'}`.toUpperCase()
  return 'FOUND ON THE PHOTO'
}

/** How a field reads in a sentence, rather than as a field name. */
const FIELD_WORDS: Record<DraftField, string> = {
  title: 'the name',
  date: 'the date',
  year: 'the year',
  begins: 'the start',
  ends: 'the finish',
  where: 'the place',
}

/** "the year and the finish", "the year, the finish and the place". */
function listOf(fields: readonly DraftField[]): string {
  const words = fields.map((f) => FIELD_WORDS[f] ?? f)
  if (words.length <= 1) return words[0] ?? ''
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

/**
 * The line under the fields, with the square that goes beside it.
 *
 * Brass is a statement and amber is a warning, and the difference matters more than it looks: an
 * all-day engagement having no hours is the feature working, while a line the reading struggled with
 * is something a person has to check. Drawing both in amber would train the household to ignore it.
 */
export function footnoteFor(draft: EventDraft): { tone: 'amber' | 'brass'; text: string } | null {
  const low = draft.lowConfidence.filter((f) => amber(draft).has(f))
  const assumed = draft.assumed.filter((f) => f !== 'ends' || !draft.allDay)

  if (low.length === 0 && assumed.length === 0) {
    return draft.allDay
      ? { tone: 'brass', text: 'All day, so it carries no begin or finish.' }
      : null
  }

  const clauses: string[] = []
  if (low.length > 0) {
    clauses.push(low.length === 1
      ? 'One line was hard to read.'
      : `${countWord(low.length)} lines were hard to read.`.replace(/^./, (c) => c.toUpperCase()))
  }
  if (assumed.length > 0) {
    clauses.push(`${listOf(assumed)} ${assumed.length === 1 ? "wasn't" : "weren't"} on it.`
      .replace(/^./, (c) => c.toUpperCase()))
  }
  clauses.push('Amber means check it.')
  return { tone: 'amber', text: clauses.join(' ') }
}
