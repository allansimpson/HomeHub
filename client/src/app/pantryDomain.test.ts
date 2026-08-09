import { describe, expect, it } from 'vitest'
import {
  ageLabel,
  agoWords,
  amountLabel,
  onHand,
  emptyShelfLine,
  evidenceLine,
  groupByLocation,
  grocerySections,
  hedgeLine,
  isFlagged,
  mirrorLines,
  moveTarget,
  provenanceLine,
  relativeWords,
  rowState,
  shortfallTitle,
  tailLine,
  tallyLine,
  trimNumber,
} from './pantryDomain'
import type {
  GroceryLineDto, MealWeekDto, MirrorStatusDto, PantryItemDto, StockCheckLineDto,
} from '../api/types'

/**
 * The Pantry's wording and arithmetic.
 *
 * Almost every assertion here is really one rule: **never assert a quantity without a date**
 * (PANTRY_BEHAVIOURS §9). It is a copy rule, which means nothing enforces it at runtime and nothing
 * fails loudly when it breaks — a row that quietly drops its age just looks slightly cleaner. These
 * tests are the enforcement.
 */

const item = (over: Partial<PantryItemDto> = {}): PantryItemDto => ({
  id: 1,
  name: 'Chicken breasts',
  location: 'Fridge',
  tracking: 'Counted',
  quantity: 4,
  unit: 'ea',
  estimateState: null,
  // Loose by default, which is what most of a pantry is — the packaged cases say so explicitly.
  packSize: null,
  packUnit: null,
  lastSeenAtUtc: '2026-07-28T10:00:00Z',
  lastSeenByName: 'Astrid',
  catalogueRef: null,
  isArchived: false,
  version: 1,
  ...over,
})

describe('ageLabel', () => {
  const now = new Date(2026, 7, 1, 9, 0, 0) // 1 Aug 2026, local

  it('reads SEEN TODAY on the same calendar day', () => {
    expect(ageLabel(new Date(2026, 7, 1, 1, 0, 0).toISOString(), now)).toBe('SEEN TODAY')
  })

  it('counts calendar days, not 24-hour blocks', () => {
    // 11pm yesterday was seen *yesterday*, even though it is ten hours ago.
    expect(ageLabel(new Date(2026, 6, 31, 23, 0, 0).toISOString(), now)).toBe('SEEN 1 D')
  })

  it('switches from days to weeks at fourteen days (§3)', () => {
    expect(ageLabel(new Date(2026, 6, 19).toISOString(), now)).toBe('SEEN 13 D')
    expect(ageLabel(new Date(2026, 6, 18).toISOString(), now)).toBe('SEEN 2 WK')
  })

  it('says NEVER SEEN rather than nothing', () => {
    // An empty age cell beside a quantity is exactly the unhedged claim the section forbids.
    expect(ageLabel(null, now)).toBe('NEVER SEEN')
    expect(ageLabel(undefined, now)).toBe('NEVER SEEN')
    expect(ageLabel('not a date', now)).toBe('NEVER SEEN')
  })
})

describe('amountLabel and rowState', () => {
  it('gives the three tracking classes three different sentences', () => {
    // `none` and `not counted` must never be told apart by colour alone (DECISIONS PG2) — getting
    // them confused is what would put salt on the shortfall list.
    expect(amountLabel(item({ tracking: 'Counted', quantity: 0 }))).toBe('none')
    expect(amountLabel(item({ tracking: 'Estimated', estimateState: 'None' }))).toBe('none')
    expect(amountLabel(item({ tracking: 'NotCounted' }))).toBe('not counted')

    expect(rowState(item({ tracking: 'Counted', quantity: 0 }))).toBe('gone')
    expect(rowState(item({ tracking: 'Estimated', estimateState: 'None' }))).toBe('gone')
    expect(rowState(item({ tracking: 'NotCounted' }))).toBe('staple')
  })

  it('renders a counted amount with its unit', () => {
    expect(amountLabel(item({ quantity: 3, unit: 'tins' }))).toBe('3 tins')
    expect(amountLabel(item({ quantity: 1, unit: null }))).toBe('1')
  })

  it('marks two or fewer as low, matching the tally', () => {
    expect(rowState(item({ quantity: 3 }))).toBe('fine')
    expect(rowState(item({ quantity: 2 }))).toBe('low')
    expect(rowState(item({ quantity: 1 }))).toBe('low')
  })

  it('treats a low estimate as estimated, not as low-counted', () => {
    // The two look similar and mean different things: one is a number near zero, the other is a
    // container nobody can measure.
    expect(rowState(item({ tracking: 'Estimated', estimateState: 'Low', quantity: null }))).toBe('estimated')
    expect(amountLabel(item({ tracking: 'Estimated', estimateState: 'Low', quantity: null }))).toBe('low')
  })

  /**
   * A packaged row reads size-then-count and never the multiplied total. "15 oz" of yogurt is a
   * number nobody can check by opening the fridge; "3 oz ×5" is five pots, which is a thing you can
   * see — and the whole reason the two facts stopped sharing one field.
   */
  it('reads a packaged row as size then count', () => {
    expect(amountLabel(item({ quantity: 5, unit: null, packSize: 3, packUnit: 'oz' })))
      .toBe('3 oz ×5')
  })

  it('keeps the container name out of the way when there is a size', () => {
    // The size already says what the thing is, so `containers` would make it read `3 oz ×5` twice.
    expect(amountLabel(item({ quantity: 2, unit: 'containers', packSize: 500, packUnit: 'g' })))
      .toBe('500 g ×2')
  })

  it('rounds the count for the eye without pretending it is whole', () => {
    // Cooking four ounces out of 3 oz pots genuinely leaves 3.667 of them. The stored number keeps
    // every digit; a shelf list read from across a room gets one decimal.
    expect(amountLabel(item({ quantity: 3.667, unit: null, packSize: 3, packUnit: 'oz' })))
      .toBe('3 oz ×3.7')
  })

  it('is still `none` at zero packages', () => {
    expect(amountLabel(item({ quantity: 0, packSize: 3, packUnit: 'oz' }))).toBe('none')
  })

  it('ignores a pack size of zero rather than dividing by it', () => {
    expect(amountLabel(item({ quantity: 4, unit: 'ea', packSize: 0, packUnit: null }))).toBe('4 ea')
  })
})

describe('onHand', () => {
  it('multiplies a packaged row out, because that is what the stock check compares', () => {
    expect(onHand(item({ quantity: 5, packSize: 3, packUnit: 'oz' }))).toBe(15)
  })

  it('leaves a loose row alone', () => {
    expect(onHand(item({ quantity: 500, unit: 'g' }))).toBe(500)
  })

  it('reads nothing as nothing rather than as one', () => {
    expect(onHand(item({ quantity: null }))).toBe(0)
  })
})

describe('tallyLine', () => {
  it('omits a clause at zero rather than showing 0', () => {
    // "0 PROBABLY OUT" reads as a claim about completeness, and §7 forbids the tally scoring itself.
    expect(tallyLine(36, 4, 2)).toBe('36 THINGS · 4 PROBABLY LOW · 2 PROBABLY OUT')
    expect(tallyLine(36, 0, 2)).toBe('36 THINGS · 2 PROBABLY OUT')
    expect(tallyLine(36, 0, 0)).toBe('36 THINGS')
    expect(tallyLine(1, 0, 0)).toBe('1 THING')
  })

  it('always hedges', () => {
    expect(tallyLine(9, 3, 1)).toContain('PROBABLY LOW')
    expect(tallyLine(9, 3, 1)).not.toMatch(/\bLOW\b(?! )/)
  })
})

describe('hedgeLine', () => {
  const now = new Date(2026, 7, 1, 9, 0, 0)

  it('names who and when, and says the panel only knows what it was told', () => {
    const line = hedgeLine('Eleanor', new Date(2026, 6, 28).toISOString(), now)
    expect(line).toContain('Eleanor')
    expect(line).toContain('only knows what it was told')
  })

  it('is null on an untouched pantry, where the empty state does the talking', () => {
    expect(hedgeLine('Eleanor', null, now)).toBeNull()
  })
})

describe('groupByLocation', () => {
  it('sorts counted, then estimated, then staples, alphabetically inside each', () => {
    // Staples last is not cosmetic: floating "Olive oil — not counted" alphabetically into the
    // middle would put a row that means nothing between two that do.
    const items = [
      item({ id: 1, name: 'Olive oil', tracking: 'NotCounted', location: 'Cupboard' }),
      item({ id: 2, name: 'Spaghetti', tracking: 'Counted', location: 'Cupboard' }),
      item({ id: 3, name: 'Capers', tracking: 'Estimated', location: 'Cupboard' }),
      item({ id: 4, name: 'Anchovies', tracking: 'Counted', location: 'Cupboard' }),
    ]
    const cupboard = groupByLocation(items).find((g) => g.location === 'Cupboard')!
    expect(cupboard.items.map((i) => i.name)).toEqual(['Anchovies', 'Spaghetti', 'Capers', 'Olive oil'])
  })

  it('returns every location, including the empty ones', () => {
    // An absent shelf reads as a bug (behaviours §6), so the section is never dropped.
    const groups = groupByLocation([item({ location: 'Fridge' })])
    expect(groups.map((g) => g.location)).toEqual(['Cupboard', 'Fridge', 'Freezer'])
    expect(emptyShelfLine('Freezer')).toBe('Nothing in the freezer yet')
  })
})

describe('the stock check wording', () => {
  const line = (over: Partial<StockCheckLineDto> = {}): StockCheckLineDto => ({
    ingredientId: 1,
    name: 'Chicken breasts',
    needed: '6',
    status: 'Short',
    pantryItemId: 12,
    lastSeenQuantity: 2,
    lastSeenUnit: null,
    lastSeenState: null,
    lastSeenAtUtc: new Date(2026, 6, 26).toISOString(),
    ...over,
  })
  const now = new Date(2026, 7, 1, 9, 0, 0)

  it('flags Short, Gone, Unknown and NoMatch — never Fine or NotCounted', () => {
    expect(isFlagged('Short')).toBe(true)
    expect(isFlagged('Gone')).toBe(true)
    expect(isFlagged('Unknown')).toBe(true)
    // NoMatch is listed too. Silence about a line you cannot resolve is how the check starts lying.
    expect(isFlagged('NoMatch')).toBe(true)
    expect(isFlagged('Fine')).toBe(false)
    expect(isFlagged('NotCounted')).toBe(false)
  })

  it('titles the shortfall in words, hedged', () => {
    expect(shortfallTitle(3)).toBe("You'll probably need three things")
    expect(shortfallTitle(1)).toBe("You'll probably need one thing")
    // Numerals past ten, per the copy rule.
    expect(shortfallTitle(12)).toBe("You'll probably need 12 things")
  })

  it('never says "short", "missing" or "out of stock"', () => {
    const banned = /\b(short|missing|out of stock)\b/i
    expect(shortfallTitle(3)).not.toMatch(banned)
    expect(evidenceLine(line({ status: 'Short' }), now)).not.toMatch(banned)
    expect(evidenceLine(line({ status: 'Gone' }), now)).not.toMatch(banned)
  })

  it('dates every evidence sentence', () => {
    // The rule with teeth: any string asserting a quantity without a date is a bug.
    expect(evidenceLine(line({ status: 'Short' }), now)).toBe('The pantry last saw 2, six days ago.')
    expect(evidenceLine(line({ status: 'Gone', lastSeenAtUtc: new Date(2026, 6, 11).toISOString() }), now))
      .toBe('Marked gone three weeks ago and never replaced.')
    expect(evidenceLine(line({ status: 'Unknown', lastSeenState: 'Low' }), now))
      .toContain('marked low six days ago')
  })

  it('says so plainly when there is no date to give', () => {
    expect(relativeWords(null, now)).toBe('at some point')
    expect(evidenceLine(line({ status: 'Short', lastSeenAtUtc: null }), now)).toContain('at some point')
  })

  it('words a NoMatch as a fact about the pantry, not about the shopping', () => {
    expect(evidenceLine(line({ status: 'NoMatch' }), now)).toBe('Not something the pantry tracks.')
  })

  it('names staples only in the tail line, and never as a problem', () => {
    expect(tailLine(9, 3, ['Olive oil', 'Salt']))
      .toBe("The other six lines look fine, and two of them — olive oil, salt — aren't counted at all.")
    expect(tailLine(9, 3, [])).toBe('The other six lines look fine.')
    // Nothing reassuring to say — no sentence at all rather than an empty one.
    expect(tailLine(3, 3, [])).toBeNull()
  })
})

describe('moveTarget', () => {
  const week = (planned: string[]): MealWeekDto => ({
    start: '2026-08-03',
    end: '2026-08-09',
    days: ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09']
      .map((date) => ({
        date,
        entries: planned.includes(date)
          ? [{
              id: 1, date, slot: 'Dinner' as const, position: 0, role: 'Main' as const,
              recipeId: 1, recipeTitle: 'Something', recipeHasImage: false, freeText: null,
              servingsOverride: null, wasEaten: null, totalMinutes: null, version: 1,
            }]
          : [],
      })),
  })

  it('lands on the first free night from the delivery weekday onward', () => {
    // Wednesday 5 Aug, delivery lands **Saturday** → Saturday 8 Aug.
    //
    // Saturday rather than Thursday on purpose: Thursday is simply the day after Wednesday, so a
    // build that ignored the delivery weekday entirely and just moved the night to tomorrow would
    // give the same answer and the test would prove nothing. (It did — found by mutation.)
    expect(moveTarget('2026-08-05', 'Saturday', week([]), ['Dinner'])).toBe('2026-08-08')
  })

  it('skips a night that is already planned', () => {
    expect(moveTarget('2026-08-05', 'Saturday', week(['2026-08-08']), ['Dinner'])).toBe('2026-08-09')
  })

  it('falls back to the first free night when no delivery weekday is known', () => {
    // Below three recorded deliveries the clause is omitted entirely (§3), and so is the target.
    expect(moveTarget('2026-08-05', null, week([]), ['Dinner'])).toBe('2026-08-06')
  })

  it('still moves the night somewhere when the week is full', () => {
    const full = week(['2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09'])
    expect(moveTarget('2026-08-05', 'Saturday', full, ['Dinner'])).toBe('2026-08-06')
  })
})

describe('the grocery list', () => {
  const line = (over: Partial<GroceryLineDto> = {}): GroceryLineDto => ({
    id: 1,
    text: 'Lemons',
    quantity: 3,
    unit: null,
    pantryItemId: 7,
    sourceKind: 'Meal',
    provenance: [],
    checkedAtUtc: null,
    returnTrip: null,
    version: 1,
    ...over,
  })

  it('puts meal and low-stock lines together, hand-added apart, and done last', () => {
    const sections = grocerySections([
      line({ id: 1, sourceKind: 'Meal' }),
      line({ id: 2, sourceKind: 'LowStock' }),
      line({ id: 3, sourceKind: 'Hand' }),
      line({ id: 4, sourceKind: 'Meal', checkedAtUtc: '2026-08-01T09:00:00Z' }),
    ])
    expect(sections.map((s) => s.lines.length)).toEqual([2, 1, 1])
    expect(sections[2].key).toBe('done')
  })

  it('renders merged provenance date-ascending', () => {
    const merged = line({
      provenance: [
        { label: 'Chicken Piccata', forDate: '2026-08-05' },
        { label: 'Sheet-pan salmon', forDate: '2026-08-07' },
      ],
    })
    expect(provenanceLine(merged)).toBe('Chicken Piccata · Wed  ·  Sheet-pan salmon · Fri')
  })

  it('renders a hand-added line with no date as just the name', () => {
    expect(provenanceLine(line({ provenance: [{ label: 'Eleanor', forDate: null }] }))).toBe('Eleanor')
  })
})

describe('the mirror strip', () => {
  const mirror = (over: Partial<MirrorStatusDto> = {}): MirrorStatusDto => ({
    state: 'Healthy',
    listName: 'Grocery',
    ownerName: 'Astrid',
    lastSyncedUtc: '2026-08-01T08:58:00Z',
    lastAttemptUtc: '2026-08-01T08:58:00Z',
    queuedCount: 0,
    message: null,
    ...over,
  })
  const now = new Date('2026-08-01T09:00:00Z')

  it('states direction and age when healthy', () => {
    const strip = mirrorLines(mirror(), now)
    expect(strip.label).toBe('MIRRORED TO MICROSOFT TO DO')
    expect(strip.detail).toBe('List “Grocery” · both ways · 2 minutes ago')
    expect(strip.tone).toBe('ok')
  })

  it('says nothing was lost and what happens next when failing', () => {
    // Never a toast, never silent, and never implying a line was dropped (behaviours §8).
    const strip = mirrorLines(mirror({ state: 'Failing', queuedCount: 3 }), now)
    expect(strip.detail).toContain('Nothing lost')
    expect(strip.detail).toContain('3 changes will go up')
    expect(strip.tone).toBe('warn')
  })

  it('treats mirroring off as a normal state, not a failure', () => {
    const strip = mirrorLines(mirror({ state: 'Off' }), now)
    expect(strip.label).toBe('NOT MIRRORED · LOCAL LIST ONLY')
    expect(strip.tone).toBe('off')
  })

  it('asks for a sign-in when the token expired', () => {
    const strip = mirrorLines(mirror({ state: 'SignInExpired' }), now)
    expect(strip.label).toBe('MICROSOFT SIGN-IN EXPIRED')
    expect(strip.tone).toBe('warn')
  })
})

describe('agoWords', () => {
  const now = new Date('2026-08-01T09:00:00Z')

  it('reads in the units a human would use', () => {
    expect(agoWords('2026-08-01T08:59:40Z', now)).toBe('just now')
    expect(agoWords('2026-08-01T08:58:00Z', now)).toBe('2 minutes ago')
    expect(agoWords('2026-08-01T08:00:00Z', now)).toBe('an hour ago')
    expect(agoWords('2026-08-01T04:00:00Z', now)).toBe('5 hours ago')
    expect(agoWords('2026-07-31T09:00:00Z', now)).toBe('yesterday')
  })

  it('says never rather than guessing', () => {
    expect(agoWords(null, now)).toBe('never')
  })
})

describe('trimNumber', () => {
  it('drops trailing zeros without dressing a count up as a fraction', () => {
    // Deliberately not the recipe screens' fraction formatting: a pantry count is a number of packs
    // read off a shelf, and rendering 2.5 as "2 1/2" would make it look like a recipe amount.
    expect(trimNumber(3)).toBe('3')
    expect(trimNumber(2.5)).toBe('2.5')
    expect(trimNumber(0.25)).toBe('0.25')
    expect(trimNumber(3.0001)).toBe('3')
  })
})
