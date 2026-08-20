/**
 * Pantry domain helpers — the arithmetic and the wording, kept out of the screens so both can be
 * tested without a DOM.
 *
 * The section's governing copy rule lives here as code rather than as discipline
 * (PANTRY_BEHAVIOURS §9): **never assert a quantity without a date**. `amountLabel` and `ageLabel`
 * are designed to be rendered as a pair, and `ageLabel` has a real answer for every input including
 * "never" — so there is no arrangement of these functions that produces a bare number.
 */
import type {
  EstimateStateName,
  GroceryLineDto,
  MealSlotName,
  MealWeekDto,
  MirrorStatusDto,
  PantryItemDto,
  PantryLocationName,
  StockCheckLineDto,
  StockStatusName,
  TrackingClassName,
} from '../api/types'
import { addPlanDays, nextFreeSlot, planDate } from './mealsDomain'

export const LOCATIONS: PantryLocationName[] = ['Cupboard', 'Fridge', 'Freezer']

/** The 9a segment. `All` is a view, not a location, which is why it isn't in `LOCATIONS`. */
export type LocationFilter = 'All' | PantryLocationName

export const LOCATION_FILTERS: LocationFilter[] = ['All', 'Cupboard', 'Fridge', 'Freezer']

/**
 * `SEEN TODAY` / `SEEN 4 D` / `SEEN 2 WK` / `NEVER SEEN`.
 *
 * Days under fourteen, weeks beyond (§3). Null is `NEVER SEEN` rather than blank — an empty age
 * cell beside a quantity is exactly the unhedged claim the section forbids, and "we have never
 * checked" is a genuinely useful thing for a row to say.
 */
export function ageLabel(lastSeenIso: string | null | undefined, now: Date = new Date()): string {
  if (!lastSeenIso) return 'NEVER SEEN'
  const seen = new Date(lastSeenIso)
  if (Number.isNaN(seen.getTime())) return 'NEVER SEEN'

  // Calendar days, not elapsed hours: something seen at 11pm yesterday was seen *yesterday*, and
  // rounding by 24-hour blocks would call that "today" until 11pm tonight.
  const days = calendarDaysBetween(seen, now)
  if (days <= 0) return 'SEEN TODAY'
  if (days < 14) return `SEEN ${days} D`
  return `SEEN ${Math.floor(days / 7)} WK`
}

/** Whole calendar days from `from` to `to`, in local time. Negative clamps to 0. */
export function calendarDaysBetween(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate())
  const days = Math.round((b.getTime() - a.getTime()) / 86_400_000)
  return days < 0 ? 0 : days
}

/**
 * How much is actually on the shelf, in whatever `packUnit` or `unit` names.
 *
 * Five 3 oz pots is fifteen ounces. The multiplication lives here — and in `PantryAmounts` on the
 * server — rather than at each call site, because a packaged row and a loose one look identical in
 * the type and reading one as the other is silent: "five containers" and "five ounces" are both
 * plausible numbers on a shelf list.
 */
export function onHand(item: PantryItemDto): number {
  const quantity = item.quantity ?? 0
  return item.packSize && item.packSize > 0 ? quantity * item.packSize : quantity
}

/**
 * The amount cell: `3 tins`, `3 oz ×5`, `low`, `half a bag`, `none`, `not counted`.
 *
 * The wording carries the tracking class, so the three classes never have to be told apart by
 * colour alone (DECISIONS PG2) — `none` and `not counted` are different sentences, not different
 * shades of the same one.
 *
 * A packaged row reads `size ×count` and never the multiplied total. "15 oz" of yogurt is a number
 * nobody can check by opening the fridge; "3 oz ×5" is five pots, which is a thing you can see. The
 * total still exists for the stock check, which is arithmetic rather than a claim about the shelf.
 */
export function amountLabel(item: PantryItemDto): string {
  if (item.tracking === 'NotCounted') return 'not counted'
  if (item.tracking === 'Estimated') {
    return item.estimateState === 'None' ? 'none' : item.estimateState === 'Low' ? 'low' : 'plenty'
  }
  const quantity = item.quantity ?? 0
  if (quantity <= 0) return 'none'
  if (item.packSize && item.packSize > 0) {
    const pack = item.packUnit ? `${trimNumber(item.packSize)} ${item.packUnit}` : trimNumber(item.packSize)
    // Rounded for the eye only. Cooking four ounces out of 3 oz pots genuinely leaves 3.667 of them,
    // and the stored number keeps every digit — but a shelf list is read at a glance from across a
    // room, and `×3.7` is the same fact in a form somebody can act on.
    return `${pack} ×${trimNumber(Math.round(quantity * 10) / 10)}`
  }
  return item.unit ? `${trimNumber(quantity)} ${item.unit}` : trimNumber(quantity)
}

/**
 * Which of the five row treatments a row gets. Returned as a name so the CSS and the tests agree
 * about the states rather than each re-deriving them from quantities.
 */
export type RowState = 'fine' | 'low' | 'estimated' | 'gone' | 'staple'

export function rowState(item: PantryItemDto): RowState {
  if (item.tracking === 'NotCounted') return 'staple'
  if (item.tracking === 'Estimated') return item.estimateState === 'None' ? 'gone' : 'estimated'
  const quantity = item.quantity ?? 0
  if (quantity <= 0) return 'gone'
  // Two or fewer is the low-water mark the tally counts, so the row and the tally cannot disagree
  // about which items are "probably low".
  return quantity <= LOW_WATER ? 'low' : 'fine'
}

/** The threshold behind both `rowState` and the server's `probablyLow` count. */
export const LOW_WATER = 2

/**
 * `36 THINGS · 4 PROBABLY LOW · 2 PROBABLY OUT`.
 *
 * Always hedged, and a clause at zero is omitted rather than shown as "0" — "0 PROBABLY OUT" reads
 * as a claim about completeness, and §7 is explicit that the tally never reports a score.
 */
export function tallyLine(total: number, probablyLow: number, probablyOut: number): string {
  const parts = [`${total} THING${total === 1 ? '' : 'S'}`]
  if (probablyLow > 0) parts.push(`${probablyLow} PROBABLY LOW`)
  if (probablyOut > 0) parts.push(`${probablyOut} PROBABLY OUT`)
  return parts.join(' · ')
}

/**
 * "Last touched Tuesday by Eleanor. Read it as a good guess — the panel only knows what it was
 * told."
 *
 * The second sentence is fixed and the first is live. Null on an untouched pantry, where the empty
 * state does the talking instead.
 */
export function hedgeLine(
  byName: string | null | undefined,
  atIso: string | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!atIso) return null
  const at = new Date(atIso)
  if (Number.isNaN(at.getTime())) return null

  const days = calendarDaysBetween(at, now)
  const when = days === 0 ? 'today' : days === 1 ? 'yesterday'
    : days < 7 ? at.toLocaleDateString(undefined, { weekday: 'long' })
    : at.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })

  const who = byName ? ` by ${byName}` : ''
  return `Last touched ${when}${who}. Read it as a good guess — the panel only knows what it was told.`
}

/**
 * Group the list for the `ALL` view: by location, then counted first, then estimated, then staples,
 * alphabetical inside each band (§1.6).
 *
 * Staples last is not cosmetic. They are the rows nothing will ever chase you about, and floating
 * them into the middle of the list alphabetically would put "Olive oil — not counted" between two
 * rows that do mean something.
 */
export function groupByLocation(
  items: PantryItemDto[],
): { location: PantryLocationName; items: PantryItemDto[] }[] {
  return LOCATIONS.map((location) => ({
    location,
    items: items
      .filter((i) => i.location === location)
      .sort((a, b) => trackingRank(a.tracking) - trackingRank(b.tracking) || a.name.localeCompare(b.name)),
  }))
}

function trackingRank(tracking: TrackingClassName): number {
  return tracking === 'Counted' ? 0 : tracking === 'Estimated' ? 1 : 2
}

/** "Nothing in the freezer yet" — the section is never hidden; an absent shelf reads as a bug (§6). */
export function emptyShelfLine(location: PantryLocationName): string {
  return `Nothing in the ${location.toLowerCase()} yet`
}

// ---- 9b · the stock check ----

/**
 * Statuses that appear under `WORTH A LOOK`. `NotCounted` and `Fine` never do.
 *
 * **`ClaimedAway` counts.** The tin is on the shelf and it is not this night's — an earlier night
 * already spoke for it. Reading that as "already in" is the exact double-count `PlanClaim` exists
 * to prevent, and it is worse than a plain shortfall because the number on the shelf agrees with
 * you right up until Saturday.
 */
export function isFlagged(status: StockStatusName): boolean {
  return status === 'Short' || status === 'Gone' || status === 'Unknown'
    || status === 'NoMatch' || status === 'ClaimedAway'
}

/**
 * "You'll probably need three things" — words up to ten, figures beyond (§9).
 *
 * Never "you are short three things". The whole title is a hedge, and it is the first thing on the
 * screen precisely so the tone is set before any number is read.
 */
export function shortfallTitle(count: number): string {
  return `You'll probably need ${numberWord(count)} thing${count === 1 ? '' : 's'}`
}

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

export function numberWord(n: number): string {
  return n >= 0 && n < WORDS.length ? WORDS[n] : String(n)
}

/**
 * The evidence sentence under a flagged line — **always dated**.
 *
 * Four shapes, one per status, each of which names what the panel actually knows and when it knew
 * it. There is deliberately no fallback that omits the date: a line whose age is unknown says so.
 */
export function evidenceLine(line: StockCheckLineDto, now: Date = new Date()): string {
  const when = relativeWords(line.lastSeenAtUtc, now)

  switch (line.status) {
    case 'Short':
      return line.lastSeenQuantity != null
        ? `The pantry last saw ${trimNumber(line.lastSeenQuantity)}${line.lastSeenUnit ? ` ${line.lastSeenUnit}` : ''}, ${when}.`
        : `The pantry hasn't counted this since ${when}.`
    case 'Gone':
      return `Marked gone ${when} and never replaced.`
    case 'Unknown':
      return line.lastSeenState === 'Low'
        ? `There's some, marked low ${when}. No way to tell if that's enough.`
        : `There's some on the shelf, last seen ${when}. No way to tell how much is left.`
    case 'NoMatch':
      return 'Not something the pantry tracks.'
    default:
      return `Last seen ${when}.`
  }
}

/**
 * "six days ago" / "three weeks ago" / "at some point" — the words the evidence sentences are built
 * from. Words up to ten, matching the copy rule.
 */
export function relativeWords(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'at some point'
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return 'at some point'

  const days = calendarDaysBetween(at, now)
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 14) return `${numberWord(days)} days ago`
  const weeks = Math.floor(days / 7)
  return `${numberWord(weeks)} week${weeks === 1 ? '' : 's'} ago`
}

/**
 * "The other six lines look fine, and two of them — oil, salt — aren't counted at all."
 *
 * Staples are named only here, never as a problem (§9). Returns null when there is nothing
 * reassuring to say, rather than an empty sentence.
 */
export function tailLine(total: number, flagged: number, notCounted: string[]): string | null {
  const fine = total - flagged
  if (fine <= 0) return null

  const head = `The other ${numberWord(fine)} line${fine === 1 ? '' : 's'} look${fine === 1 ? 's' : ''} fine`
  if (notCounted.length === 0) return `${head}.`

  const named = notCounted.slice(0, 3).map((n) => n.toLowerCase()).join(', ')
  return `${head}, and ${numberWord(notCounted.length)} of them — ${named} — aren't counted at all.`
}

/**
 * "Move it to Friday" — the night the stock check's first action moves a dinner to.
 *
 * §3 words the target as "the next date whose stock check clears", but the check has no date
 * dimension: it compares a recipe against the shelves *now*, so asking it about Thursday and about
 * Friday returns the same answer and no date would ever clear. What actually changes the shelves is
 * a delivery, and the panel does know roughly when those land — so the target is the first free
 * night from the usual delivery weekday onward. That is exactly what the row's consequence line has
 * been promising all along ("the delivery lands Thursday").
 *
 * With fewer than three deliveries on record there is no weekday to work from, and this falls back
 * to §3's own stated fallback: the first free night.
 */
export function moveTarget(
  from: string,
  deliveryWeekday: string | null,
  week: MealWeekDto | null,
  visibleSlots: MealSlotName[],
): string {
  const searchFrom = deliveryWeekday ? weekdayAfter(from, deliveryWeekday) : addPlanDays(from, 1)
  return nextFreeSlot(week, visibleSlots, searchFrom)?.date
    // The delivery may land past the end of the loaded week, or every night after it may already be
    // planned. Either way the action still has to move the night somewhere real.
    ?? nextFreeSlot(week, visibleSlots, addPlanDays(from, 1))?.date
    ?? addPlanDays(from, 1)
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** The next date strictly after `from` falling on the named weekday. */
function weekdayAfter(from: string, weekday: string): string {
  const target = WEEKDAYS.indexOf(weekday)
  if (target < 0) return addPlanDays(from, 1)
  for (let i = 1; i <= 7; i++) {
    const candidate = addPlanDays(from, i)
    if (planDate(candidate).getDay() === target) return candidate
  }
  return addPlanDays(from, 1)
}

// ---- 9e · grocery ----

/** `FOR THIS WEEK'S MEALS` · `ADDED BY HAND` · `GOT IT`, in that order. */
export interface GrocerySection {
  key: 'meals' | 'hand' | 'done'
  label: string
  lines: GroceryLineDto[]
}

export function grocerySections(lines: GroceryLineDto[]): GrocerySection[] {
  const open = lines.filter((l) => !l.checkedAtUtc)
  return [
    {
      key: 'meals',
      label: "FOR THIS WEEK'S MEALS",
      // LowStock lines sit here too: both are the panel's own suggestions rather than someone's
      // note, and a third section for "because you're running out" would split one idea in two.
      lines: open.filter((l) => l.sourceKind !== 'Hand'),
    },
    { key: 'hand', label: 'ADDED BY HAND', lines: open.filter((l) => l.sourceKind === 'Hand') },
    { key: 'done', label: 'GOT IT', lines: lines.filter((l) => l.checkedAtUtc) },
  ]
}

/** `Chicken Piccata · Wed  ·  Sheet-pan salmon · Fri` — merged provenance, date-ascending. */
export function provenanceLine(line: GroceryLineDto): string {
  return line.provenance
    .map((p) => (p.forDate ? `${p.label} · ${weekdayShort(p.forDate)}` : p.label))
    .join('  ·  ')
}

function weekdayShort(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  if (!y || !m || !d) return isoDate
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short' })
}

/**
 * What the mirror strip says. Direction and age, always — it is permanent, never a toast
 * (DECISIONS PG8).
 */
export function mirrorLines(mirror: MirrorStatusDto, now: Date = new Date()): {
  label: string
  detail: string
  tone: 'ok' | 'warn' | 'off'
} {
  if (mirror.state === 'Off') {
    return { label: 'NOT MIRRORED · LOCAL LIST ONLY', detail: 'The list lives on the panel.', tone: 'off' }
  }

  const list = mirror.listName ? `List “${mirror.listName}”` : 'The list'

  if (mirror.state === 'Healthy') {
    return {
      label: 'MIRRORED TO MICROSOFT TO DO',
      detail: `${list} · both ways · ${agoWords(mirror.lastSyncedUtc, now)}`,
      tone: 'ok',
    }
  }

  if (mirror.state === 'SignInExpired') {
    return {
      label: 'MICROSOFT SIGN-IN EXPIRED',
      detail: mirror.message ?? 'Nothing lost — sign in again to start it back up.',
      tone: 'warn',
    }
  }

  // Failing. States what it will do next, and never implies anything was dropped.
  const queued = mirror.queuedCount
  const changes = queued === 1 ? 'one change' : `${queued} changes`
  return {
    label: "COULDN'T REACH MICROSOFT TO DO",
    detail: queued > 0
      ? `Nothing lost — ${changes} will go up when it's back. Last tried ${agoWords(mirror.lastAttemptUtc, now)}.`
      : `Nothing lost. Last tried ${agoWords(mirror.lastAttemptUtc, now)}.`,
    tone: 'warn',
  }
}

/** "2 minutes ago" / "an hour ago" / "yesterday" — refreshed on render (§8). */
export function agoWords(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'never'
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return 'never'

  const seconds = Math.floor((now.getTime() - at.getTime()) / 1000)
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`
  const days = calendarDaysBetween(at, now)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

// ---- shared formatting ----

/**
 * `3`, `2.5`, `0.25` — a count without trailing zeros.
 *
 * Deliberately *not* the fraction formatting the recipe screens use. A pantry count is a number of
 * packs read off a shelf, and rendering `2.5` as `2 1/2` would dress a stock figure up as a recipe
 * amount.
 */
export function trimNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const rounded = Math.round(value * 1000) / 1000
  return Number.isInteger(rounded) ? String(rounded) : String(rounded)
}

/** `needs 6`, `needs 4 tbsp` — the right-hand cell of a shortfall row. */
export function neededLabel(needed: string | null): string | null {
  return needed ? `needs ${needed}` : null
}

/** Estimate words for the receipt's right-hand cell. */
export function estimateWord(state: EstimateStateName | string | null): string {
  switch (state) {
    case 'None': return 'none'
    case 'Low': return 'low'
    case 'MostLeft': return 'most left'
    case 'Plenty': return 'plenty'
    default: return '—'
  }
}
