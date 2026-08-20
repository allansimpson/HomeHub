import { describe, expect, it } from 'vitest'
import {
  CARE_MEDICINES, SINCE_ROWS, TIMED_TYPES, careWindowStart, clockLabel, countWord, dayLabel,
  detailLabel, elapsedLabel, entriesLabel, kindLabel,
  matchesSince, otherSide, sinceDetail,
  reviewSentence, tileCaption, valueLabel, windowTotals,
} from './care'
import type { CareEntryDto, CareEntryInput } from '../api/types'

/**
 * The sentences the Care tab says about a child's record.
 *
 * The design makes the review line the confirmation — no hold, no second dialogue, no undo — so what
 * it says is the whole of what somebody agreed to before pressing SAVE. These are the tests for what
 * it must never get wrong: a value nobody measured, or a field quietly left out.
 */

const entry = (over: Partial<CareEntryDto> = {}): CareEntryDto => ({
  id: 1, childKey: 'conrad', type: 'Bottle', atUtc: new Date().toISOString(),
  amount: 3.5, unit: 'oz', durationMinutes: null, kind: 'breast_milk', side: null,
  peeAmount: null, pooAmount: null, color: null, consistency: null, diaperRash: null,
  pounds: null, ounces: null, heightInches: null, headInches: null, notes: null,
  source: 'Panel', edited: false, clientKey: null, version: 1, ...over,
})

const at = new Date(2026, 7, 13, 21, 9)

describe('elapsedLabel', () => {
  const now = new Date(2026, 7, 13, 21, 0)
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString()

  it('reads the way the SINCE rows do', () => {
    expect(elapsedLabel(ago(34), now).value).toBe('34M')
    expect(elapsedLabel(ago(143), now).value).toBe('2H 23M')
    expect(elapsedLabel(ago(240), now).value).toBe('4H')
  })

  /* Past a day the question stops being "how long" and becomes "has it happened at all". */
  it('drops to whole days, and marks the row stale', () => {
    expect(elapsedLabel(ago(60 * 24 * 3 + 250), now)).toEqual({ value: '3D', stale: true })
    expect(elapsedLabel(ago(90), now).stale).toBe(false)
  })
})

describe('valueLabel', () => {
  it('shows an amount, a duration, or a weight', () => {
    expect(valueLabel(entry({ amount: 3.5, unit: 'oz' }))).toBe('3.5 oz')
    expect(valueLabel(entry({ amount: null, durationMinutes: 7 }))).toBe('7 min')
  })

  /*
   * The upstream bug this whole table exists to avoid: Huckleberry stores an unmeasured pump session
   * as `0 oz` and reports it back as though somebody had weighed it.
   */
  it('shows an em dash for a session nobody measured, never a zero', () => {
    expect(valueLabel(entry({ type: 'Pump', amount: null, durationMinutes: null }))).toBe('—')
  })

  it('drops false precision from a trailing zero', () => {
    expect(valueLabel(entry({ amount: 4.0, unit: 'oz' }))).toBe('4 oz')
    expect(valueLabel(entry({ amount: 3.75, unit: 'oz' }))).toBe('3.75 oz')
  })
})

describe('reviewSentence · bottle', () => {
  const bottle = (over: Partial<CareEntryInput> = {}): CareEntryInput => ({
    type: 'Bottle', amount: 3, unit: 'oz', kind: 'breast_milk', ...over,
  })

  /* What is written is what was taken, so the sentence names the offered figure too — otherwise
     somebody who dialled 4 offered cannot tell which of the two numbers was recorded. */
  it('names both ends when the bottle came back with something in it', () => {
    expect(reviewSentence(bottle({ amount: 3, offered: 4 }), at))
      .toBe('Writes 3 oz of breast milk at 9:09 PM, from 4 offered.')
  })

  /* A bottle finished clean has nothing to reconcile, and reads as it always did. */
  it('says it plainly when nothing was left', () => {
    expect(reviewSentence(bottle({ amount: 4, offered: 4 }), at))
      .toBe('Writes 4 oz of breast milk at 9:09 PM.')
    expect(reviewSentence(bottle({ amount: 3.5 }), at))
      .toBe('Writes 3.5 oz of breast milk at 9:09 PM.')
  })
})

describe('dayLabel', () => {
  const now = new Date(2026, 7, 15, 9, 0).getTime()

  /*
   * The boundary is local midnight, not "24 hours ago".
   *
   * The 1:25 AM feed is the case that decides it: it is eight hours old at breakfast, which by any
   * elapsed measure is the same distance as 5 PM yesterday — and it belongs under TODAY, because
   * the question a heading answers is which day the row is *on*.
   */
  it('names today from midnight, not from the last 24 hours', () => {
    expect(dayLabel(new Date(2026, 7, 15, 1, 25).toISOString(), now)).toBe('Today')
    expect(dayLabel(new Date(2026, 7, 15, 0, 0).toISOString(), now)).toBe('Today')
    expect(dayLabel(new Date(2026, 7, 14, 23, 59).toISOString(), now)).toBe('Yesterday')
    expect(dayLabel(new Date(2026, 7, 14, 17, 0).toISOString(), now)).toBe('Yesterday')
  })

  /*
   * Past yesterday the weekday leads — a week of entries is read by day name, not by date.
   *
   * Asserted by parts rather than as one string: the order and punctuation come from the panel's
   * locale, and pinning `Thursday, August 13` here would make this test a claim about en-US.
   */
  it('names the weekday and the date once a row is older than yesterday', () => {
    const label = dayLabel(new Date(2026, 7, 13, 17, 0).toISOString(), now)
    expect(label).toContain('Thursday')
    expect(label).toContain('August')
    expect(label).toContain('13')
  })
})

describe('entriesLabel', () => {
  it('counts in words to ten, then in figures, and gets the singular right', () => {
    expect(entriesLabel(0)).toBe('no entries')
    expect(entriesLabel(1)).toBe('one entry')
    expect(entriesLabel(9)).toBe('nine entries')
    expect(entriesLabel(14)).toBe('14 entries')
  })

  it('shares its word list with the selection count', () => {
    expect(countWord(2)).toBe('two')
    expect(countWord(11)).toBe('11')
  })
})

describe('detailLabel', () => {
  /*
   * The row this exists for. A diaper measures nothing, so the right-hand numeral column is an em
   * dash and the sub-line is the whole of what the record says — which kind it was.
   */
  it('names the kind on a diaper, where there is no amount to show', () => {
    expect(detailLabel(entry({ type: 'Diaper', amount: null, kind: 'pee' }))).toBe('Pee')
    expect(detailLabel(entry({ type: 'Diaper', amount: null, kind: 'poo' }))).toBe('Poo')
    expect(detailLabel(entry({ type: 'Diaper', amount: null, kind: 'dry' }))).toBe('Dry')
  })

  /* Size sits in one of two columns depending on the kind, and the row reads the same either way. */
  it('carries the size when one was recorded, wet or dirty', () => {
    expect(detailLabel(entry({ type: 'Diaper', amount: null, kind: 'poo', pooAmount: 'medium' })))
      .toBe('Medium poo')
    expect(detailLabel(entry({ type: 'Diaper', amount: null, kind: 'pee', peeAmount: 'big' })))
      .toBe('Big pee')
  })

  /* `both` on the wire, MIXED to the household — the same word everywhere it is shown. */
  it('says mixed, never both', () => {
    expect(detailLabel(entry({ type: 'Diaper', amount: null, kind: 'both' }))).toBe('Mixed')
    expect(tileCaption('Diaper', entry({ type: 'Diaper', kind: 'both' }))).toBe('Mixed')
    expect(kindLabel('both')).toBe('Mixed')
    expect(kindLabel('breast_milk')).toBe('Breast milk')
    expect(kindLabel(null)).toBeNull()
  })

  it('keeps the amount first on the types that have one', () => {
    expect(detailLabel(entry({ amount: 3.5, unit: 'oz', kind: 'breast_milk' }))).toBe('3.5 oz breast milk')
  })

  /* Side then duration, the way the design draws the row: `RIGHT 7M 35S`. */
  it('leads with the side on a nursing session', () => {
    expect(detailLabel(entry({ type: 'Nursing', amount: null, durationMinutes: 7.5833, side: 'right' })))
      .toBe('Right 7m 35s')
    expect(detailLabel(entry({ type: 'Sleep', amount: null, durationMinutes: 73 }))).toBe('1h 13m')
  })

  /*
   * An unmeasured pump session says so in words here, while the right-hand numeral column stays an
   * em dash. Both halves matter: the dash is what stops the upstream `0 oz` being re-invented, and
   * the words are what stop a blank reading as data that failed to load.
   */
  it('says why a pump session has no amount, and still shows no number for it', () => {
    const unmeasured = entry({ type: 'Pump', amount: null, durationMinutes: null })
    expect(detailLabel(unmeasured)).toBe('No amount recorded')
    expect(valueLabel(unmeasured)).toBe('—')
  })
})

describe('SINCE rows · wet and dirty', () => {
  const pee = SINCE_ROWS.find((r) => r.key === 'diaper-pee')!
  const poo = SINCE_ROWS.find((r) => r.key === 'diaper-poo')!

  /*
   * The whole reason they are two rows: a wet nappy an hour ago says nothing about how long it has
   * been since a dirty one, and one `Diaper` row let the wet one reset both clocks.
   */
  it('keeps the two clocks apart', () => {
    const wet = entry({ type: 'Diaper', amount: null, kind: 'pee' })
    expect(matchesSince(pee, wet)).toBe(true)
    expect(matchesSince(poo, wet)).toBe(false)
  })

  /* A mixed nappy contained both, so it answers both. */
  it('lets a mixed nappy satisfy both', () => {
    const mixed = entry({ type: 'Diaper', amount: null, kind: 'both' })
    expect(matchesSince(pee, mixed)).toBe(true)
    expect(matchesSince(poo, mixed)).toBe(true)
  })

  /*
   * Each row reports its *own* size. A mixed nappy carries a figure for each half, and showing the
   * poo's on the wet row would be the wrong number stated with complete confidence.
   */
  it('reports each half its own size', () => {
    const mixed = entry({
      type: 'Diaper', amount: null, kind: 'both', peeAmount: 'big', pooAmount: 'little',
    })
    expect(sinceDetail(pee, mixed)).toBe('Big pee · mixed')
    expect(sinceDetail(poo, mixed)).toBe('Little poo · mixed')
  })

  it('says which half it is even with no size recorded', () => {
    expect(sinceDetail(poo, entry({ type: 'Diaper', amount: null, kind: 'poo' }))).toBe('Poo')
  })
})

describe('careWindowStart', () => {
  /*
   * The whole reason the window is not a calendar day: a 1:25 AM bottle belongs to the night that
   * began the previous morning. Split it at midnight and the 2am totals read as though almost
   * nothing had been given, which is the opposite of true.
   */
  it('reaches back to yesterday morning before 6 AM', () => {
    expect(careWindowStart(new Date(2026, 7, 13, 1, 25))).toEqual(new Date(2026, 7, 12, 6, 0, 0, 0))
    expect(careWindowStart(new Date(2026, 7, 13, 5, 59))).toEqual(new Date(2026, 7, 12, 6, 0, 0, 0))
  })

  it('rolls to this morning at 6 AM', () => {
    expect(careWindowStart(new Date(2026, 7, 13, 6, 0))).toEqual(new Date(2026, 7, 13, 6, 0, 0, 0))
    expect(careWindowStart(new Date(2026, 7, 13, 21, 9))).toEqual(new Date(2026, 7, 13, 6, 0, 0, 0))
  })
})

describe('windowTotals', () => {
  const atTime = (hour: number, minute = 0) => new Date(2026, 7, 13, hour, minute).toISOString()

  it('sums bottles and names the last one', () => {
    const rows = windowTotals([
      entry({ type: 'Bottle', amount: 3.5, atUtc: atTime(8, 33) }),
      entry({ type: 'Bottle', amount: 4, atUtc: atTime(11) }),
    ])
    const bottle = rows.find((r) => r.type === 'Bottle')
    expect(bottle).toMatchObject({ detail: '2 bottles · last 11:00 AM', value: '7.5', unit: 'oz' })
  })

  /* The upstream bug again, at the totals level: three unmeasured sessions counted as `0 oz` would
     make a total that reads as a measurement of four. It says how many it could not count. */
  it('says how many pump sessions had no amount', () => {
    const rows = windowTotals([
      entry({ type: 'Pump', amount: 11.5, durationMinutes: null, atUtc: atTime(7) }),
      entry({ type: 'Pump', amount: null, durationMinutes: null, atUtc: atTime(10) }),
      entry({ type: 'Pump', amount: null, durationMinutes: null, atUtc: atTime(13) }),
    ])
    expect(rows.find((r) => r.type === 'Pump')).toMatchObject({
      detail: '3 sessions · 2 with no amount',
      value: '11.5',
      unit: 'oz',
    })
  })

  /* Every row is always present. An absence is a fact, and one that disappears cannot be read. */
  it('keeps an empty type as a dimmed zero rather than dropping the row', () => {
    const rows = windowTotals([entry({ type: 'Bottle', amount: 3, atUtc: atTime(9) })])
    expect(rows).toHaveLength(6)
    expect(rows.find((r) => r.type === 'Diaper')).toEqual({
      type: 'Diaper', detail: 'None in this window', value: '0', unit: null, dim: true,
    })
  })

  /*
   * Six rows, which is the count the block's height is built from — see `--care-rows`. A type
   * dropped from here leaves the TODAY page a row short of its neighbours and looking clipped.
   */
  it('reports the six types the page is sized for', () => {
    expect(windowTotals([]).map((r) => r.type))
      .toEqual(['Bottle', 'Nursing', 'Pump', 'Diaper', 'Medicine', 'Sleep'])
  })

  /* Minutes, like nursing — not hours, which on a 6 AM–6 AM window reads as a share of a day. */
  it('sums sleep in minutes and names the last one', () => {
    const rows = windowTotals([
      entry({ type: 'Sleep', amount: null, durationMinutes: 95, atUtc: atTime(9, 15) }),
      entry({ type: 'Sleep', amount: null, durationMinutes: 42.4, atUtc: atTime(13) }),
    ])
    expect(rows.find((r) => r.type === 'Sleep')).toMatchObject({
      detail: '2 sleeps · last 1:00 PM', value: '137', unit: 'M',
    })
  })

  /*
   * Minutes with an `M` beside them — the same unit letter the elapsed figures and the entry rows
   * carry. A colon clock was a third way of writing a duration on a block that already had one.
   */
  it('reads a nursing total in minutes', () => {
    const rows = windowTotals([
      entry({ type: 'Nursing', amount: null, durationMinutes: 7.5833, side: 'right', atUtc: atTime(16, 58) }),
    ])
    expect(rows.find((r) => r.type === 'Nursing')).toMatchObject({
      detail: '1 session · right', value: '8', unit: 'M',
    })
  })
})

describe('tileCaption', () => {
  it('shows the value the sheet will open on', () => {
    expect(tileCaption('Bottle', entry({ amount: 3.5, unit: 'oz' }))).toBe('3.5 oz')
    expect(tileCaption('Diaper', entry({ type: 'Diaper', kind: 'poo' }))).toBe('Poo')
  })

  /*
   * A session type says so, rather than reporting the last one's length.
   *
   * The caption is what the panel will open on, and for these it opens on a start button. `12 min`
   * would promise a stepper that is no longer the first thing on the sheet.
   */
  it('captions a session type as a timer', () => {
    expect(tileCaption('Sleep', entry({ type: 'Sleep', durationMinutes: 45 }))).toBe('Timer')
    expect(tileCaption('TummyTime', entry({ type: 'TummyTime', durationMinutes: 12 }))).toBe('Timer')
  })

  /* Every timed type has to be one, or `CareLogView` writes an entry where it should open a
     session — the two lists are read together and drifted apart once already. */
  it('lists tummy time among the timed types', () => {
    expect(TIMED_TYPES).toEqual(['Nursing', 'Sleep', 'Pump', 'TummyTime'])
  })

  /* Nursing inverts on purpose: the side offered is the opposite of the last one used. */
  it('offers the other side for nursing', () => {
    expect(tileCaption('Nursing', entry({ type: 'Nursing', side: 'right' }))).toBe('Timer · left next')
    expect(otherSide('left')).toBe('right')
    expect(otherSide(null)).toBeNull()
  })

  /* The three the household actually gives, each with the dose it is given at — so choosing a name
     on the panel fills the stepper and the ordinary entry is two taps. */
  it('knows the household medicines and their doses', () => {
    expect(CARE_MEDICINES).toEqual([
      { name: 'Pepcid', amount: 0.6, unit: 'ml' },
      { name: 'Vitamin D', amount: 0.25, unit: 'ml' },
      { name: 'Simethicone', amount: 0.25, unit: 'ml' },
    ])
  })

  /* Both of these read a number without the noun that makes it mean anything, until they don't:
     the pump tile reports the two phase lengths it will open on, and medicine names the drug. */
  it('reports the pump phases and the medicine, not a bare figure', () => {
    expect(tileCaption('Pump', entry({ type: 'Pump', amount: null }))).toBe('3 + 17 min')
    expect(tileCaption('Medicine', entry({ type: 'Medicine', amount: 0.6, unit: 'ml', kind: 'Pepcid' })))
      .toBe('0.6 ml Pepcid')
  })

  /* A type nobody has logged says so, rather than showing a plausible zero. */
  it('says there is no record rather than inventing one', () => {
    expect(tileCaption('Bath', undefined)).toBe('No record')
    expect(tileCaption('Solids', undefined)).toBe('Not started')
  })
})

describe('reviewSentence', () => {
  const input = (over: Partial<CareEntryInput>): CareEntryInput => ({ type: 'Bottle', ...over })

  it('states a bottle in full', () => {
    expect(reviewSentence(input({ amount: 3.5, unit: 'oz', kind: 'breast_milk' }), at))
      .toBe('Writes 3.5 oz of breast milk at 9:09 PM.')
  })

  /*
   * The design's own wording, and the reason for it: an unfilled optional field should be a visible
   * choice rather than a silent gap. Somebody who meant to record a colour sees that they did not.
   */
  it('names what was left out of a diaper', () => {
    expect(reviewSentence(input({ type: 'Diaper', kind: 'poo', pooAmount: 'medium' }), at))
      .toBe('Writes a medium poo at 9:09 PM, no colour or consistency.')
  })

  it('stops naming omissions once they are filled', () => {
    expect(reviewSentence(input({ type: 'Diaper', kind: 'poo', pooAmount: 'medium', color: 'yellow', consistency: 'loose' }), at))
      .toBe('Writes a medium poo at 9:09 PM.')
  })

  it('states a typed nursing session with its side and start', () => {
    expect(reviewSentence(input({ type: 'Nursing', durationMinutes: 8, side: 'left' }), at))
      .toBe('Writes 8 minutes on the left, starting 9:09 PM.')
  })

  /* "no amount" said out loud, because it is the ordinary case and must not read as an oversight. */
  it('says a pump session has no amount rather than printing a zero', () => {
    expect(reviewSentence(input({ type: 'Pump' }), at))
      .toBe('Writes a session with no amount at 9:09 PM.')
    expect(reviewSentence(input({ type: 'Pump', amount: 11.5, unit: 'oz' }), at))
      .toBe('Writes a session with 11.5 oz at 9:09 PM.')
  })

  /*
   * The typed route says so, because the pump panel offers two and SAVE belongs to only one.
   *
   * START SESSION runs a session whose amount is asked for at the end; SAVE writes one that is
   * already over and whose amount is therefore in hand. Naming the route is what keeps the two from
   * reading as rivals — and a length is what tells them apart, since a session started here has
   * none until it finishes.
   */
  it('names the typed route when a pump session carries its own length', () => {
    expect(reviewSentence(input({ type: 'Pump', durationMinutes: 25 }), at))
      .toBe('Writes the typed session: 25 min, no amount, from 9:09 PM.')
    expect(reviewSentence(input({ type: 'Pump', durationMinutes: 25, amount: 4, unit: 'oz' }), at))
      .toBe('Writes the typed session: 25 min, 4 oz, from 9:09 PM.')
  })

  it('states a medicine with its dose and name', () => {
    expect(reviewSentence(input({ type: 'Medicine', amount: 0.6, unit: 'ml', kind: 'Pepcid' }), at))
      .toBe('Writes 0.6 ml of Pepcid at 9:09 PM.')
  })

  it('has a sentence for every one of the ten types', () => {
    for (const type of ['Bottle', 'Nursing', 'Pump', 'Diaper', 'Solids', 'Sleep', 'Medicine', 'Bath', 'TummyTime', 'Temperature'] as const) {
      const sentence = reviewSentence(input({ type }), at)
      expect(sentence.startsWith('Writes ')).toBe(true)
      expect(sentence.endsWith('.')).toBe(true)
      // Never a bare "undefined" or "null" leaking into a medical record.
      expect(sentence).not.toMatch(/undefined|null|NaN/)
    }
  })
})

describe('clockLabel', () => {
  it('says the hour the way the log does', () => {
    expect(clockLabel(new Date(2026, 7, 13, 21, 9))).toBe('9:09 PM')
    expect(clockLabel(new Date(2026, 7, 13, 0, 5))).toBe('12:05 AM')
    expect(clockLabel(new Date(2026, 7, 13, 12, 0))).toBe('12:00 PM')
  })
})
