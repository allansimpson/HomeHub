import { countWord } from '../../app/eventDrafts'
import type { DraftEventDto } from '../../api/types'
import type { WrittenEvent } from './EventConfirmSheet'

/**
 * The wording either side of the confirm sheet, and the one rule about when to skip it.
 *
 * Pure, and apart from the hook that uses it, because every sentence here is a claim about what the
 * panel just did to a household's calendar. A receipt that says "the photo is kept" when it was not,
 * or names one engagement when it wrote four, is worse than no receipt — it is a receipt somebody
 * would be right to trust.
 */

/**
 * Whether the offer should be skipped because the member already asked for it.
 *
 * <b>Deliberately narrow.</b> "Here's the camp flyer, add it to the calendar" is somebody who has
 * already decided, and asking "shall I put it on the calendar?" in reply is the panel not listening.
 * But the cost of a false positive is worse than the cost of a false negative: reading intent into
 * "what does this say about the camp?" skips the offer and puts a sheet in front of somebody who
 * asked a question. So this wants a verb of writing *and* a word for where it goes, and stays quiet
 * about anything less.
 */
export function declaresIntent(prompt: string): boolean {
  const text = prompt.toLowerCase()
  const writes = [...text.matchAll(/\b(add|put|pop|stick|save|book|schedule|diarise|diarize)\b/g)]
  const places = [...text.matchAll(/\b(calendar|diary|schedule|agenda)\b/g)]
  // Two *different* words, which is not the same test as one word from each list. "Schedule" is in
  // both — it is a verb and a place — so "the paddock schedule is unreadable" satisfied both halves
  // with a single noun and skipped the offer on a sentence that asked for nothing at all.
  return writes.some((w) => places.some((p) => p.index !== w.index))
}

/**
 * Whether a reading is worth speaking about.
 *
 * The gate on the offer, and the reason the read itself is allowed to be automatic: the only way to
 * find out whether a photograph has a date on it is to look, but a photo of the cat must not produce
 * a sentence. A date is guaranteed — a draft without one is not a draft — so a name is the bar.
 */
export function offersAnEvent(drafts: readonly DraftEventDto[]): boolean {
  return drafts.some((d) => d.title.trim().length > 0)
}

/** "Saturday 14 September". */
export function longDate(d: Date): string {
  const weekday = d.toLocaleDateString('en-GB', { weekday: 'long' })
  const month = d.toLocaleDateString('en-GB', { month: 'long' })
  return `${weekday} ${d.getDate()} ${month}`
}

/** "14 September" — the batch form, where the weekday is noise four times over. */
export function shortDate(d: Date): string {
  return `${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'long' })}`
}

/** "10 AM", "10:30 AM" — the way somebody would say it rather than the way a clock shows it. */
export function spokenTime(d: Date): string {
  const hour = d.getHours() % 12 || 12
  const minutes = d.getMinutes()
  const ampm = d.getHours() < 12 ? 'AM' : 'PM'
  return minutes === 0 ? `${hour} ${ampm}` : `${hour}:${String(minutes).padStart(2, '0')} ${ampm}`
}

/** "14 and 20 September, 30 September and 7 July" — a list somebody could read aloud. */
function dateList(events: readonly WrittenEvent[]): string {
  const days = events.map((e) => shortDate(new Date(e.startUtc)))
  if (days.length <= 1) return days[0] ?? ''
  return `${days.slice(0, -1).join(', ')} and ${days[days.length - 1]}`
}

/**
 * What Barnaby says once the engagements are on the calendar.
 *
 * Names what was written rather than announcing success: "Written down" and then the thing itself,
 * so somebody who walks up to the panel afterwards can tell what happened without pressing anything.
 */
export function confirmationProse(written: readonly WrittenEvent[]): string {
  if (written.length === 0) return ''
  const calendar = written[0].calendarName
  const on = calendar ? `, on ${calendar}` : ''

  if (written.length > 1) {
    return `Written down — ${countWord(written.length)} dates, ${dateList(written)}${on}.`
  }

  const only = written[0]
  const at = new Date(only.startUtc)
  const when = only.isAllDay ? longDate(at) : `${longDate(at)} at ${spokenTime(at)}`
  return `Written down — ${only.title}, ${when}${on}.`
}

/**
 * The IT TOUCHED rows.
 *
 * <b>The photo line is conditional on the photo, not on the intention.</b> Retention can be off in
 * Config, and the format can be one the panel will not store — and in both cases the receipt has to
 * stop claiming a picture was kept. A receipt that overstates by one line is the kind of thing
 * nobody checks until they go looking for the flyer.
 */
export function receiptLines(written: readonly WrittenEvent[], photoKept: boolean): string[] {
  if (written.length === 0) return []
  const calendar = written[0].calendarName ?? 'The shared calendar'
  const count = written.length

  const lines = [
    count > 1
      ? `${calendar} was written to · ${count} engagements`
      : `${calendar} was written to`,
  ]
  if (photoKept) {
    lines.push(count > 1
      ? `The photo is kept with all ${countWord(count)}`
      : 'The photo is kept with the engagement')
  }
  return lines
}
