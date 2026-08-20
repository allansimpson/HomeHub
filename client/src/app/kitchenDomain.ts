import type {
  DueRecipeDto,
  GroceryLineDto,
  MealDayDto,
  MealPlanEntryDto,
  MealWeekDto,
  OrderImportLineDto,
  PantryItemDto,
  PantryLocationName,
  PlanStockSummaryName,
  ShelfLifeDto,
  StockCheckDto,
  StockStatusName,
} from '../api/types'
import { calendarDaysBetween } from './pantryDomain'
import { planDate, weekStart } from './mealsDomain'

/**
 * The Kitchen's own vocabulary — the words the answering page and the week put on a row.
 *
 * Kept out of the components for the usual reason: these are the rules the specs argue about, and a
 * rule embedded in JSX cannot be tested against the sentence that justified it. Every function here
 * corresponds to a line in PLAN_WEEK, the Kitchen home panel, or KITCHEN_LOOP_ADDENDUM §4.
 */

/** The four destinations the quick row opens, in order. Four is the ceiling — a fifth is a tab bar. */
export const KITCHEN_DESTINATIONS = ['Plan', 'Pantry', 'Recipes', 'List'] as const

/**
 * Whole calendar days from `from` to `to`, **signed**.
 *
 * `calendarDaysBetween` clamps a negative to zero, which is right for an age — nothing was ever
 * seen in the future — and wrong for a horizon. A night that has already gone past would come back
 * as zero days away, pass every `within n days` test, and read as urgent for the rest of time.
 */
export function calendarDaysUntil(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate())
  return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}

export type KitchenDestination = (typeof KITCHEN_DESTINATIONS)[number]

/**
 * The one word a planned night carries (PLAN_WEEK §1).
 *
 * Returns null for a night with nothing to say — an empty night, or one whose verdict has not been
 * settled yet. **A night that is not cooking reads `NO COOKING`, not blank**: "Out — Rosa's" is a
 * plan, and leaving it wordless would make it look like a gap somebody forgot to fill.
 */
export function stockWord(entry: MealPlanEntryDto): string | null {
  if (entry.recipeId == null && entry.freeText == null) return null

  switch (entry.stockSummary) {
    case 'Covered':
      return 'ALL IN'
    case 'Short':
      return 'SHORT'
    case 'Unknown':
      return "CAN'T SAY"
    case 'NoClaim':
      return 'NO COOKING'
    default:
      // Not settled yet. Saying nothing is right: the pantry is advisory, and a word invented
      // while the answer is in flight would be a claim the panel cannot stand behind.
      return null
  }
}

/**
 * Which of the four verdicts deserves the amber ink.
 *
 * Only `Short`. `CAN'T SAY` is a question rather than a warning (DECISIONS PG6), and colouring it
 * amber would tell the household to act on the one thing the panel has just admitted it does not
 * know.
 */
export function stockNeedsAttention(summary: PlanStockSummaryName | null): boolean {
  return summary === 'Short'
}

/**
 * `OPEN 5 D` / `OPEN 2 W` — how long something has been open (KITCHEN_LOOP_ADDENDUM §4).
 *
 * Days under a fortnight, weeks beyond, matching the `SEEN` label's thresholds exactly. Two age
 * labels on one row that rounded differently would read as a bug.
 */
export function openLabel(
  openedAtUtc: string | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!openedAtUtc) return null

  const days = calendarDaysUntil(new Date(openedAtUtc), now)
  if (days < 0) return null
  if (days === 0) return 'OPEN TODAY'
  if (days < 14) return `OPEN ${days} D`
  return `OPEN ${Math.floor(days / 7)} W`
}

/**
 * The `USE IT OR LOSE IT` band's contents, or null when there is nothing turning.
 *
 * **Null rather than an empty band.** The panel spec is explicit: the band disappears entirely when
 * nothing is turning, and never shows an empty heading. A household that has just shopped should
 * see one row fewer, not a section telling them there is nothing to worry about.
 */
export function turningBand(due: DueRecipeDto[]): { lead: DueRecipeDto; count: number } | null {
  const ranked = due.filter((d) => d.score > 0)
  if (ranked.length === 0) return null
  return { lead: ranked[0], count: ranked.length }
}

/**
 * How the lead card names what it would use up — "Spinach, cream and open tomatoes".
 *
 * Named rather than counted, because "uses 3 things" does not tell you whether it is worth cooking.
 * Capped at three: past that the sentence stops being readable at panel distance, and the recipe
 * itself is one tap away.
 */
export function usesSentence(uses: string[]): string {
  const named = uses.slice(0, 3)
  if (named.length === 0) return ''
  if (named.length === 1) return named[0]
  if (named.length === 2) return `${named[0]} and ${named[1]}`
  return `${named[0]}, ${named[1]} and ${named[2]}`
}

/**
 * The next few nights the home page lists — three or four, never seven.
 *
 * The full week lives behind PLAN. Repeating it on the answering page would make the two screens
 * compete, and the home page is meant to answer rather than to plan.
 */
export function nextNights(
  week: MealWeekDto | null,
  todayKey: string,
  take = 3,
): MealDayDto[] {
  if (!week) return []
  return week.days.filter((d) => d.date > todayKey).slice(0, take)
}

/**
 * Everything the week is short of, collected once (PLAN_WEEK §1's `THE WEEK NEEDS`).
 *
 * Counted over nights rather than ingredients: the band says how many nights need something, which
 * is the number that decides whether a shop is worth making. What exactly they need is behind the
 * band, and is the review's job to work out.
 */
export function nightsNeedingSomething(week: MealWeekDto | null): MealPlanEntryDto[] {
  if (!week) return []
  return week.days
    .flatMap((d) => d.entries)
    .filter((e) => e.stockSummary === 'Short')
}

/**
 * Items worth putting in front of somebody, most-open first.
 *
 * Sorted by how long they have been open, which is the only freshness fact the section will claim
 * to know. Items that were never opened are not "fresh" — they are simply not evidence, so they are
 * left out rather than sorted to the bottom.
 */
export function openItems(items: PantryItemDto[], now: Date = new Date()): PantryItemDto[] {
  return items
    .filter((i) => i.openedAtUtc != null && !i.isArchived)
    .sort((a, b) => {
      const aDays = calendarDaysBetween(new Date(a.openedAtUtc!), now)
      const bDays = calendarDaysBetween(new Date(b.openedAtUtc!), now)
      if (aDays !== bDays) return bDays - aDays
      return a.name.localeCompare(b.name)
    })
}

/**
 * Past this many days a `SEEN` label stops counting days and starts counting weeks — which is the
 * point at which the panel is admitting it no longer really knows.
 */
export const STALE_DAYS = 14

/**
 * How many numbers on the shelves are old enough to be worth confirming.
 *
 * This is the badge on the pantry's sync control (PANTRY_SHELVES §1), and it is what makes the
 * check a tool that states its own size rather than a nag: the household can see there are six to
 * settle before deciding to go and stand at a cupboard.
 *
 * Counted against the same threshold the `SEEN` label changes units at, so the badge and the rows
 * can never disagree about which of them is old. Staples are excluded — a thing nothing deducts
 * cannot have a number that has drifted.
 */
export function staleCount(items: PantryItemDto[], now: Date = new Date()): number {
  return items.filter((i) => {
    if (i.isArchived || i.tracking === 'NotCounted') return false
    if (!i.lastSeenAtUtc) return true
    return calendarDaysBetween(new Date(i.lastSeenAtUtc), now) >= STALE_DAYS
  }).length
}

/**
 * Whether a date key is in the past relative to another.
 *
 * Compared as calendar dates, never as instants — a night is a night whatever time zone the panel
 * thinks it is in (meals-planning.md D7).
 */
export function isBefore(key: string, otherKey: string): boolean {
  return planDate(key).getTime() < planDate(otherKey).getTime()
}

/** Lines wanted within this many days count as `NEEDED SOON` in the shop. */
export const SOON_DAYS = 3

/**
 * Whether a planned night wants this line within the horizon (LIST_AND_SHOPPING §5).
 *
 * **A filter and a marker, never a notification.** It changes what the shop shows and puts a brass
 * bar on a row; nothing about it pushes, badges or counts down.
 *
 * A line with no night behind it is never urgent, however long it has sat on the list — wanting
 * something for a while is not the same as needing it on Thursday.
 *
 * **A night that has already passed is not urgent either.** The horizon is signed for that reason:
 * a clamped one would read last Tuesday as nought days away and mark the row for good, so a list
 * left alone for a fortnight would end up entirely brass-barred and the mark would stop meaning
 * anything.
 */
export function neededSoon(line: GroceryLineDto, now: Date = new Date()): boolean {
  return line.provenance.some((p) => {
    if (!p.forDate) return false
    const [y, m, d] = p.forDate.split('-').map(Number)
    if (!y || !m || !d) return false

    const days = calendarDaysUntil(now, new Date(y, m - 1, d))
    return days >= 0 && days <= SOON_DAYS
  })
}

/**
 * Whether a shortfall can simply be bought, or wants a person first (LIST_AND_SHOPPING §2).
 *
 * **`NoMatch` and `Unknown` are questions, not shortfalls.** The first means the app cannot tell
 * what the thing is; the second means it cannot tell how much is left. Neither is evidence that
 * anything is missing, and adding either to a list on that basis is how a household ends up with
 * three jars of the thing it already had.
 */
export function isBuyable(status: StockStatusName): boolean {
  return status === 'Short' || status === 'Gone' || status === 'ClaimedAway'
}

/** The other half of {@link isBuyable} — the lines that get a decision card. */
export function needsAPerson(status: StockStatusName): boolean {
  return status === 'NoMatch' || status === 'Unknown'
}

/**
 * The one word a recipe carries, and the same one the week uses (RECIPES §2).
 *
 * **Short outranks can't-say**, because being short is actionable and not knowing is not. A recipe
 * that is both reads `SHORT`: telling somebody to go and match an ingredient when they are also
 * missing two would bury the thing they can actually do something about.
 */
export function stockVerdict(shortCount: number, unmatchedCount: number): string {
  if (shortCount > 0) return `${shortCount} SHORT`
  return unmatchedCount > 0 ? "CAN'T SAY" : 'ALL IN'
}

/**
 * Minutes named in a cooking step — `simmer for 20 minutes` (COOKING_AND_AFTER §1).
 *
 * **Offered, never started.** A timer that began on its own would be counting the wrong thing about
 * half the time: the step says twenty minutes of simmering, and the pan is not on yet.
 *
 * Returns null when the step names no duration, which is most of them.
 */
export function stepTimerMinutes(text: string): number | null {
  const match = /(\d+)\s*(minutes?|mins?|hours?|hrs?)\b/i.exec(text)
  if (!match) return null

  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return null
  return /^h/i.test(match[2]) ? value * 60 : value
}

/**
 * Seconds left on an offered step timer, as `M:SS` (COOKING_AND_AFTER §1).
 *
 * **Not `formatClock`.** That one reads minutes-since-midnight and renders a wall clock, so a timer
 * started at twenty minutes flipped straight from `20:00` to `00:20` and then counted down through
 * times of day. A countdown and a clock are different things that happen to share a colon.
 */
export function countdown(seconds: number): string {
  const left = Math.max(0, Math.ceil(seconds))
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
}

/**
 * Which ingredients one step names, so only those sit beside it (COOKING_AND_AFTER §1).
 *
 * Matched on the parsed name rather than the raw line, and only for names long enough to mean
 * something — "1 tbsp oil" should not attach itself to every step containing the word "oil" inside
 * "boil", and a three-letter name is more likely to be a substring of an unrelated word than a
 * genuine mention.
 */
export const STEP_NAME_FLOOR = 4

export function ingredientsForStep(
  ingredients: { rawText: string; name: string | null }[],
  stepText: string,
): string[] {
  const words = ` ${stepText.toLowerCase()} `
  return ingredients
    .filter((i) => {
      const name = i.name?.toLowerCase()
      if (name == null || name.length < STEP_NAME_FLOOR) return false
      // Word-boundary rather than a bare includes, for the "boil"/"oil" case above.
      return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(words)
    })
    .map((i) => i.rawText)
}

// ---- Putting a shop away (LIST_AND_SHOPPING §4) ----

/** A ticked line that needs no decision — it goes straight to a shelf. */
export interface PutAwayLanding {
  line: GroceryLineDto
  location: PantryLocationName
  /** Pre-filled from the shelf-life guesses. Always ignorable. */
  goodUntil: string | null
  fresh: boolean
  /**
   * The row this line is **already back on**, or null when putting it away has to create one.
   *
   * Ticking a line off has already returned its stock through the ledger (DECISIONS P8) — the same
   * event a tick in To Do produces. So a line that knows its shelf is amended here, never created:
   * creating meant one tin bought became two tins on the shelf, and nothing downstream could tell
   * which of the two was the fiction.
   */
  existing: PantryItemDto | null
}

/** A ticked line the app and the shop disagree about. */
export interface PutAwayQuestion {
  line: GroceryLineDto
  kind: 'substitution' | 'split'
  onTheList: string
  cameHome: string
  /**
   * The row this line came back to, for the same reason a landing carries one.
   *
   * Always null on a substitution — a line with no pantry item of its own is what *makes* it a
   * substitution. A split can have one, and then splitting has to divide what the tick already
   * returned rather than adding the whole amount a second time.
   */
  existing: PantryItemDto | null
}

/**
 * A pack big enough that recording it as one row makes every later count wrong — 2.4 kg of mince is
 * six meals, not one thing.
 */
export const SPLIT_KG = 2

/**
 * Sort a shop's ticked lines into the ones that just go away and the ones that need answering.
 *
 * Out here rather than in the panel because this is where the double-count lived: whether a line
 * creates stock or amends it is a rule about the ledger, not about a layout, and it is invisible on
 * screen either way — both readings render the identical row.
 */
export function planPutAway(
  ticked: GroceryLineDto[],
  shelves: PantryItemDto[],
  shelfLife: ShelfLifeDto[],
  now: Date = new Date(),
): { landings: PutAwayLanding[]; questions: PutAwayQuestion[] } {
  const byId = new Map(shelves.map((i) => [i.id, i]))

  const landings: PutAwayLanding[] = []
  const questions: PutAwayQuestion[] = []

  for (const line of ticked) {
    const existing = line.pantryItemId == null ? null : byId.get(line.pantryItemId) ?? null

    // A line that came home under a different name than the one asked for is a substitution
    // question, not a silent rename: accepting it teaches an alias, and that is a household
    // decision rather than a guess.
    if (line.pantryItemId == null && line.provenance.length > 0) {
      questions.push({
        line,
        kind: 'substitution',
        onTheList: line.provenance[0]?.label ?? line.text,
        cameHome: amountOf(line),
        existing: null,
      })
      continue
    }

    // One big thing that is really several.
    if (line.quantity != null && line.quantity >= SPLIT_KG && line.unit === 'kg') {
      questions.push({
        line, kind: 'split', onTheList: line.text, cameHome: amountOf(line), existing,
      })
      continue
    }

    const guess = shelfLife.find((s) =>
      s.state === 'Fresh' && line.text.toLowerCase().includes(s.foodKind.toLowerCase()))

    landings.push({
      line,
      // Where a thing already lives beats where the shelf-life table would guess it goes. The row
      // is shown, so the guess on it has to be the one that would actually be applied.
      location: existing?.location ?? (guess ? 'Fridge' : 'Cupboard'),
      goodUntil: existing?.goodUntil ?? (guess ? addDays(guess.days, now) : null),
      fresh: guess != null,
      existing,
    })
  }

  return { landings, questions }
}

/** `2 kg`, or the line's own words when it never carried a number. */
export function amountOf(line: GroceryLineDto): string {
  if (line.quantity == null) return line.text
  return line.unit ? `${line.quantity} ${line.unit}` : `${line.quantity}`
}

/** A date `days` from `now`, as `YYYY-MM-DD` in local time. */
export function addDays(days: number, now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ---- Reading a delivery in (SETTINGS_AND_IMPORT §3) ----

/**
 * How the import's lines fall out on screen, and how many of them applying will actually shelve.
 *
 * `going` counts what the server will put away, which is every line it managed to read. It is not
 * the number of questions somebody got through: apply leaves an unreadable line behind whether or
 * not `SKIP THEM` was ever pressed, so counting the presses promised more than the button delivered.
 */
export function sortImportLines(lines: OrderImportLineDto[]): {
  matched: OrderImportLineDto[]
  questions: OrderImportLineDto[]
  unasked: OrderImportLineDto[]
  going: number
} {
  const matched = lines.filter((l) =>
    l.matchedPantryItemId != null && l.confidence !== 'Unreadable')
  // Two failure modes, both cards: a shop substitution, and a line the reader garbled.
  const questions = lines.filter((l) => l.confidence === 'Unreadable'
    || (l.matchedPantryItemId == null && l.proposedName != null && l.proposedName !== l.rawText))
  const unasked = lines.filter((l) => !matched.includes(l) && !questions.includes(l))

  return {
    matched,
    questions,
    unasked,
    going: lines.filter((l) => l.confidence !== 'Unreadable').length,
  }
}

// ---- The question afterwards (COOKING_AND_AFTER §2) ----

/**
 * How many a night was cooked for, or null when nothing says.
 *
 * **The recipe's own servings when nobody overrode them**, which is most nights: an override is
 * what you set when cooking for a different number than usual. Reading only the override meant
 * `OR SOME OF IT` never appeared on an ordinary night — and it took the leftovers card with it,
 * because spare portions can only be counted against a number of servings.
 */
export function servingsPlanned(
  entry: MealPlanEntryDto | undefined,
  // Structural, like `ingredientsForStep`: this reads two fields, so a caller should not have to
  // build a whole summary to ask the question.
  recipes: { id: number; servings: number | null }[],
): number | null {
  if (!entry) return null
  return entry.servingsOverride
    ?? recipes.find((r) => r.id === entry.recipeId)?.servings
    ?? null
}

// ---- The review (LIST_AND_SHOPPING §2) ----


// ---- The week (PLAN_WEEK §1) ----

/** A night's supporting line, and how loudly it should read. */
export interface NightLine {
  text: string
  tone: 'quiet' | 'good'
}

/**
 * The second line under a night's name — `for 8 · 35 min`, or `uses what's turning`.
 *
 * **The turning line outranks the arithmetic.** Servings and minutes describe the night; that it
 * would use something on the turn is a *reason to cook it*, which is the one thing on the row that
 * might change what somebody does. Saying both would bury the reason in the description.
 *
 * Null for a night with no recipe behind it. `Out — Rosa's` and a free-text night say everything
 * they have to say in the title, and inventing a line under them would pad the row.
 */
export function nightLine(
  entry: MealPlanEntryDto,
  recipe: { servings: number | null; totalMinutes: number | null } | undefined,
  turningRecipeIds: ReadonlySet<number> = new Set(),
): NightLine | null {
  if (entry.recipeId == null) return null

  if (turningRecipeIds.has(entry.recipeId)) {
    return { text: "uses what's turning", tone: 'good' }
  }

  const parts = [
    (entry.servingsOverride ?? recipe?.servings) != null
      ? `for ${entry.servingsOverride ?? recipe?.servings}`
      : null,
    recipe?.totalMinutes != null ? `${recipe.totalMinutes} min` : null,
  ].filter(Boolean)

  return parts.length > 0 ? { text: parts.join(' · '), tone: 'quiet' } : null
}

/** One thing the week is short of, and the night that wants it. */
export interface WeekShortfall {
  key: string
  name: string
  night: MealPlanEntryDto
  needed: string | null
}

/**
 * Everything the whole week is short of, each line naming the night that wants it.
 *
 * **Things, not nights** (PLAN_WEEK §1). The band exists so the list can be made in one pass, and a
 * list of nights cannot be shopped from — it names the problem rather than the answer, and sends
 * somebody into a second screen per night to find out what to buy.
 *
 * Collected once per thing. Two nights wanting mince is one line naming the earlier of them: the
 * claim settle has already worked out that they are competing for the same stock, and printing the
 * row twice would read as needing two lots.
 */
export function weekShortfalls(
  results: { check: StockCheckDto | undefined; entry: MealPlanEntryDto }[],
): WeekShortfall[] {
  const found = new Map<string, WeekShortfall>()

  for (const { check, entry } of results) {
    if (!check) continue
    for (const line of check.lines) {
      if (!isBuyable(line.status)) continue

      // Keyed on the shelf where there is one, so two spellings of the same tin collapse; on the
      // name only when nothing on the shelves answers to it, which is the case that has no id.
      const key = line.pantryItemId != null ? `item-${line.pantryItemId}` : `name-${line.name}`
      const existing = found.get(key)
      if (existing && existing.night.date <= entry.date) continue

      found.set(key, { key, name: line.name, night: entry, needed: line.needed })
    }
  }

  return [...found.values()]
}

/** Where the shown week sits relative to the one you are living in, for the pager. */
export interface WeekBearing {
  /** `THIS WEEK`, `NEXT WEEK`, `3 WEEKS ON`, `2 WEEKS BACK`. */
  word: string
  /** Which ruler segment lights, or -1 when the week is off the ruler entirely. */
  index: number
}

/**
 * The pager's two orienting facts (PLAN_WEEK §1).
 *
 * The date range alone does not say whether you are looking at the week you are living in, and that
 * is the thing you most need to know before editing it — `18 — 24 August` is only meaningful to
 * somebody who already knows today's date, which is exactly what a wall panel is for not having to.
 *
 * The ruler runs from this week forward, because a plan is made forwards. A week behind the ruler's
 * start lights nothing rather than pinning to the first segment: no segment is honest there, and a
 * wrong one would say you are looking at this week when you are not.
 */
export function weekBearing(
  weekStartKey: string,
  todayKey: string,
  segments: number,
): WeekBearing {
  const here = planDate(weekStartKey)
  const mine = weekStart(planDate(todayKey))
  const weeks = Math.round((here.getTime() - mine.getTime()) / (7 * 86_400_000))

  const word = weeks === 0 ? 'THIS WEEK'
    : weeks === 1 ? 'NEXT WEEK'
      : weeks === -1 ? 'LAST WEEK'
        : weeks > 0 ? `${weeks} WEEKS ON`
          : `${Math.abs(weeks)} WEEKS BACK`

  return { word, index: weeks >= 0 && weeks < segments ? weeks : -1 }
}

/**
 * `Eggs, flour, cream, spinach +3` — what the answering page's `WHAT WE NEED` says.
 *
 * **Named, then counted.** A heading with a number behind it and nothing under it is a door with no
 * sign on it: four names tell you at a glance whether this is a shop worth making, and `7 OPEN`
 * alone never does. The overflow is a tally rather than more names because past four the line stops
 * being readable across a kitchen.
 */
export function wantedNames(lines: GroceryLineDto[], take = 4): string | null {
  const open = lines.filter((l) => l.checkedAtUtc == null)
  if (open.length === 0) return null

  const named = open.slice(0, take).map((l) => l.text)
  const rest = open.length - named.length
  return rest > 0 ? `${named.join(', ')} +${rest}` : named.join(', ')
}

/**
 * How many of tonight's lines want a person, for the home page's one amber row.
 *
 * Counted from the check rather than from the night's `stockSummary`, because the row states a
 * number and the summary is one word: `Short` says something is missing and never how much.
 */
export function missingTonight(check: StockCheckDto | undefined): number {
  if (!check) return 0
  return check.lines.filter((l) => isBuyable(l.status)).length
}

// ---- The bisected cut (PANTRY_SHELVES §1) ----

/**
 * The height a scroll group must be for its next row to be visibly bisected, in canvas pixels.
 *
 * `N × rowH + rowH/2`. The half-row is not decoration: the native scrollbar is hidden and there is
 * no track, so the row cut through the middle is the **only** signal that the group continues.
 *
 * The failure this exists to prevent is silent. A height landing on a row boundary clips nothing
 * but padding, and the group then reads as a complete list with nothing below it — no error, no
 * clipped glyph, just a household that never finds out there are four more things in the cupboard.
 * Three panels in one segment shipped that way before the rule was written down.
 */
export function cutHeight(rows: number, rowHeight: number): number {
  return rows * rowHeight + rowHeight / 2
}

/**
 * What the `ALREADY IN` column says — how much is **in**, never how much is wanted.
 *
 * The reference draws `Onions 4`, `Carrots 6`, `Celery 1 head`: a band headed *already in* that
 * answers with the recipe's requirement is answering a different question from the one its own
 * heading asks, and it reads as a shortfall list that has lost its amber.
 *
 * **`about` for estimated stock**, which can never be made to look like a count — and `not counted`
 * said out loud for a staple rather than left blank, because a blank cell reads as missing data
 * when the truth is a deliberate decision not to track it.
 */
export function inHandLabel(line: {
  status: StockStatusName
  lastSeenQuantity: number | null
  lastSeenUnit: string | null
  lastSeenState: string | null
}): string {
  if (line.status === 'NotCounted') return 'not counted'
  if (line.lastSeenState != null) return 'about'
  if (line.lastSeenQuantity == null) return ''
  return line.lastSeenUnit
    ? `${line.lastSeenQuantity} ${line.lastSeenUnit}`
    : `${line.lastSeenQuantity}`
}

/** One thing to buy, and how many of the planned nights are asking for it. */
export interface CollatedWant<T> {
  /** Stable across nights: the pantry row where there is one, else the name. */
  key: string
  /** The earliest night that wants it — the one whose figures the row shows. */
  first: T
  /** How many planned nights want it. */
  nights: number
}

/**
 * One line per *thing*, not per night-and-thing (LIST_AND_SHOPPING §2).
 *
 * The review walks several nights and each answers its own stock check, so two nights wanting
 * tinned tomatoes produce two identical wants. Left uncollated that is a shopping list with the
 * same item on it twice — and, worse, `THESE NEED YOU` asks *what is capers?* once per night while
 * a single answer silently settles all of them. A question the household can only answer once must
 * only be asked once.
 *
 * Keyed on the pantry row where there is one and the name otherwise, because an unmatched line has
 * no pantry row — and unmatched lines are exactly the ones that become questions.
 *
 * Input order is preserved, so callers that walk nights in date order get the earliest night first.
 */
export function collateWants<T extends {
  line: { pantryItemId: number | null; name: string }
}>(wants: T[]): CollatedWant<T>[] {
  const byKey = new Map<string, CollatedWant<T>>()

  for (const want of wants) {
    const key = want.line.pantryItemId != null
      ? `item:${want.line.pantryItemId}`
      : `name:${want.line.name.trim().toLowerCase()}`

    const seen = byKey.get(key)
    if (seen) seen.nights += 1
    else byKey.set(key, { key, first: want, nights: 1 })
  }

  return [...byKey.values()]
}
