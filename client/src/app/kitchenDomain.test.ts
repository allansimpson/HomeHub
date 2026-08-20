import { describe, expect, it } from 'vitest'
import type {
  DueRecipeDto, GroceryLineDto, MealPlanEntryDto, MealWeekDto, OrderImportLineDto, PantryItemDto,
  ShelfLifeDto, StockCheckDto, StockCheckLineDto, StockStatusName,
} from '../api/types'
import {
  calendarDaysUntil, countdown, inHandLabel, ingredientsForStep, isBefore, isBuyable, neededSoon,
  needsAPerson, nextNights, nightLine, nightsNeedingSomething, openItems, openLabel, planPutAway, servingsPlanned,
  missingTonight, sortImportLines, staleCount, stepTimerMinutes, stockNeedsAttention, stockVerdict, stockWord,
  collateWants, turningBand, usesSentence, wantedNames, weekBearing, weekShortfalls,
} from './kitchenDomain'

/**
 * The Kitchen's own wording rules.
 *
 * Each of these is a sentence from a spec rather than a preference, so the test names quote the
 * rule. When one changes, the failure should say which promise was broken.
 */

const entry = (over: Partial<MealPlanEntryDto> = {}): MealPlanEntryDto => ({
  id: 1, date: '2026-08-17', slot: 'Dinner', recipeId: 1, recipeTitle: 'Ragu',
  recipeHasImage: false, freeText: null, servingsOverride: null, wasEaten: null,
  position: 0, role: 'Main', totalMinutes: null, version: 1, stockSummary: 'Covered', ...over,
})

const item = (over: Partial<PantryItemDto> = {}): PantryItemDto => ({
  id: 1, name: 'Double cream', location: 'Fridge', tracking: 'Counted', quantity: 1,
  unit: 'ea', estimateState: null, packSize: null, packUnit: null, lastSeenAtUtc: null,
  lastSeenByName: null, catalogueRef: null, isArchived: false, version: 1, openedAtUtc: null,
  goodUntil: null, ...over,
})

describe('the one word a night carries', () => {
  it('says ALL IN when everything is on a shelf', () => {
    expect(stockWord(entry({ stockSummary: 'Covered' }))).toBe('ALL IN')
  })

  it('says SHORT when something is missing', () => {
    expect(stockWord(entry({ stockSummary: 'Short' }))).toBe('SHORT')
  })

  /** DECISIONS PG6: an unresolvable line is a question, never a warning. */
  it("says CAN'T SAY rather than pretending to know", () => {
    expect(stockWord(entry({ stockSummary: 'Unknown' }))).toBe("CAN'T SAY")
  })

  /** PLAN_WEEK §1: "Out — Rosa's is a plan, not a gap." */
  it('gives a night out its own word rather than leaving it blank', () => {
    const out = entry({ recipeId: null, freeText: "Out — Rosa's", stockSummary: 'NoClaim' })
    expect(stockWord(out)).toBe('NO COOKING')
  })

  it('says nothing at all for an empty night', () => {
    expect(stockWord(entry({ recipeId: null, freeText: null, stockSummary: null }))).toBeNull()
  })

  /**
   * A verdict still in flight is not a verdict. Inventing a word while the settle is running would
   * be a claim the panel cannot stand behind.
   */
  it('says nothing while the verdict is unsettled', () => {
    expect(stockWord(entry({ stockSummary: null }))).toBeNull()
  })

  it('reserves the amber for short, not for unknown', () => {
    expect(stockNeedsAttention('Short')).toBe(true)
    expect(stockNeedsAttention('Unknown')).toBe(false)
    expect(stockNeedsAttention('Covered')).toBe(false)
    expect(stockNeedsAttention(null)).toBe(false)
  })
})

describe('how long something has been open', () => {
  const now = new Date('2026-08-17T12:00:00Z')

  it('counts in days under a fortnight', () => {
    expect(openLabel('2026-08-12T09:00:00Z', now)).toBe('OPEN 5 D')
  })

  it('counts in weeks beyond one', () => {
    expect(openLabel('2026-07-20T09:00:00Z', now)).toBe('OPEN 4 W')
  })

  it('says today rather than "0 D"', () => {
    expect(openLabel('2026-08-17T08:00:00Z', now)).toBe('OPEN TODAY')
  })

  /** Not opened is not the same as unknown, and neither deserves a label. */
  it('says nothing for something that was never opened', () => {
    expect(openLabel(null, now)).toBeNull()
  })

  /** A clock skewed forward is not evidence a jar was opened. Say nothing rather than "today". */
  it('says nothing for a date in the future', () => {
    expect(openLabel('2026-08-20T09:00:00Z', now)).toBeNull()
  })
})

describe('the cook-mode countdown', () => {
  /**
   * The timer used to render through `formatClock`, which reads minutes since midnight. Twenty
   * minutes on the clock is twenty past twelve, so a timer started at `20:00` flipped instantly to
   * `00:20` and then counted down through times of day.
   */
  it('reads as time remaining, not as a time of day', () => {
    expect(countdown(20 * 60)).toBe('20:00')
    expect(countdown(20 * 60 - 1)).toBe('19:59')
  })

  it('pads the seconds and never goes below zero', () => {
    expect(countdown(65)).toBe('1:05')
    expect(countdown(9)).toBe('0:09')
    expect(countdown(-30)).toBe('0:00')
  })

  /** An hour-long step counts in minutes rather than growing an hours column nobody asked for. */
  it('keeps counting in minutes past an hour', () => {
    expect(countdown(90 * 60)).toBe('90:00')
  })
})

describe('the use-it-or-lose-it band', () => {
  const due = (over: Partial<DueRecipeDto> = {}): DueRecipeDto => ({
    recipeId: 1, title: 'Dal', score: 5, uses: ['spinach'], ...over,
  })

  /**
   * The panel spec: the band "disappears entirely when nothing is turning — never an empty
   * heading". A household that has just shopped should see one row fewer, not a reassurance.
   */
  it('disappears entirely when nothing is turning', () => {
    expect(turningBand([])).toBeNull()
    expect(turningBand([due({ score: 0 })])).toBeNull()
  })

  it('leads with the most due and counts the rest', () => {
    const band = turningBand([due({ title: 'Dal', score: 9 }), due({ title: 'Soup', score: 2 })])
    expect(band?.lead.title).toBe('Dal')
    expect(band?.count).toBe(2)
  })

  it('names what it would use rather than counting it', () => {
    expect(usesSentence(['spinach'])).toBe('spinach')
    expect(usesSentence(['spinach', 'cream'])).toBe('spinach and cream')
    expect(usesSentence(['spinach', 'cream', 'tomatoes'])).toBe('spinach, cream and tomatoes')
  })

  /** Past three the sentence stops being readable across a kitchen. */
  it('stops at three names', () => {
    expect(usesSentence(['a', 'b', 'c', 'd'])).toBe('a, b and c')
  })
})

describe('the next few nights', () => {
  const week: MealWeekDto = {
    start: '2026-08-17',
    end: '2026-08-23',
    days: ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21'].map((date) => ({
      date,
      entries: [entry({ date })],
    })),
  }

  /** The full week is behind PLAN; repeating it here would make the two screens compete. */
  it('lists three nights, not seven', () => {
    expect(nextNights(week, '2026-08-17')).toHaveLength(3)
  })

  it('starts after today rather than including it', () => {
    expect(nextNights(week, '2026-08-17')[0].date).toBe('2026-08-18')
  })

  it('copes with no week loaded yet', () => {
    expect(nextNights(null, '2026-08-17')).toEqual([])
  })
})

describe('what the week needs', () => {
  it('collects the nights that are short and no others', () => {
    const week: MealWeekDto = {
      start: '2026-08-17',
      end: '2026-08-23',
      days: [
        { date: '2026-08-17', entries: [entry({ stockSummary: 'Covered' })] },
        { date: '2026-08-18', entries: [entry({ stockSummary: 'Short' })] },
        { date: '2026-08-19', entries: [entry({ stockSummary: 'Unknown' })] },
        { date: '2026-08-20', entries: [entry({ stockSummary: 'Short' })] },
      ],
    }

    // Unknown is not short. Adding it to the shopping list would buy things on a guess.
    expect(nightsNeedingSomething(week)).toHaveLength(2)
  })
})

describe('what is open', () => {
  const now = new Date('2026-08-17T12:00:00Z')

  it('puts the longest-open first', () => {
    const sorted = openItems([
      item({ id: 1, name: 'Cream', openedAtUtc: '2026-08-15T09:00:00Z' }),
      item({ id: 2, name: 'Tomatoes', openedAtUtc: '2026-08-01T09:00:00Z' }),
    ], now)

    expect(sorted.map((i) => i.name)).toEqual(['Tomatoes', 'Cream'])
  })

  /** An unopened thing is not evidence about freshness, so it is left out rather than ranked last. */
  it('leaves out anything that was never opened', () => {
    const sorted = openItems([item({ openedAtUtc: null })], now)
    expect(sorted).toEqual([])
  })

  it('leaves out archived rows', () => {
    const sorted = openItems([
      item({ openedAtUtc: '2026-08-15T09:00:00Z', isArchived: true }),
    ], now)
    expect(sorted).toEqual([])
  })
})

describe('comparing nights', () => {
  /** Calendar dates, never instants — a night is a night whatever zone the panel thinks it is in. */
  it('compares as dates', () => {
    expect(isBefore('2026-08-17', '2026-08-18')).toBe(true)
    expect(isBefore('2026-08-18', '2026-08-17')).toBe(false)
    expect(isBefore('2026-08-17', '2026-08-17')).toBe(false)
  })
})

describe('counting calendar days toward something', () => {
  /**
   * The distinction the whole `neededSoon` bug turned on: `calendarDaysBetween` clamps, because an
   * age can never be negative, and a horizon very much can.
   */
  it('goes negative for a date already past', () => {
    expect(calendarDaysUntil(new Date(2026, 7, 17), new Date(2026, 7, 14))).toBe(-3)
  })

  it('counts calendar days rather than 24-hour blocks', () => {
    // 11pm to 1am the next morning is one day, not zero.
    expect(calendarDaysUntil(new Date(2026, 7, 17, 23), new Date(2026, 7, 18, 1))).toBe(1)
  })
})

describe('what the shop marks as needed soon', () => {
  const now = new Date('2026-08-17T12:00:00Z')

  const line = (forDate: string | null): GroceryLineDto => ({
    id: 1, text: 'Beef mince', quantity: null, unit: null, pantryItemId: null,
    sourceKind: 'Meal', provenance: [{ label: 'Ragu', forDate }], checkedAtUtc: null,
    returnTrip: null, version: 1, aisle: null, store: null,
  })

  it('marks a night inside the horizon', () => {
    expect(neededSoon(line('2026-08-19'), now)).toBe(true)
  })

  it('leaves a night beyond it alone', () => {
    expect(neededSoon(line('2026-08-30'), now)).toBe(false)
  })

  it('counts today', () => {
    expect(neededSoon(line('2026-08-17'), now)).toBe(true)
  })

  /**
   * A night that has already gone is not urgent — it is over.
   *
   * The horizon was measured with the clamping day count, which reads every past date as nought
   * days away. Every night that passed stayed marked for good, so a list left alone for a fortnight
   * ended up entirely brass-barred and the mark stopped distinguishing anything.
   */
  it('leaves a night that has already passed alone', () => {
    expect(neededSoon(line('2026-08-16'), now)).toBe(false)
    expect(neededSoon(line('2026-07-01'), now)).toBe(false)
  })

  /**
   * A line with no night behind it is never urgent, however long it has sat on the list. Wanting
   * something for a while is not the same as needing it on Thursday.
   */
  it('never marks a line with no night behind it', () => {
    expect(neededSoon(line(null), now)).toBe(false)
  })

  /**
   * Guards the bug this function was extracted over: called as `list.filter(neededSoon)`, `filter`
   * supplies the array index as the second argument, so every date gets compared against 1970 and
   * nothing is ever urgent. Passing a number here must not silently pass.
   */
  it('is not usable as a bare filter callback', () => {
    const rows = [line('2026-08-19')]
    // @ts-expect-error — filter would hand (item, index, array) in, and `index` is not a Date.
    expect(() => rows.filter(neededSoon)).toBeDefined()
  })
})

describe('isBuyable / needsAPerson', () => {
  it('splits shortfalls from questions', () => {
    expect(isBuyable('Short')).toBe(true)
    expect(isBuyable('Gone')).toBe(true)
    // Spoken for by an earlier night is a real shortfall: the tin is here, and it is not yours.
    expect(isBuyable('ClaimedAway')).toBe(true)
    expect(isBuyable('Fine')).toBe(false)
  })

  it('never treats an unmatched or unknown line as something to buy', () => {
    // The whole point: "I don't know what this is" and "I don't know how much is left" are not
    // evidence that anything is missing.
    expect(isBuyable('NoMatch')).toBe(false)
    expect(isBuyable('Unknown')).toBe(false)
    expect(needsAPerson('NoMatch')).toBe(true)
    expect(needsAPerson('Unknown')).toBe(true)
  })

  it('puts every status in exactly one of the two, or neither', () => {
    const statuses: StockStatusName[] = [
      'Fine', 'Short', 'Gone', 'Unknown', 'NoMatch', 'NotCounted', 'ClaimedAway',
    ]
    for (const s of statuses) expect(isBuyable(s) && needsAPerson(s)).toBe(false)
  })
})

describe('stockVerdict', () => {
  it('says the one word the week says', () => {
    expect(stockVerdict(0, 0)).toBe('ALL IN')
    expect(stockVerdict(3, 0)).toBe('3 SHORT')
    expect(stockVerdict(0, 4)).toBe("CAN'T SAY")
  })

  it('lets short outrank can’t-say, because only one of them is actionable', () => {
    expect(stockVerdict(2, 4)).toBe('2 SHORT')
  })
})

describe('stepTimerMinutes', () => {
  it('reads a duration out of a step', () => {
    expect(stepTimerMinutes('Simmer for 20 minutes.')).toBe(20)
    expect(stepTimerMinutes('Rest 5 min')).toBe(5)
  })

  it('converts hours, so the offered timer is never sixty times too short', () => {
    expect(stepTimerMinutes('Braise for 2 hours')).toBe(120)
    expect(stepTimerMinutes('Chill 1 hr')).toBe(60)
  })

  it('offers nothing when the step names no duration', () => {
    expect(stepTimerMinutes('Brown the mince.')).toBeNull()
    // A quantity is not a duration. "3 tbsp" must not become a three-minute timer.
    expect(stepTimerMinutes('Add 3 tbsp of oil.')).toBeNull()
    expect(stepTimerMinutes('Cook for 0 minutes')).toBeNull()
  })
})

describe('ingredientsForStep', () => {
  const ingredients = [
    { rawText: '500 g beef mince', name: 'beef mince' },
    { rawText: '2 tbsp olive oil', name: 'oil' },
    { rawText: '1 onion', name: 'onion' },
  ]

  it('brings only the ingredients the step names', () => {
    expect(ingredientsForStep(ingredients, 'Brown the beef mince with the onion.'))
      .toEqual(['500 g beef mince', '1 onion'])
  })

  it('does not attach a short name found inside another word', () => {
    // "oil" inside "boil" — and it is three letters, which is under the floor anyway.
    expect(ingredientsForStep(ingredients, 'Bring to the boil.')).toEqual([])
  })

  it('matches on a word boundary rather than a bare substring', () => {
    const spiced = [{ rawText: '1 tsp cumin', name: 'cumin' }]
    expect(ingredientsForStep(spiced, 'Toast the cumin.')).toEqual(['1 tsp cumin'])
    expect(ingredientsForStep(spiced, 'Add the cumins.')).toEqual([])
  })
})

describe('putting a shop away', () => {
  const now = new Date(2026, 7, 17)

  const line = (over: Partial<GroceryLineDto> = {}): GroceryLineDto => ({
    id: 1, text: 'Chopped tomatoes', quantity: 1, unit: 'tins', pantryItemId: null,
    sourceKind: 'Meal', provenance: [], checkedAtUtc: '2026-08-17T09:00:00Z',
    returnTrip: null, version: 1, aisle: null, store: null, ...over,
  })

  const shelf = (over: Partial<PantryItemDto> = {}): PantryItemDto =>
    item({ id: 7, name: 'Chopped tomatoes', location: 'Cupboard', ...over })

  const fresh: ShelfLifeDto = {
    id: 1, foodKind: 'Chopped tomatoes', state: 'Fresh', days: 5, isSeeded: true,
  }

  /**
   * The double-count. Ticking a line off has **already** put its stock back through the ledger, so
   * a line that knows its shelf must amend that row rather than create a second one. Creating meant
   * one tin bought became two tins on the shelf, and no later screen could tell which was real.
   */
  it('amends the row a ticked line already went back to', () => {
    const { landings } = planPutAway([line({ pantryItemId: 7 })], [shelf()], [], now)

    expect(landings).toHaveLength(1)
    expect(landings[0].existing?.id).toBe(7)
  })

  /** A hand-typed line never returned any stock, so this is the one case that creates a row. */
  it('creates a row for a line that never knew its shelf', () => {
    const { landings } = planPutAway([line({ text: 'Kitchen roll' })], [shelf()], [], now)

    expect(landings[0].existing).toBeNull()
  })

  /**
   * A shelf the household already filed beats the shelf-life table's guess. The row is on screen,
   * so the location shown has to be the one that would actually be written.
   */
  it('keeps a thing where it already lives rather than guessing', () => {
    const { landings } = planPutAway(
      [line({ pantryItemId: 7 })], [shelf({ location: 'Freezer' })], [fresh], now)

    expect(landings[0].location).toBe('Freezer')
  })

  it('offers a date from the shelf life for something fresh it has never seen', () => {
    const { landings } = planPutAway([line()], [], [fresh], now)

    expect(landings[0].fresh).toBe(true)
    expect(landings[0].goodUntil).toBe('2026-08-22')
  })

  /** A substitution is a question, not a silent rename: saying yes teaches an alias. */
  it('asks about a line that came home under another name', () => {
    const { landings, questions } = planPutAway(
      [line({ provenance: [{ label: 'Passata', forDate: null }] })], [], [], now)

    expect(landings).toHaveLength(0)
    expect(questions[0].kind).toBe('substitution')
    expect(questions[0].onTheList).toBe('Passata')
  })

  it('asks about a pack big enough to really be several', () => {
    const { questions } = planPutAway(
      [line({ text: 'Beef mince', quantity: 2.4, unit: 'kg', pantryItemId: 7 })], [shelf()], [], now)

    expect(questions[0].kind).toBe('split')
    expect(questions[0].cameHome).toBe('2.4 kg')
  })

  /**
   * A split carries its shelf for the same reason a landing does. Splitting a line whose stock has
   * already come back has to divide that amount between the bags, not add the whole 2.4 kg again on
   * top of it.
   */
  it('tells a split which row its stock already went back to', () => {
    const { questions } = planPutAway(
      [line({ text: 'Beef mince', quantity: 2.4, unit: 'kg', pantryItemId: 7 })], [shelf()], [], now)

    expect(questions[0].existing?.id).toBe(7)
  })

  /** A substitution never has one — having no pantry item is what makes it a substitution. */
  it('never gives a substitution a shelf', () => {
    const { questions } = planPutAway(
      [line({ provenance: [{ label: 'Passata', forDate: null }] })], [shelf()], [], now)

    expect(questions[0].existing).toBeNull()
  })
})

describe('reading a delivery in', () => {
  const imported = (over: Partial<OrderImportLineDto> = {}): OrderImportLineDto => ({
    id: 1, rawText: 'CHOPPED TOMATOES 400G', proposedName: 'Chopped tomatoes',
    proposedQuantity: 1, proposedUnit: 'tins', proposedLocation: 'Cupboard',
    proposedTracking: 'Counted', matchedPantryItemId: 7, confidence: 'Matched',
    guessFromPounds: null, position: 0, ...over,
  })

  /**
   * The footer counted answered `SKIP THEM` presses, but apply leaves *every* unreadable line
   * behind whether or not anybody pressed it. So the button promised to put away lines the server
   * was always going to refuse.
   */
  it('counts what apply will really shelve, not what was answered', () => {
    const { going } = sortImportLines([
      imported({ id: 1 }),
      imported({ id: 2, confidence: 'Unreadable', rawText: '1L 0AT DR1NK BAR1STA' }),
    ])

    expect(going).toBe(1)
  })

  it('asks about a garbled line and about a substitution, and nothing else', () => {
    const { matched, questions, unasked } = sortImportLines([
      imported({ id: 1 }),
      imported({ id: 2, confidence: 'Unreadable' }),
      imported({
        id: 3, matchedPantryItemId: null, confidence: 'New',
        proposedName: 'Passata', rawText: 'PASSATA RUSTICA',
      }),
      imported({ id: 4, matchedPantryItemId: null, confidence: 'New', proposedName: null }),
    ])

    expect(matched.map((l) => l.id)).toEqual([1])
    expect(questions.map((l) => l.id)).toEqual([2, 3])
    // Nobody asked for it and nothing is wrong with it — added without a word.
    expect(unasked.map((l) => l.id)).toEqual([4])
  })
})

describe('how many a night was cooked for', () => {
  const cooked = (servings: number | null = 4) => [{ id: 1, servings }]

  /**
   * The gate on `OR SOME OF IT`. Reading only the override meant the partial answer never appeared
   * on an ordinary night, which took the leftovers card with it — and §5 with that.
   */
  it('falls back to the recipe when nobody overrode the servings', () => {
    expect(servingsPlanned(entry({ recipeId: 1 }), cooked())).toBe(4)
  })

  it('prefers an override, which is what one is for', () => {
    expect(servingsPlanned(entry({ recipeId: 1, servingsOverride: 8 }), cooked())).toBe(8)
  })

  /** A takeaway has no servings and should not be asked how many portions are spare. */
  it('says nothing for a night with no recipe behind it', () => {
    expect(servingsPlanned(entry({ recipeId: null, freeText: "Out — Rosa's" }), cooked()))
      .toBeNull()
    expect(servingsPlanned(undefined, cooked())).toBeNull()
  })
})

describe('collateWants — one line per thing, not per night-and-thing', () => {
  const want = (name: string, pantryItemId: number | null, entryId: number) =>
    ({ line: { name, pantryItemId }, entryId })

  /**
   * This replaces a per-night key that existed to stop one answer settling several cards and
   * adding the line twice. Collating is the stronger fix: there is one card and one line, so
   * neither can happen — and the household is not asked the same question three times over.
   */
  it('folds the same pantry row wanted on several nights into one entry', () => {
    const collated = collateWants([
      want('chopped tomatoes', 1, 11),
      want('lemon', 4, 11),
      want('chopped tomatoes', 1, 12),
    ])

    expect(collated.map((c) => c.first.line.name)).toEqual(['chopped tomatoes', 'lemon'])
    expect(collated[0].nights).toBe(2)
    expect(collated[1].nights).toBe(1)
  })

  it('keeps the earliest night, because that is the one that decides how soon it is needed', () => {
    const collated = collateWants([want('lemon', 4, 11), want('lemon', 4, 12)])
    expect(collated).toHaveLength(1)
    expect(collated[0].first.entryId).toBe(11)
  })

  /** Unmatched lines have no pantry row — and they are exactly the ones that become questions. */
  it('folds unmatched lines on their name', () => {
    const collated = collateWants([
      want('capers', null, 11), want('Capers', null, 12), want(' capers ', null, 13),
    ])
    expect(collated).toHaveLength(1)
    expect(collated[0].nights).toBe(3)
  })

  it('keeps two different things apart even where one has no pantry row', () => {
    const collated = collateWants([want('capers', null, 11), want('capers', 7, 11)])
    expect(collated).toHaveLength(2)
  })
})

describe('how stale the shelves are', () => {
  const now = new Date('2026-08-17T12:00:00Z')

  it('counts a number nobody has confirmed in a fortnight', () => {
    expect(staleCount([
      item({ id: 1, lastSeenAtUtc: '2026-08-16T09:00:00Z' }),
      item({ id: 2, lastSeenAtUtc: '2026-08-01T09:00:00Z' }),
    ], now)).toBe(1)
  })

  /** Never seen is the stalest thing there is — it is a number nobody has ever stood behind. */
  it('counts one that has never been seen at all', () => {
    expect(staleCount([item({ lastSeenAtUtc: null })], now)).toBe(1)
  })

  /** A thing nothing deducts cannot have drifted, so chasing it would pad the badge. */
  it('leaves staples and archived rows out', () => {
    expect(staleCount([
      item({ id: 1, tracking: 'NotCounted', lastSeenAtUtc: null }),
      item({ id: 2, isArchived: true, lastSeenAtUtc: null }),
    ], now)).toBe(0)
  })
})

describe('a night\'s supporting line', () => {
  const cooked = { servings: 4, totalMinutes: 35 }

  it('reads as the arithmetic when there is nothing else to say', () => {
    expect(nightLine(entry({ recipeId: 1 }), cooked)?.text).toBe('for 4 · 35 min')
  })

  it('prefers the servings somebody set for the night', () => {
    expect(nightLine(entry({ recipeId: 1, servingsOverride: 8 }), cooked)?.text)
      .toBe('for 8 · 35 min')
  })

  /**
   * A reason to cook it outranks a description of it. Both would bury the reason — which is the one
   * thing on the row that might change what somebody does tonight.
   */
  it('says what is turning instead, in the live ink', () => {
    const line = nightLine(entry({ recipeId: 1 }), cooked, new Set([1]))
    expect(line).toEqual({ text: "uses what's turning", tone: 'good' })
  })

  /** `Out — Rosa's` says everything it has to say in the title. */
  it('says nothing under a night with no recipe', () => {
    expect(nightLine(entry({ recipeId: null, freeText: "Out — Rosa's" }), undefined)).toBeNull()
  })
})

describe('what the week needs, by thing', () => {
  const shortLine = (over: Partial<StockCheckLineDto> = {}): StockCheckLineDto => ({
    ingredientId: 1, name: 'Beef mince', needed: '1.6 kg', status: 'Short', pantryItemId: 5,
    lastSeenQuantity: null, lastSeenUnit: null, lastSeenState: null, lastSeenAtUtc: null,
    claimedByEntryId: null, claimedQuantity: null, ...over,
  })

  const check = (lines: StockCheckLineDto[]): StockCheckDto => ({
    recipeId: 1, recipeTitle: 'Ragu', servings: 4, lines,
    flaggedCount: lines.length, totalLines: lines.length, notCountedNames: [],
    usualDeliveryWeekday: null,
  })

  /**
   * PLAN_WEEK §1: the band names **things**, with the night that wants each. A list of nights
   * cannot be shopped from — it states the problem rather than the answer.
   */
  it('names the thing and the night that wants it', () => {
    const out = weekShortfalls([
      { entry: entry({ id: 1, date: '2026-08-22' }), check: check([shortLine()]) },
    ])

    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('Beef mince')
    expect(out[0].needed).toBe('1.6 kg')
    expect(out[0].night.date).toBe('2026-08-22')
  })

  /** Two nights wanting the same tin is one line, naming the earlier — they compete for one tin. */
  it('collects a thing two nights want into one line, naming the earlier', () => {
    const out = weekShortfalls([
      { entry: entry({ id: 2, date: '2026-08-23' }), check: check([shortLine()]) },
      { entry: entry({ id: 1, date: '2026-08-21' }), check: check([shortLine()]) },
    ])

    expect(out).toHaveLength(1)
    expect(out[0].night.date).toBe('2026-08-21')
  })

  /** `NoMatch` and `Unknown` are questions, not shortfalls — buying on either is a guess. */
  it('leaves out the lines that are questions rather than shortfalls', () => {
    const out = weekShortfalls([
      {
        entry: entry(),
        check: check([
          shortLine({ ingredientId: 1, status: 'NoMatch', pantryItemId: null }),
          shortLine({ ingredientId: 2, status: 'Unknown', pantryItemId: 9 }),
        ]),
      },
    ])

    expect(out).toEqual([])
  })

  /** A night with nothing worth saying answers 204, and the band must cope with that. */
  it('copes with a night that returned no check at all', () => {
    expect(weekShortfalls([{ entry: entry(), check: undefined }])).toEqual([])
  })
})

describe('where the shown week sits', () => {
  const today = '2026-08-20'

  it('names this week, the next and the last', () => {
    expect(weekBearing('2026-08-17', today, 4).word).toBe('THIS WEEK')
    expect(weekBearing('2026-08-24', today, 4).word).toBe('NEXT WEEK')
    expect(weekBearing('2026-08-10', today, 4).word).toBe('LAST WEEK')
  })

  it('counts further out in weeks', () => {
    expect(weekBearing('2026-09-07', today, 4).word).toBe('3 WEEKS ON')
    expect(weekBearing('2026-08-03', today, 4).word).toBe('2 WEEKS BACK')
  })

  it('lights the segment for the week you are on', () => {
    expect(weekBearing('2026-08-17', today, 4).index).toBe(0)
    expect(weekBearing('2026-08-31', today, 4).index).toBe(2)
  })

  /**
   * A week behind the ruler's start lights nothing. Pinning it to the first segment would say you
   * were looking at this week when you are not, which is worse than showing no segment at all.
   */
  it('lights nothing for a week off the ruler', () => {
    expect(weekBearing('2026-08-10', today, 4).index).toBe(-1)
    expect(weekBearing('2026-09-28', today, 4).index).toBe(-1)
  })
})

describe('what the list is short of, in words', () => {
  const want = (id: number, text: string, checked = false): GroceryLineDto => ({
    id, text, quantity: null, unit: null, pantryItemId: null, sourceKind: 'Hand',
    provenance: [], checkedAtUtc: checked ? '2026-08-17T09:00:00Z' : null,
    returnTrip: null, version: 1, aisle: null, store: null,
  })

  it('names the first few and tallies the rest', () => {
    expect(wantedNames([
      want(1, 'Eggs'), want(2, 'Flour'), want(3, 'Cream'), want(4, 'Spinach'),
      want(5, 'Mince'), want(6, 'Rice'), want(7, 'Oil'),
    ])).toBe('Eggs, Flour, Cream, Spinach +3')
  })

  it('drops the tally when everything fits', () => {
    expect(wantedNames([want(1, 'Eggs'), want(2, 'Flour')])).toBe('Eggs, Flour')
  })

  /** A ticked line has been bought. Naming it under "what we need" would send somebody back out. */
  it('ignores what has already been got', () => {
    expect(wantedNames([want(1, 'Eggs', true), want(2, 'Flour')])).toBe('Flour')
    expect(wantedNames([want(1, 'Eggs', true)])).toBeNull()
  })
})

describe('what tonight is short of', () => {
  const line = (status: StockStatusName): StockCheckLineDto => ({
    ingredientId: 1, name: 'Capers', needed: '2 tbsp', status, pantryItemId: 5,
    lastSeenQuantity: null, lastSeenUnit: null, lastSeenState: null, lastSeenAtUtc: null,
    claimedByEntryId: null, claimedQuantity: null,
  })

  const check = (lines: StockCheckLineDto[]): StockCheckDto => ({
    recipeId: 1, recipeTitle: 'Piccata', servings: 4, lines,
    flaggedCount: lines.length, totalLines: lines.length, notCountedNames: [],
    usualDeliveryWeekday: null,
  })

  /**
   * The home page's amber row states a number, and only the check knows one — the week's summary is
   * a single word and says `Short` whether one thing is missing or nine.
   */
  it('counts the lines that can simply be bought', () => {
    expect(missingTonight(check([line('Short'), line('Gone'), line('Fine')]))).toBe(2)
  })

  /** A question is not a shortfall. Counting one would put a number on something unknown. */
  it('leaves out the ones that need a person', () => {
    expect(missingTonight(check([line('NoMatch'), line('Unknown')]))).toBe(0)
  })

  /** A 204 means the night had nothing worth saying, and the row simply does not appear. */
  it('says nothing when there was no check', () => {
    expect(missingTonight(undefined)).toBe(0)
  })
})

describe('inHandLabel', () => {
  const line = (over: Partial<Parameters<typeof inHandLabel>[0]> = {}) => ({
    status: 'Fine' as StockStatusName, lastSeenQuantity: null,
    lastSeenUnit: null, lastSeenState: null, ...over,
  })

  it('says how much is in, never how much is wanted', () => {
    expect(inHandLabel(line({ lastSeenQuantity: 4 }))).toBe('4')
    expect(inHandLabel(line({ lastSeenQuantity: 200, lastSeenUnit: 'g' }))).toBe('200 g')
  })

  it('renders estimated stock as an approximation that cannot pass for a count', () => {
    expect(inHandLabel(line({ lastSeenQuantity: 3, lastSeenState: 'Plenty' }))).toBe('about')
  })

  it('says `not counted` out loud rather than leaving a staple blank', () => {
    // A blank cell reads as missing data; the truth is a decision not to track it.
    expect(inHandLabel(line({ status: 'NotCounted' }))).toBe('not counted')
  })

  it('says nothing when nothing is known', () => {
    expect(inHandLabel(line())).toBe('')
  })
})
