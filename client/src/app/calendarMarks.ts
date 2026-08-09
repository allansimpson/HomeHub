/*
 * Calendar marks (spec 14) — the small icon a calendar line item carries so the household can read
 * an event's category from across the room.
 *
 * Two axes, and only two (CALENDAR_ICONS.md):
 *   1. the event's own kind, from the provider — birthday, holiday, from-gmail …
 *   2. the mark the household assigned to the whole calendar in CONFIG.
 * The event kind wins where they disagree: a birthday on the Work calendar is a birthday.
 *
 * Everything here is pure so the resolution can be tested and so changing a mark never re-fetches —
 * marks resolve client-side from already-cached events.
 */
import type { CalendarEventDto, EventKind } from '../api/types'
import type { IconId } from '../icons/Icon'

/** A mark the household can assign to a calendar. `none` is the explicit "no mark" choice. */
export type MarkKey =
  | 'school'
  | 'medical'
  | 'work'
  | 'hours'
  | 'house'
  | 'swim'
  | 'sport'
  | 'music'
  | 'dining'
  | 'book'
  | 'errand'
  | 'travel'
  | 'pet'
  | 'outdoors'
  | 'deadline'
  | 'post'
  | 'gift'
  | 'star'
  | 'cake'
  | 'none'

export interface MarkDefinition {
  key: MarkKey
  icon: IconId | null
  /** Caption in the picker, and the word the CONFIG meta line states (`MARK · SCHOOL`). */
  label: string
}

/** The 20 household marks, in the picker's reading order (spec 14 — 5 columns of 4). */
export const HOUSEHOLD_MARKS: MarkDefinition[] = [
  { key: 'school', icon: 'ico-mark-school', label: 'School' },
  { key: 'medical', icon: 'ico-mark-medical', label: 'Cross' },
  { key: 'work', icon: 'ico-mark-work', label: 'Briefcase' },
  { key: 'hours', icon: 'ico-mark-hours', label: 'Clock' },
  { key: 'house', icon: 'ico-mark-house', label: 'House' },
  { key: 'swim', icon: 'ico-mark-swim', label: 'Swim' },
  { key: 'sport', icon: 'ico-mark-sport', label: 'Sport' },
  { key: 'music', icon: 'ico-mark-music', label: 'Music' },
  { key: 'dining', icon: 'ico-mark-dining', label: 'Dining' },
  { key: 'book', icon: 'ico-mark-book', label: 'Book' },
  { key: 'errand', icon: 'ico-mark-errand', label: 'Errand' },
  { key: 'travel', icon: 'ico-mark-travel', label: 'Travel' },
  { key: 'pet', icon: 'ico-mark-pet', label: 'Pet' },
  { key: 'outdoors', icon: 'ico-mark-outdoors', label: 'Outdoors' },
  { key: 'deadline', icon: 'ico-mark-deadline', label: 'Deadline' },
  { key: 'post', icon: 'ico-mark-post', label: 'Post' },
  { key: 'gift', icon: 'ico-mark-gift', label: 'Gift' },
  { key: 'star', icon: 'ico-mark-star', label: 'Star' },
  { key: 'cake', icon: 'ico-mark-cake', label: 'Cake' },
  { key: 'none', icon: null, label: 'No mark' },
]

const BY_KEY = new Map<MarkKey, MarkDefinition>(HOUSEHOLD_MARKS.map((m) => [m.key, m]))

/** A stored calendar mark, tolerant of anything the free-form `icon` column may hold. */
export function markDefinition(key: string | null | undefined): MarkDefinition | null {
  if (!key) return null
  return BY_KEY.get(key as MarkKey) ?? null
}

/**
 * Where a mark came from. Drives colour: a guess must never look like a fact, so `inferred` renders
 * grey while everything else renders brass.
 */
export type MarkSource = 'event' | 'kind' | 'inferred' | 'calendar' | 'none'

export interface ResolvedMark {
  key: MarkKey | null
  icon: IconId | null
  source: MarkSource
  /** True when the event is deliberately never drawn (working-location). */
  silent: boolean
}

const NO_MARK: ResolvedMark = { key: null, icon: null, source: 'none', silent: false }
const SILENT: ResolvedMark = { key: null, icon: null, source: 'none', silent: true }

/**
 * Google's own words for an event. Anything else — including the literal `"default"` it sends for
 * ordinary events — means Google said nothing, so a kind alongside it was read off the title.
 *
 * Checked against the value rather than against null: the live account returns `"default"`, not
 * null, on the household's title-inferred birthdays, and treating that as Google's word would dress
 * every guess up as a fact.
 */
const STATED_EVENT_TYPES = new Set(['birthday', 'outOfOffice', 'focusTime', 'workingLocation', 'fromGmail'])

/** Kinds that carry their own mark. out-of-office and focus-time have none — they fall through. */
const KIND_MARKS: Partial<Record<EventKind, MarkKey>> = {
  birthday: 'cake',
  anniversary: 'gift',
  holiday: 'star',
  'from-gmail': 'post',
}

/** Household-assigned marks, keyed by Google calendar id (`SyncCalendarDto.icon`). */
export type CalendarMarks = ReadonlyMap<string, MarkKey>

/**
 * Resolve one event's mark. Order (spec 14, extended by the per-event override):
 *   1. the household chose a mark for this event → that mark, brass. The most specific statement
 *      there is, so it beats even a kind Google stated: someone looked at this event and said so.
 *   2. working-location is never drawn, at any size — Google emits one per weekday and they would
 *      drown the month. An explicit override at (1) is the one way to see one.
 *   3. the provider states a kind → that kind's mark, brass.
 *   4. a kind read off the title → the same mark, grey.
 *   5. otherwise the calendar's assigned mark, brass.
 *   6. no mark assigned → nothing in the grid, a plain hairline diamond in the agenda.
 */
export function resolveMark(event: CalendarEventDto, calendarMarks: CalendarMarks): ResolvedMark {
  const chosen = markDefinition(event.mark)
  if (chosen?.icon) return { key: chosen.key, icon: chosen.icon, source: 'event', silent: false }

  if (event.kind === 'working-location') return SILENT

  const kindMark = KIND_MARKS[event.kind]
  if (kindMark) {
    // Google's own word for it is the only thing that makes a kind *stated*; a holiday is stated by
    // the calendar it lives on. A birthday read off the title is a good guess, and renders as one.
    const stated = event.kind === 'holiday' || STATED_EVENT_TYPES.has(event.googleEventType ?? '')
    return { key: kindMark, icon: BY_KEY.get(kindMark)!.icon, source: stated ? 'kind' : 'inferred', silent: false }
  }

  const assigned = event.googleCalendarId ? calendarMarks.get(event.googleCalendarId) : undefined
  const def = assigned ? BY_KEY.get(assigned) : undefined
  if (!def || !def.icon) return NO_MARK
  return { key: def.key, icon: def.icon, source: 'calendar', silent: false }
}

/**
 * The single mark a month-grid cell draws: one per day, the most significant kind. Birthday (and its
 * anniversary sibling) beats a holiday, which beats the first event's calendar mark. Never a second
 * icon — extras are carried by the overflow rule instead.
 */
export function resolveDayMark(
  events: CalendarEventDto[],
  calendarMarks: CalendarMarks,
): { mark: ResolvedMark | null; drawn: number } {
  const marks = events.map((e) => resolveMark(e, calendarMarks)).filter((m) => !m.silent)

  const rank = (m: ResolvedMark) => (m.key === 'cake' || m.key === 'gift' ? 0 : m.key === 'star' ? 1 : 2)
  let best: ResolvedMark | null = null
  for (const m of marks) {
    if (!m.icon) continue
    if (!best || rank(m) < rank(best)) best = m
  }
  // `drawn` counts the day's visible events, not its marks: a working-location-only day is empty as
  // far as the grid is concerned, and must not sprout an overflow rule.
  return { mark: best, drawn: marks.length }
}

/**
 * Whether an event occupies whole days. Google all-day events arrive as local midnight to midnight;
 * nothing else in the payload distinguishes them.
 */
export function isAllDay(event: CalendarEventDto): boolean {
  const start = new Date(event.startUtc)
  const end = new Date(event.endUtc)
  const spansWholeDays = end.getTime() - start.getTime() >= 23 * 60 * 60 * 1000
  return spansWholeDays && start.getHours() === 0 && start.getMinutes() === 0
}

/**
 * The meta line under an agenda title: `ALL DAY · WORK · READ FROM THE TITLE`. Says where the mark
 * came from in the household's words, so an inferred cake explains itself.
 */
export function markMeta(event: CalendarEventDto, mark: ResolvedMark): string {
  const parts: string[] = []
  if (isAllDay(event)) parts.push('All day')
  if (event.calendarName) parts.push(event.calendarName)
  if (mark.source === 'inferred') parts.push('Read from the title')
  // Only an ordinary event is *unmarked*; a working-location block has a kind, it is simply one the
  // panel refuses to draw, and saying "no mark assigned" of it would be a lie.
  else if (mark.source === 'none' && !mark.silent && event.kind === 'default' && event.googleCalendarId) {
    parts.push('No mark assigned')
  }
  return parts.join(' · ')
}
