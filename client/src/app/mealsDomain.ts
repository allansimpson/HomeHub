/**
 * Derived values for the Meals section (MEALS_DATA_CONTRACT §4). Everything here is **computed,
 * never stored** — start-by times, cooked-history phrasing, scaled amounts, the next free night.
 *
 * Plan dates are plain `YYYY-MM-DD` calendar dates, not instants. A meal slot is "Tuesday's
 * dinner", so these helpers construct dates at local noon rather than parsing the string through
 * `new Date()`, which reads it as UTC midnight and lands on Monday for anyone west of Greenwich.
 */
import type {
  MealDayDto, MealPlanEntryDto, MealRoleName, MealSlotName, MealWeekDto, RecipeSummaryDto,
} from '../api/types'
// Times a household reads are said the same way everywhere — see `dates.clockFromMinutes`. The
// storage form stays here, in `formatClock`.
import { clockFromMinutes } from './dates'

// ---- The panel's own address ----

/**
 * The address a phone on the same wi-fi could open the panel at, or null when there isn't one.
 *
 * On the real panel this is the server's LAN address — the kiosk loads `http://<lan-ip>:5000`
 * (deploy/pi-kiosk.md), so a phone can open the same host. Loopback is the null case: it is the
 * panel's address only from the panel itself, and the screens that print it are telling someone to
 * type it into another device. `localhost` there is an instruction that cannot work.
 */
export function panelAddress(): string | null {
  const name = window.location.hostname
  if (name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === '[::1]') return null
  return window.location.host
}

// ---- Calendar dates ----

/** `YYYY-MM-DD` for a local Date. */
export function planKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * A plan date string as a local Date. Noon, deliberately: it is the only time of day that survives
 * both DST transitions and any accidental UTC round-trip without changing which day it is.
 */
export function planDate(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d, 12, 0, 0, 0)
}

export const todayKey = (): string => planKey(new Date())

export function addPlanDays(key: string, n: number): string {
  const d = planDate(key)
  d.setDate(d.getDate() + n)
  return planKey(d)
}

/** Monday of the week containing `d`. The planner's weeks read "3 — 9 AUGUST", Monday-first. */
export function weekStart(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  // getDay() is Sunday-0; Sunday belongs to the week that began six days earlier, not the one
  // starting tomorrow.
  out.setDate(out.getDate() - ((out.getDay() + 6) % 7))
  return out
}

const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER']
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export const shortWeekday = (key: string): string => WEEKDAYS[planDate(key).getDay()]
export const longWeekday = (key: string): string => WEEKDAYS_LONG[planDate(key).getDay()]
export const dayNumber = (key: string): number => planDate(key).getDate()

/** `MON 3 AUG` — the header date line and the modal titles. */
export function shortDate(key: string): string {
  const d = planDate(key)
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`
}

/** `3 — 9 AUGUST`, collapsing to `28 JULY — 3 AUGUST` when the week straddles a month. */
export function weekLabel(startKey: string): string {
  const from = planDate(startKey)
  const to = planDate(addPlanDays(startKey, 6))
  const sameMonth = from.getMonth() === to.getMonth()
  return sameMonth
    ? `${from.getDate()} — ${to.getDate()} ${MONTHS[to.getMonth()]}`
    : `${from.getDate()} ${MONTHS[from.getMonth()]} — ${to.getDate()} ${MONTHS[to.getMonth()]}`
}

// ---- Clock ----

/** `HH:MM` (24h) → minutes since midnight, or null if unparseable. */
export function parseClock(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/**
 * Minutes since midnight → `HH:MM`, wrapping across midnight so a long cook shows yesterday's start.
 *
 * <b>The storage form, not the reading form.</b> `dinnerTime` is written back through this and read
 * again by `parseClock`, and `<input type="time">` accepts nothing else — so it stays padded and
 * 24-hour. Everything shown to a household goes through `dates.clockFromMinutes` instead; the two
 * were the same function once, which is how `18:00` ended up on screens beside `6:00 PM`.
 */
export function formatClock(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`
}

export interface StartBy {
  /** `6:15 PM` — when to begin cooking, as the screen says it. */
  start: string
  /** `6:30 PM` — when the food reaches the table. */
  serve: string
  /** Total cook time in minutes — the "35 min to the table" number. */
  minutes: number
  /** Minutes past the start time right now; 0 or negative means there is still time. */
  lateBy: number
}

/**
 * When to start, given the household's dinner time and the recipe's total. Rounded **down** to five
 * minutes: a start time of 17:53 is precision the recipe does not have, and rounding down is the
 * direction that leaves the cook time intact rather than quietly shortening it.
 *
 * Returns null when `totalMinutes` is null — the screen then hides the whole start-by block and
 * keeps the dish, rather than showing `0 MIN` and inventing a claim about a recipe that never
 * said how long it takes.
 */
export function startBy(dinnerTime: string, totalMinutes: number | null, now: Date): StartBy | null {
  const dinner = parseClock(dinnerTime)
  if (dinner == null || totalMinutes == null || totalMinutes <= 0) return null
  const startMinutes = dinner - totalMinutes
  const rounded = Math.floor(startMinutes / 5) * 5
  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  return {
    start: clockFromMinutes(rounded),
    serve: clockFromMinutes(dinner),
    minutes: totalMinutes,
    lateBy: nowMinutes - rounded,
  }
}

// ---- Cooked history phrasing ----

/**
 * The folder's history column value: `NEVER`, `THIS WEEK`, or whole weeks.
 *
 * Weeks rather than days because the question the column answers is "are we sick of this yet",
 * and nobody holds that opinion to the day (MEALS_DATA_CONTRACT §3.3). Under a week has no useful
 * number at all, so it says so in words.
 */
export function cookedAgoLabel(lastCookedDate: string | null, today = new Date()): string {
  if (!lastCookedDate) return 'NEVER'
  const days = Math.floor((planDate(planKey(today)).getTime() - planDate(lastCookedDate).getTime()) / 86_400_000)
  if (days < 7) return 'THIS WEEK'
  return `${Math.floor(days / 7)} WKS`
}

/** `COOKED` / `COOKED 2×` — the caption under the history value. */
export function cookedCountLabel(timesCooked: number): string {
  return timesCooked > 1 ? `COOKED ${timesCooked}×` : 'COOKED'
}

/** Days since a recipe was last cooked; `Infinity` for never, so it sorts to the top of NOT LATELY. */
export function daysSinceCooked(recipe: RecipeSummaryDto, today = new Date()): number {
  if (!recipe.lastCookedDate) return Infinity
  return Math.floor((planDate(planKey(today)).getTime() - planDate(recipe.lastCookedDate).getTime()) / 86_400_000)
}

// ---- Plan queries ----

/**
 * The dish a slot is *called* — its main.
 *
 * A slot can now hold several entries, so this returns the lowest-position one rather than
 * whichever the response happened to list first. Every screen that asks "what is on Tuesday" wants
 * the main; the ones that want the whole arrangement call {@link entriesFor}.
 */
export const entryFor = (day: MealDayDto | undefined, slot: MealSlotName): MealPlanEntryDto | undefined =>
  entriesFor(day, slot)[0]

/**
 * How many of the visible slots across the week are planned. No denominator — the footer says so.
 *
 * Counts **slots, not entries**. A night of a main and two sides is one night planned; counting
 * rows would report "three nights planned this week" for a single Tuesday.
 */
export function plannedCount(week: MealWeekDto | null, visibleSlots: MealSlotName[]): number {
  if (!week) return 0
  const visible = new Set(visibleSlots)
  return week.days.reduce(
    (n, d) => n + new Set(d.entries.filter((e) => visible.has(e.slot)).map((e) => e.slot)).size,
    0,
  )
}

/**
 * The first visible slot with nothing in it, from tomorrow forward — what the leftovers checkbox
 * and the "move it to Thursday" row name. Returns null when the rest of the loaded week is full,
 * and those controls then say so rather than naming a night at random.
 */
export function nextFreeSlot(
  week: MealWeekDto | null,
  visibleSlots: MealSlotName[],
  fromKey = addPlanDays(todayKey(), 1),
): { date: string; slot: MealSlotName } | null {
  if (!week) return null
  for (const day of week.days) {
    if (day.date < fromKey) continue
    for (const slot of visibleSlots) {
      if (!entryFor(day, slot)) return { date: day.date, slot }
    }
  }
  return null
}

/**
 * The most recent past dinner still awaiting an answer — what the Meals home's LAST NIGHT row asks
 * about. Only dinner, and only one: the confirm is a soft ask, and a stack of them would be a chore
 * rather than a question (MEALS_BEHAVIOURS §4).
 */
export function unconfirmedPastDinner(week: MealWeekDto | null, today = todayKey()): MealPlanEntryDto | null {
  if (!week) return null
  // The main only. One answer covers the whole night (MEALS_GROUPS §5), so asking per dish would
  // stack three identical questions about one dinner.
  const past = week.days
    .filter((d) => d.date < today)
    .map((d) => mainFor(d, 'Dinner'))
    .filter((e): e is MealPlanEntryDto => e != null && e.wasEaten === null)
  return past.length ? past[past.length - 1] : null
}

// ---- Arrangements: several recipes on one night (MEALS_GROUPS) ----

/** Every entry on a slot, in cooking order. The main is always first. */
export function entriesFor(day: MealDayDto | undefined, slot: MealSlotName): MealPlanEntryDto[] {
  return (day?.entries ?? [])
    .filter((e) => e.slot === slot)
    .sort((a, b) => a.position - b.position)
}

/** The main dish on a slot — what the night is called. */
export const mainFor = (day: MealDayDto | undefined, slot: MealSlotName): MealPlanEntryDto | undefined =>
  entriesFor(day, slot)[0]

/**
 * The minimum a thing needs to have a place in the order.
 *
 * Deliberately narrower than either `MealPlanEntryDto` or `MealComponentDto`: the schedule is the
 * same derivation whether it is being worked out for tonight's arrangement or for a saved meal's
 * detail screen, and giving it its own shape is what stops those two drifting apart.
 */
export interface SchedulableComponent {
  title: string
  role: MealRoleName
  totalMinutes: number | null
  recipeId: number | null
}

/** Turn a night's plan entries into schedulable components. */
export const schedulableEntries = (entries: MealPlanEntryDto[]): SchedulableComponent[] =>
  entries.map((e) => ({
    title: e.freeText ?? e.recipeTitle ?? '',
    role: e.role,
    totalMinutes: e.totalMinutes,
    recipeId: e.recipeId,
  }))

export interface ScheduleRow {
  /** `6:15 PM` to start this component, or null when the recipe never said how long it takes. */
  start: string | null
  /**
   * The same moment as minutes since midnight — what the ordering and "what's next" are computed on.
   *
   * <b>Carried rather than re-derived from `start`.</b> The rows used to be sorted by
   * `start.localeCompare(...)` and `nextComponent` re-parsed the string with `parseClock`, both of
   * which worked only while `start` was a zero-padded 24-hour clock: `6:15 PM` sorts before
   * `5:00 PM` lexically, and parses to nothing at all. Sorting formatted text was fragile before the
   * display changed — this is the number the arithmetic wanted in the first place.
   */
  startMinutes: number | null
  title: string
  role: MealRoleName
  minutes: number | null
  recipeId: number | null
}

/**
 * The order a night is cooked in — MEALS_GROUPS §2, and the reason meals are worth modelling at all.
 *
 * A single recipe has one start-by; several have an *order*. Entirely derived: for each component
 * `dinnerTime − totalMinutes`, rounded down to five minutes, exactly as the single-dish start-by is
 * computed. **Nothing new is stored.**
 *
 * A component with no cook time is listed without one, below the ones that have them — it still has
 * to be made, and dropping it from the list would be the panel quietly forgetting a dish.
 *
 * Known limitation, accepted for M3 (§2): components are assumed independent. "Toast under the grill
 * once the sauce is down" is a dependency, and lives in the meal's prep note as words rather than
 * being modelled here.
 */
export function nightSchedule(
  entries: SchedulableComponent[],
  dinnerTime: string,
): { rows: ScheduleRow[]; serve: string | null } {
  const dinner = parseClock(dinnerTime)
  if (dinner == null) return { rows: [], serve: null }

  const rows: ScheduleRow[] = entries.map((e) => {
    const startMinutes = e.totalMinutes != null ? Math.floor((dinner - e.totalMinutes) / 5) * 5 : null
    return {
      start: startMinutes != null ? clockFromMinutes(startMinutes) : null,
      startMinutes,
      title: e.title,
      role: e.role,
      minutes: e.totalMinutes,
      recipeId: e.recipeId,
    }
  })

  // Earliest start first — that is the order someone actually works through. Untimed components
  // sort last rather than being interleaved at an invented position.
  rows.sort((a, b) => {
    if (a.startMinutes === null && b.startMinutes === null) return 0
    if (a.startMinutes === null) return 1
    if (b.startMinutes === null) return -1
    return a.startMinutes - b.startMinutes
  })

  return { rows, serve: clockFromMinutes(dinner) }
}

/**
 * The component that should go on next, given the time — what the cook view's strip names.
 * Null once everything has been started.
 */
export function nextComponent(
  rows: ScheduleRow[],
  now: Date,
  /** The dish already being cooked. Never offered back as "next" — you are on it. */
  excludeRecipeId?: number | null,
): { row: ScheduleRow; minutesAway: number } | null {
  const nowMinutes = now.getHours() * 60 + now.getMinutes()

  /**
   * How far ahead a component can be and still be worth naming.
   *
   * Start times are clock times with no date, so a night whose slots have all passed reads as
   * "starts again in seventeen hours" once the clock is past them — technically the next occurrence,
   * and useless as a prompt. Six hours is comfortably longer than any single evening's cooking and
   * short enough that a stale night stays quiet.
   */
  const HORIZON_MINUTES = 6 * 60

  for (const row of rows) {
    if (row.startMinutes === null) continue
    if (excludeRecipeId != null && row.recipeId === excludeRecipeId) continue
    const away = row.startMinutes - nowMinutes
    // `away >= 0` rather than `> 0`: a component due this very minute is due, not passed.
    if (away >= 0 && away <= HORIZON_MINUTES) return { row, minutesAway: away }
  }
  return null
}

// ---- Serving scaling ----

/** Fractions worth rendering as fractions. Anything else falls back to a trimmed decimal. */
const FRACTIONS: [number, string][] = [
  [1 / 8, '1/8'], [1 / 4, '1/4'], [1 / 3, '1/3'], [3 / 8, '3/8'], [1 / 2, '1/2'],
  [5 / 8, '5/8'], [2 / 3, '2/3'], [3 / 4, '3/4'], [7 / 8, '7/8'],
]

const UNICODE_FRACTIONS: Record<string, number> = {
  '¼': 0.25, '½': 0.5, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
}

/** The leading amount of an ingredient line: `1 1/2`, `3/4`, `½`, `2`, `0.5`. */
const LEADING_AMOUNT = /^(\s*)(\d+\s+\d+\/\d+|\d+\/\d+|\d+\s*[¼½¾⅓⅔⅛⅜⅝⅞]|[¼½¾⅓⅔⅛⅜⅝⅞]|\d+(?:[.,]\d+)?)/

/**
 * A scaled amount, written the way a cook would write it.
 *
 * Precision is chosen by magnitude, not by arithmetic. Scaling 500g by 8/6 gives 666.667, and both
 * obvious renderings of that are wrong for a kitchen: `666 2/3g` asks for two-thirds of a gram, and
 * `666.67g` asks for a hundredth. Neither is a thing anyone can weigh, and printing them makes a
 * correct number look like a broken one.
 *
 * So: big amounts (grams, millilitres) round to the nearest 5 — below a scale's useful resolution
 * and never a fraction. Mid-range amounts round to whole units. Only small amounts, which is where
 * spoons and cups live, get fractions — and there they are what a recipe would actually say.
 */
export function formatAmount(value: number, preferFraction: boolean): string {
  if (!Number.isFinite(value) || value <= 0) return '0'

  // 100+ is a weight or a volume in grams/ml. Five is finer than any domestic scale is honest to.
  if (value >= 100) return String(Math.round(value / 5) * 5)
  // 20–100 is still past the point where a fraction reads as precision rather than noise.
  if (value >= 20) return String(Math.round(value))

  const whole = Math.floor(value)
  const rest = value - whole

  // Effectively whole already — don't manufacture a fraction out of floating-point dust.
  if (rest < 0.02) return String(whole)

  const hit = FRACTIONS.find(([v]) => Math.abs(rest - v) < 0.02)
  if (hit) return whole > 0 ? `${whole} ${hit[1]}` : hit[1]

  // No clean fraction. A line that was written as a fraction keeps reading as one via the nearest
  // eighth; a line written as a decimal stays decimal rather than acquiring a fraction it never had.
  if (preferFraction) {
    const eighths = Math.round(rest * 8) / 8
    const near = FRACTIONS.find(([v]) => Math.abs(eighths - v) < 0.001)
    if (near) return whole > 0 ? `${whole} ${near[1]}` : near[1]
    if (eighths === 0) return String(whole)
    if (eighths === 1) return String(whole + 1)
  }

  // Two decimals is as fine as a small kitchen measurement gets; trailing zeros are noise.
  return String(Math.round(value * 100) / 100)
}

/**
 * An ingredient line at a different serving count.
 *
 * **`rawText` is never rebuilt from the parsed fields** (MEALS_DATA_CONTRACT §1) — only the amount
 * at the front of the line is substituted, so "2 cloves garlic, finely sliced" keeps every word the
 * source wrote. A line the parser could not read (`quantity == null`) comes back untouched: that is
 * the `AS WRITTEN` state, not an error, and guessing an amount for it would be worse than leaving
 * the cook to do the arithmetic themselves.
 */
export function scaleLine(rawText: string, quantity: number | null, factor: number): string {
  if (quantity == null || factor === 1) return rawText
  const match = LEADING_AMOUNT.exec(rawText)
  // Parsed a quantity but it isn't at the front (an amount buried mid-line). Substituting anywhere
  // else risks rewriting a word, so the line stands as written.
  if (!match) return rawText
  const original = match[2]
  const preferFraction = original.includes('/') || [...original].some((c) => c in UNICODE_FRACTIONS)
  const scaled = formatAmount(quantity * factor, preferFraction)
  return match[1] + scaled + rawText.slice(match[0].length)
}

/** `6 OF 9 LINES SCALE` — how much of a recipe actually moves with the servings. */
export function scalableLines(ingredients: { quantity: number | null }[]): { scalable: number; total: number } {
  return { scalable: ingredients.filter((i) => i.quantity != null).length, total: ingredients.length }
}

// ---- Words ----

const WORDS = [
  'NO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN',
  'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN',
  'NINETEEN', 'TWENTY',
]

/**
 * Small counts as words — `SIX NIGHTS PLANNED THIS WEEK`, `ELEVEN RECIPES`. The section's rule
 * lines read as sentences rather than as readouts, and a numeral in the middle of one reads as a
 * value that might be about to change.
 */
export function countWord(n: number): string {
  return n >= 0 && n < WORDS.length ? WORDS[n] : String(n)
}

/** `35 min`, `1 hr 20 min`, `2 hr` — durations in the shortest honest form. */
export function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`
}

/** How long ago an instant was, in the phrasing the attribution strip uses. */
export function agoLabel(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return `${seconds} SECONDS AGO`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} MIN AGO`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} ${hours === 1 ? 'HOUR' : 'HOURS'} AGO`
  const days = Math.round(hours / 24)
  return `${days} ${days === 1 ? 'DAY' : 'DAYS'} AGO`
}

// ---- Folder ----

/**
 * Grouping by cuisine switches on at twenty recipes. Below that the flat list is shorter than the
 * grouped one would be, because group headers cost rows that a dozen recipes do not earn.
 */
export const GROUPING_THRESHOLD = 20

/**
 * Search matches the name, source and tags — never ingredients, because the folder list doesn't
 * carry them and no search endpoint exists (MEALS_DATA_CONTRACT §1). The UI says so out loud
 * rather than silently missing "chicken".
 *
 * Case- and accent-insensitive, matching from any word boundary: typing "cur" finds "Green Curry"
 * but not "obscure".
 */
export function normaliseForSearch(text: string): string {
  // NFD splits "é" into "e" + a combining accent, which \p{M} then drops — so "creme" finds "crème".
  // The Unicode property escape rather than a literal codepoint range: a class of combining marks
  // is invisible in an editor and gets mangled by anything that re-normalises the source file.
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

export function matchesAtWordBoundary(haystack: string, needle: string): boolean {
  if (!needle) return true
  const h = normaliseForSearch(haystack)
  const n = normaliseForSearch(needle)
  let from = 0
  for (;;) {
    const at = h.indexOf(n, from)
    if (at < 0) return false
    if (at === 0 || /[^a-z0-9]/.test(h[at - 1])) return true
    from = at + 1
  }
}
