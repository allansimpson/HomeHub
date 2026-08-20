import type { EventDraft } from './eventDrafts'

/**
 * The fields a reading can reach on the New Engagement form.
 *
 * `kind` is the TIMED / ALL DAY pair rather than a text row — a photograph with a date and no hour
 * is an all-day engagement, and that is a value the reading produces like any other.
 */
export type FormField = 'title' | 'date' | 'kind' | 'begins' | 'ends' | 'where' | 'note'

/**
 * What a reading may do to a form somebody is already standing in front of.
 *
 * <b>Empty lines fill silently; lines you wrote are never overwritten.</b> That is the whole rule
 * (screen 23), and it is the one that makes reading a photo into an open form safe enough to do
 * without a confirmation sheet in front of it: the worst case is that nothing you typed changes.
 * Where the photograph disagrees with you, its value waits under the row behind a TAKE IT you can
 * press once, per field, and undo.
 */
export interface FillPlan {
  /** Fields the reading may write without asking. Empty when the reading found nothing for them. */
  fill: FormField[]
  /**
   * Fields where the photograph disagrees with something the household typed.
   *
   * Held back rather than applied, one offer per field. No bulk accept — the design is explicit
   * that these are pressed individually, because each one is a separate small judgement about whose
   * version is right.
   */
  offers: FormField[]
}

/**
 * Which fields a draft actually has something to say about.
 *
 * A reading that found no place has nothing to offer for WHERE, and an empty offer is worse than
 * none: it invites somebody to press TAKE IT and watch a filled row go blank.
 */
function stated(draft: EventDraft): FormField[] {
  const fields: FormField[] = ['title', 'date', 'kind']
  if (draft.begins !== null) fields.push('begins')
  if (draft.ends !== null) fields.push('ends')
  if (draft.where.trim().length > 0) fields.push('where')
  if (draft.note.trim().length > 0) fields.push('note')
  return fields.filter((f) => f !== 'title' || draft.title.trim().length > 0)
}

/**
 * How a reading lands on a form, given what the household has already touched.
 *
 * <b>Touched, not non-empty — and the difference is the whole thing.</b> The New Engagement form
 * opens with a date of today and an hour of next-o'clock already in its rows, so "has a value" would
 * describe every time field on a form nobody has typed into, and a reading would be reduced to
 * offering back what it just read. Screen 23 shows precisely this distinction working: BEGINS fills
 * silently at 10:00 while DATE — which the person had set — holds their Friday and offers the
 * photograph's Saturday underneath.
 *
 * So a default is not somebody's answer. Only an edit is.
 */
export function planFill(draft: EventDraft, touched: ReadonlySet<FormField>): FillPlan {
  const plan: FillPlan = { fill: [], offers: [] }
  for (const field of stated(draft)) {
    if (touched.has(field)) plan.offers.push(field)
    else plan.fill.push(field)
  }
  return plan
}

/**
 * The source strip's second line: what the reading did, counted.
 *
 * Says both halves out loud because both are reassurances, and the second is the one somebody
 * standing over a half-typed form actually wants: nothing of theirs was touched.
 */
export function fillSummary(plan: FillPlan, photoKept: boolean): string {
  const filled = plan.fill.length
  const left = plan.offers.length

  const first = filled === 0
    ? 'nothing filled'
    : `${countWord(filled)} empty ${filled === 1 ? 'line' : 'lines'} filled`

  const second = left > 0
    ? `${countWord(left)} of yours left alone`
    : photoKept ? 'kept with the engagement' : 'not kept'

  // Capitalised once, at the end. Building it from a capitalised count instead would have to know
  // which clause came first, and the second clause is lower-case in every arrangement.
  const summary = `${first} · ${second}`
  return summary.charAt(0).toUpperCase() + summary.slice(1)
}

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

/** Small counts as words — the strip is a sentence, not a readout. */
export function countWord(n: number): string {
  return WORDS[n] ?? String(n)
}

/** "Title", "Date" — how a field is named in "Title taken from the photo" (screen 24). */
export const FIELD_NAMES: Record<FormField, string> = {
  title: 'Title',
  date: 'Date',
  kind: 'Kind',
  begins: 'Begins',
  ends: 'Ends',
  where: 'Where',
  note: 'Note',
}
