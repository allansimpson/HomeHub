import { describe, expect, it } from 'vitest'
import {
  cookedAgoLabel, cookedCountLabel, countWord, daysSinceCooked, durationLabel, entriesFor,
  formatAmount, matchesAtWordBoundary, nextComponent, nextFreeSlot, nightSchedule, plannedCount,
  scalableLines, scaleLine, schedulableEntries, startBy, unconfirmedPastDinner, weekLabel, weekStart,
} from './mealsDomain'
import type { MealDayDto, MealPlanEntryDto, MealWeekDto } from '../api/types'

/**
 * The Meals section's derived values.
 *
 * These are the functions that decide what quantities go in the pan and when to start cooking, so
 * they are the part of the client most worth pinning down: a wrong number here is silently wrong on
 * a wall, with nobody to notice until dinner is short.
 */

// ---- Amount formatting ----

describe('formatAmount', () => {
  /**
   * Precision by magnitude, not by arithmetic. Scaling 500g by 8/6 gives 666.667, and both obvious
   * renderings of that are useless in a kitchen: `666 2/3g` asks for two-thirds of a gram and
   * `666.67g` asks for a hundredth.
   */
  it('rounds weights and volumes to something a scale can show', () => {
    expect(formatAmount(666.667, false)).toBe('665')
    expect(formatAmount(533.33, false)).toBe('535')
    expect(formatAmount(166.667, false)).toBe('165')
    expect(formatAmount(1000, false)).toBe('1000')
  })

  it('rounds mid-range amounts to whole units', () => {
    expect(formatAmount(24.4, false)).toBe('24')
    expect(formatAmount(20, false)).toBe('20')
  })

  /** Small amounts are where spoons and cups live, and there fractions are what a recipe says. */
  it('keeps fractions where a recipe would use them', () => {
    expect(formatAmount(1.333, true)).toBe('1 1/3')
    expect(formatAmount(0.5, true)).toBe('1/2')
    expect(formatAmount(2.667, true)).toBe('2 2/3')
    expect(formatAmount(0.75, true)).toBe('3/4')
  })

  it('does not manufacture a fraction out of floating-point dust', () => {
    expect(formatAmount(3.001, true)).toBe('3')
    expect(formatAmount(2, true)).toBe('2')
  })

  it('never renders a zero or negative amount as a fraction', () => {
    expect(formatAmount(0, true)).toBe('0')
    expect(formatAmount(-5, true)).toBe('0')
    expect(formatAmount(Number.NaN, true)).toBe('0')
  })
})

// ---- Scaling a line ----

describe('scaleLine', () => {
  /**
   * The governing rule of the whole section: `rawText` is what the panel renders, and only the
   * amount at the *front* of the line is ever substituted. Everything the source wrote survives.
   */
  it('substitutes only the leading amount and keeps every other word', () => {
    expect(scaleLine('2 cloves garlic, finely sliced', 2, 2))
      .toBe('4 cloves garlic, finely sliced')
    expect(scaleLine('1/2 cup coconut milk', 0.5, 3))
      .toBe('1 1/2 cup coconut milk')
  })

  /**
   * A line the parser could not read comes back untouched — the AS WRITTEN state. Guessing an
   * amount for it would be worse than leaving the cook to do the arithmetic.
   */
  it('leaves an unparsed line exactly as written', () => {
    expect(scaleLine('Salt and pepper to taste', null, 4))
      .toBe('Salt and pepper to taste')
  })

  it('is a no-op at the recipe’s own scale', () => {
    expect(scaleLine('2 tbsp olive oil', 2, 1)).toBe('2 tbsp olive oil')
  })

  /**
   * A quantity the parser found mid-line has no leading token to replace. Substituting anywhere
   * else risks rewriting a word, so the line stands.
   */
  it('leaves a line whose amount is not at the front alone', () => {
    expect(scaleLine('Chicken, about 4 thighs', 4, 2)).toBe('Chicken, about 4 thighs')
  })

  it('keeps decimals decimal and fractions fractional', () => {
    // Written as a decimal, so it stays one rather than acquiring a fraction it never had.
    expect(scaleLine('0.5 kg mince', 0.5, 2)).toBe('1 kg mince')
    expect(scaleLine('1/4 cup capers', 0.25, 2)).toBe('1/2 cup capers')
  })
})

describe('scalableLines', () => {
  it('counts only the lines that carry a quantity', () => {
    expect(scalableLines([{ quantity: 1 }, { quantity: null }, { quantity: 0.5 }]))
      .toEqual({ scalable: 2, total: 3 })
  })
})

// ---- Start-by ----

const at = (h: number, m: number) => new Date(2026, 7, 1, h, m)

describe('startBy', () => {
  it('works back from dinner and rounds down to five minutes', () => {
    const s = startBy('18:30', 35, at(17, 0))!
    expect(s.start).toBe('17:55')
    expect(s.serve).toBe('18:30')
  })

  it('rounds down rather than up, so the cook time is never shortened', () => {
    // 18:30 − 12 = 18:18, which floors to 18:15 — three minutes of slack, not a lost three.
    expect(startBy('18:30', 12, at(17, 0))!.start).toBe('18:15')
  })

  /**
   * A recipe that never said how long it takes cannot be turned into a time to start cooking. The
   * screen hides the block and keeps the dish rather than showing `0 MIN`.
   */
  it('returns nothing when the recipe has no total time', () => {
    expect(startBy('18:30', null, at(17, 0))).toBeNull()
    expect(startBy('18:30', 0, at(17, 0))).toBeNull()
  })

  it('reports lateness once the start time has passed', () => {
    expect(startBy('18:30', 35, at(17, 0))!.lateBy).toBeLessThan(0)
    expect(startBy('18:30', 35, at(18, 10))!.lateBy).toBe(15)
  })

  it('refuses an unparseable dinner time rather than guessing one', () => {
    expect(startBy('half six', 35, at(17, 0))).toBeNull()
    expect(startBy('25:00', 35, at(17, 0))).toBeNull()
  })
})

// ---- The night's order ----

const entry = (over: Partial<MealPlanEntryDto>): MealPlanEntryDto => ({
  id: 1, date: '2026-08-01', slot: 'Dinner', recipeId: 1, recipeTitle: 'Dish',
  recipeHasImage: false, freeText: null, servingsOverride: null, wasEaten: null,
  position: 0, role: 'Main', totalMinutes: null, version: 1, ...over,
})

describe('nightSchedule', () => {
  it('orders components by when each has to start', () => {
    const rows = nightSchedule(schedulableEntries([
      entry({ id: 1, recipeId: 1, recipeTitle: 'Garlic Toast', totalMinutes: 12, position: 1, role: 'Side' }),
      entry({ id: 2, recipeId: 2, recipeTitle: 'Bolognese', totalMinutes: 35, position: 0 }),
    ]), '18:30').rows

    expect(rows.map((r) => [r.start, r.title])).toEqual([
      ['17:55', 'Bolognese'],
      ['18:15', 'Garlic Toast'],
    ])
  })

  /**
   * A component with no cook time is still a dish somebody has to make. Dropping it would be the
   * panel quietly forgetting part of dinner, so it is listed last rather than at an invented time.
   */
  it('lists an untimed component last rather than dropping it', () => {
    const rows = nightSchedule(schedulableEntries([
      entry({ id: 1, recipeId: 1, recipeTitle: 'Salad', totalMinutes: null, position: 1, role: 'Side' }),
      entry({ id: 2, recipeId: 2, recipeTitle: 'Roast', totalMinutes: 90, position: 0 }),
    ]), '18:30').rows

    expect(rows.map((r) => r.title)).toEqual(['Roast', 'Salad'])
    expect(rows[1].start).toBeNull()
  })
})

describe('nextComponent', () => {
  const rows = nightSchedule(schedulableEntries([
    entry({ id: 1, recipeId: 1, recipeTitle: 'Bolognese', totalMinutes: 35, position: 0 }),
    entry({ id: 2, recipeId: 2, recipeTitle: 'Toast', totalMinutes: 12, position: 1, role: 'Side' }),
  ]), '18:30').rows

  it('names the next component and how far off it is', () => {
    const next = nextComponent(rows, at(18, 0))!
    expect(next.row.title).toBe('Toast')
    expect(next.minutesAway).toBe(15)
  })

  /** The dish you are already standing over is not "next". */
  it('skips the recipe being cooked', () => {
    expect(nextComponent(rows, at(17, 30), 1)!.row.title).toBe('Toast')
  })

  it('treats a component due this minute as due, not passed', () => {
    expect(nextComponent(rows, at(18, 15))!.minutesAway).toBe(0)
  })

  it('stays quiet later the same evening, once every start time is behind', () => {
    expect(nextComponent(rows, at(23, 30))).toBeNull()
  })

  /**
   * The case the horizon actually exists for, and the one that shipped broken.
   *
   * Start times are clock times with no date. Past midnight, `17:55` is seventeen hours *ahead*, so
   * a plain `start > now` check reports the night as still to come and the cook view offers to
   * start the sauce in 1,039 minutes. Only a horizon catches this — checking 23:30 does not, because
   * both starts are already negative there.
   */
  it('stays quiet after midnight, when the clock has wrapped past every start time', () => {
    expect(nextComponent(rows, at(0, 36))).toBeNull()
  })
})

// ---- Plan queries ----

const day = (date: string, entries: MealPlanEntryDto[]): MealDayDto => ({ date, entries })
const week = (days: MealDayDto[]): MealWeekDto => ({ start: days[0].date, end: days[days.length - 1].date, days })

describe('entriesFor', () => {
  it('returns a slot’s dishes in cooking order, main first', () => {
    const d = day('2026-08-01', [
      entry({ id: 2, position: 1, role: 'Side', recipeTitle: 'Toast' }),
      entry({ id: 1, position: 0, role: 'Main', recipeTitle: 'Bolognese' }),
      entry({ id: 3, slot: 'Lunch', recipeTitle: 'Soup' }),
    ])
    expect(entriesFor(d, 'Dinner').map((e) => e.recipeTitle)).toEqual(['Bolognese', 'Toast'])
  })
})

describe('plannedCount', () => {
  /** Counts nights, not dishes — a main and two sides is one night planned, not three. */
  it('counts slots rather than entries', () => {
    const w = week([
      day('2026-08-01', [
        entry({ id: 1, position: 0 }),
        entry({ id: 2, position: 1, role: 'Side' }),
        entry({ id: 3, position: 2, role: 'Dessert' }),
      ]),
      day('2026-08-02', [entry({ id: 4, date: '2026-08-02' })]),
    ])
    expect(plannedCount(w, ['Lunch', 'Dinner'])).toBe(2)
  })

  it('ignores slots the household has hidden', () => {
    const w = week([day('2026-08-01', [entry({ id: 1, slot: 'Breakfast' }), entry({ id: 2 })])])
    expect(plannedCount(w, ['Dinner'])).toBe(1)
  })
})

describe('nextFreeSlot', () => {
  it('finds the first empty visible slot from the given day', () => {
    const w = week([
      day('2026-08-01', [entry({ id: 1, slot: 'Lunch' }), entry({ id: 2, slot: 'Dinner' })]),
      day('2026-08-02', [entry({ id: 3, date: '2026-08-02', slot: 'Dinner' })]),
    ])
    expect(nextFreeSlot(w, ['Lunch', 'Dinner'], '2026-08-01')).toEqual({ date: '2026-08-02', slot: 'Lunch' })
  })

  /** Nothing free is a real answer; the controls that name a night then say so instead. */
  it('returns null when the rest of the week is full', () => {
    const w = week([day('2026-08-01', [entry({ id: 1, slot: 'Dinner' })])])
    expect(nextFreeSlot(w, ['Dinner'], '2026-08-01')).toBeNull()
  })
})

describe('unconfirmedPastDinner', () => {
  /** One ask per night, about the main — nobody ate the bolognese but not the garlic bread. */
  it('asks about the main only, and only about past unanswered nights', () => {
    const w = week([
      day('2026-07-30', [
        entry({ id: 1, date: '2026-07-30', position: 0, recipeTitle: 'Bolognese', wasEaten: null }),
        entry({ id: 2, date: '2026-07-30', position: 1, role: 'Side', recipeTitle: 'Toast', wasEaten: null }),
      ]),
      day('2026-08-05', [entry({ id: 3, date: '2026-08-05', wasEaten: null })]),
    ])
    const asked = unconfirmedPastDinner(w, '2026-08-01')
    expect(asked?.recipeTitle).toBe('Bolognese')
  })

  it('says nothing about a night already answered', () => {
    const w = week([day('2026-07-30', [entry({ id: 1, date: '2026-07-30', wasEaten: true })])])
    expect(unconfirmedPastDinner(w, '2026-08-01')).toBeNull()
  })
})

// ---- Cooked history phrasing ----

describe('cookedAgoLabel', () => {
  const today = new Date(2026, 7, 1)

  it('says NEVER rather than inventing a date', () => {
    expect(cookedAgoLabel(null, today)).toBe('NEVER')
  })

  /** Weeks, not days: nobody holds "are we sick of this yet" to the day. */
  it('reports whole weeks, and says so in words under one', () => {
    expect(cookedAgoLabel('2026-07-28', today)).toBe('THIS WEEK')
    expect(cookedAgoLabel('2026-07-18', today)).toBe('2 WKS')
    expect(cookedAgoLabel('2026-04-01', today)).toBe('17 WKS')
  })
})

describe('daysSinceCooked', () => {
  /** Never-cooked sorts to the top of NOT LATELY, which Infinity expresses honestly. */
  it('is infinite for a recipe never cooked', () => {
    expect(daysSinceCooked({ lastCookedDate: null } as never, new Date(2026, 7, 1))).toBe(Infinity)
  })
})

describe('cookedCountLabel', () => {
  it('only counts when there is more than one', () => {
    expect(cookedCountLabel(1)).toBe('COOKED')
    expect(cookedCountLabel(4)).toBe('COOKED 4×')
  })
})

// ---- Words ----

describe('countWord', () => {
  it('spells small counts, so a rule line reads as a sentence', () => {
    expect(countWord(0)).toBe('NO')
    expect(countWord(6)).toBe('SIX')
    expect(countWord(20)).toBe('TWENTY')
  })

  it('falls back to a numeral past the point where words help', () => {
    expect(countWord(48)).toBe('48')
  })
})

describe('durationLabel', () => {
  it('uses the shortest honest form', () => {
    expect(durationLabel(35)).toBe('35 min')
    expect(durationLabel(60)).toBe('1 hr')
    expect(durationLabel(80)).toBe('1 hr 20 min')
    expect(durationLabel(180)).toBe('3 hr')
  })
})

// ---- Search ----

describe('matchesAtWordBoundary', () => {
  it('matches from any word boundary, not mid-word', () => {
    expect(matchesAtWordBoundary('Green Curry', 'cur')).toBe(true)
    expect(matchesAtWordBoundary('Green Curry', 'green')).toBe(true)
    expect(matchesAtWordBoundary('obscure', 'cur')).toBe(false)
  })

  it('ignores case and accents', () => {
    expect(matchesAtWordBoundary('Crème Brûlée', 'creme')).toBe(true)
    expect(matchesAtWordBoundary('Crème Brûlée', 'BRULEE')).toBe(true)
  })

  it('treats an empty query as matching everything', () => {
    expect(matchesAtWordBoundary('anything', '')).toBe(true)
  })
})

// ---- Weeks ----

describe('weekStart', () => {
  /** Monday-first, and Sunday belongs to the week that began six days earlier. */
  it('finds Monday, including from a Sunday', () => {
    expect(weekStart(new Date(2026, 7, 1)).getDay()).toBe(1)   // Sat 1 Aug -> Mon
    expect(weekStart(new Date(2026, 7, 2)).getDate()).toBe(27) // Sun 2 Aug -> Mon 27 Jul
  })
})

describe('weekLabel', () => {
  it('names one month once, and both when the week straddles them', () => {
    expect(weekLabel('2026-08-03')).toBe('3 — 9 AUGUST')
    expect(weekLabel('2026-07-27')).toBe('27 JULY — 2 AUGUST')
  })
})
