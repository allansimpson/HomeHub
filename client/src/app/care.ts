import type { IconId } from '../icons/Icon'
import type { CareEntryDto, CareEntryInput, CareEntryTypeName } from '../api/types'
import { clockLabel } from './dates'

/**
 * The words the Care tab says about a logged moment.
 *
 * <b>Pure, and apart from the screens, because every sentence here is a claim about a child's
 * medical record.</b> The design makes the review line the confirmation — there is no hold, no
 * second dialogue, no undo toast — so what it says is the whole of what somebody agreed to before
 * pressing SAVE. A line that omits a field, or names one that was never filled, is worse than no
 * line at all.
 */

/** The ten tiles, in the design's reading order. Growth is not a tile — it is a deliberate entry. */
export const CARE_TILES: CareEntryTypeName[] = [
  'Bottle', 'Nursing', 'Pump', 'Diaper', 'Solids',
  'Sleep', 'Medicine', 'Bath', 'TummyTime', 'Temperature',
]

/** How a type is named on a tile and in a sheet header. */
export const CARE_LABELS: Record<CareEntryTypeName, string> = {
  Bottle: 'Bottle',
  Nursing: 'Breast',
  Pump: 'Pump',
  Diaper: 'Diaper',
  Solids: 'Solids',
  Sleep: 'Sleep',
  Medicine: 'Medicine',
  Bath: 'Bath',
  TummyTime: 'Tummy time',
  Temperature: 'Temperature',
  Growth: 'Growth',
}

/**
 * Types that are a running session rather than a moment.
 *
 * <b>Tummy time joined them, and it is the clearest case of the four.</b> It is a thing somebody
 * starts, watches, and stops — the whole reason to log it is how long it lasted — and the panel
 * offered a minutes stepper, which meant watching a clock somewhere else and typing the answer
 * afterwards. Its sheet carries `stopwatch`, the plain one-button start: no side, no phases.
 */
export const TIMED_TYPES: CareEntryTypeName[] = ['Nursing', 'Sleep', 'Pump', 'TummyTime']

/**
 * Stimulation, then expression — the pump's two phases, in minutes.
 *
 * <b>3 and 17, which is the household's own pattern rather than the design's 5 and 20.</b> The
 * handoff draws the pair it observed; these are the lengths actually used, and the panel opens on
 * them because the whole point of the pre-fill is that the common case needs no adjustment.
 *
 * The design remembers these per person and reopens on whatever was last used; until that is
 * stored, these are the defaults, and they are what the tile caption reports.
 */
export const PUMP_PHASES: [number, number] = [3, 17]

/**
 * The medicines this household gives, and the dose each is given at.
 *
 * <b>Named here rather than only discovered from the log.</b> The WHAT list is built from what has
 * actually been given, which is right — but it is empty until something has been, and the first
 * dose is exactly when nobody wants to be typing a name at 3am. These three are always offered, and
 * anything else the log has seen joins them.
 *
 * The dose comes with the name: choosing one fills the stepper, so the ordinary case is two taps.
 */
export const CARE_MEDICINES: { name: string; amount: number; unit: string }[] = [
  { name: 'Pepcid', amount: 0.6, unit: 'ml' },
  { name: 'Vitamin D', amount: 0.25, unit: 'ml' },
  { name: 'Simethicone', amount: 0.25, unit: 'ml' },
]

/** The glyph on each tile. Ten concepts, drawn to the section set's geometry. */
export const CARE_ICONS: Record<CareEntryTypeName, IconId> = {
  Bottle: 'ico-bottle',
  Nursing: 'ico-breast',
  Pump: 'ico-pump',
  Diaper: 'ico-diaper',
  Solids: 'ico-solids',
  Sleep: 'ico-sleep',
  Medicine: 'ico-medicine',
  Bath: 'ico-bath',
  TummyTime: 'ico-tummytime',
  Temperature: 'ico-temperature',
  Growth: 'ico-person',
}

/**
 * Which running sessions make you hold to stop them, rather than tap.
 *
 * <b>Pump only, and the asymmetry is the point.</b> Every timed session can be ended by a knee
 * against a wall panel; what differs is what that costs. A nursing or tummy-time session ended by
 * mistake is re-enterable from memory — you know roughly when it started and which side. A sleep is
 * the same. A pump session is not: its value is the length the panel measured and the amount asked
 * for afterwards, and once the timer is thrown away there is nothing to type back in. So it is the
 * one place the guard is worth the friction, on both ways out — cancelling loses the session and
 * finishing early shortens it.
 *
 * Named here rather than written inline as `type === 'Pump'` so the rule has somewhere to be tested
 * and somewhere to be argued with when a fifth timed type arrives.
 */
export function holdsToStop(type: CareEntryTypeName): boolean {
  return type === 'Pump'
}

/**
 * The title on a panel, which is not always the word on its tile.
 *
 * `BREAST` is a tile label — twelve characters of letterspaced small caps in a 2-up grid, where
 * "breast feeding" would wrap. The panel has a 29px serif line to itself and says the whole thing.
 * Only nursing differs; the rest fall through to their tile label.
 */
export function careTitle(type: CareEntryTypeName): string {
  return type === 'Nursing' ? 'Breast feeding' : CARE_LABELS[type]
}

/**
 * How long ago, as the SINCE rows say it: `34M`, `2H 23M`, `3D`.
 *
 * Days lose their minutes on purpose — past a day the question has stopped being "how long" and
 * become "has it happened at all", and `3D 4H 12M` answers a question nobody asked at 3am.
 */
export function elapsedLabel(fromIso: string, now: Date = new Date()): { value: string; stale: boolean } {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(fromIso)) / 60_000))
  if (minutes < 60) return { value: `${minutes}M`, stale: false }

  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return { value: rest === 0 ? `${hours}H` : `${hours}H ${rest}M`, stale: false }
  }
  // Stale drives the row's ink: measured in days, it drops to muted so the recent rows lead.
  return { value: `${Math.floor(hours / 24)}D`, stale: true }
}

/** `3.5 oz`, `7 min`, `—` — the value a tile or a log row shows. */
export function valueLabel(entry: CareEntryDto): string {
  if (entry.amount != null) return `${trim(entry.amount)} ${entry.unit ?? ''}`.trim()
  if (entry.durationMinutes != null) return `${trim(entry.durationMinutes)} min`
  if (entry.pounds != null) return `${trim(entry.pounds)} lb ${trim(entry.ounces ?? 0)} oz`
  // An em dash, not a zero. A pump session with no amount was never measured, and printing 0
  // would state a measurement nobody took — which is precisely the upstream bug being avoided.
  return '—'
}

/**
 * Wire values whose reading is not their spelling with the underscores taken out.
 *
 * <b>`both` is the original.</b> The wire carries it because that is the source data's word, and
 * the household reads MIXED everywhere it is shown. Mapping here rather than at each call site is
 * what stops a tile saying "Both" while the sheet beside it says "mixed".
 *
 * <b>`breast_formula` is the bottle that is some of each</b> — `design_handoff_baby/README.md` §7,
 * where it is a sixth content value in its own right rather than a note on one of the other five.
 * The slash is the whole point of the label and no amount of underscore-stripping produces it.
 */
const KIND_WORDS: Record<string, string> = {
  both: 'Mixed',
  breast_formula: 'Breast / formula',
}

/** `Poo`, `Mixed`, `Breast milk` — a wire value as the household reads it. */
export function kindLabel(kind: string | null | undefined): string | null {
  if (!kind) return null
  return KIND_WORDS[kind] ?? capitalise(kind.replace(/_/g, ' '))
}

/**
 * `medium` — how big it was, from whichever of the two columns the entry used.
 *
 * The API splits the size across `peeAmount` and `pooAmount`; the panel asks the question once. Any
 * screen showing it has to look in both places or it will report "no size" on half the diapers.
 */
export function sizeLabel(entry: CareEntryDto): string | null {
  return entry.pooAmount ?? entry.peeAmount
}

/**
 * The line under a SINCE row's name — the last entry of that type, in a word or two.
 *
 * Not {@link valueLabel}, which answers "how much" and belongs in the right-hand numeral column. A
 * diaper measures nothing, so that column is an em dash for it and this line carries the whole of
 * what the row knows: **which kind it was.** "Diaper · —" answers the question nobody asked, and it
 * was on the one row where "pee or poo" is the entire content of the record.
 */
export function detailLabel(entry: CareEntryDto): string {
  switch (entry.type) {
    case 'Diaper': {
      const kind = kindLabel(entry.kind)
      const amount = sizeLabel(entry)
      if (!kind) return 'Logged'
      // `Medium poo` when the amount was recorded — it is the other half of the same fact, and the
      // sheet already carried it over from the last entry.
      return amount ? `${capitalise(amount)} ${kind.toLowerCase()}` : kind
    }

    case 'Bottle': {
      const contents = kindLabel(entry.kind)
      return contents ? `${valueLabel(entry)} ${contents.toLowerCase()}` : valueLabel(entry)
    }

    /*
     * Said in words, not left as an em dash.
     *
     * The dash is right in the right-hand numeral column, where the question is "how much" and the
     * answer is nothing. Here there is room for the reason, and "no amount recorded" is a different
     * statement from a blank: it says somebody saved the session deliberately without weighing it,
     * which is the ordinary case for a pump.
     */
    case 'Pump':
      return entry.amount == null ? 'No amount recorded' : valueLabel(entry)

    case 'Nursing': {
      const duration = durationWords(entry.durationMinutes)
      const side = entry.side ? capitalise(entry.side) : null
      return [side, duration].filter(Boolean).join(' ') || '—'
    }

    case 'Sleep':
    case 'TummyTime':
      return durationWords(entry.durationMinutes) ?? '—'

    case 'Medicine':
      return entry.kind ? `${valueLabel(entry)} ${entry.kind}` : valueLabel(entry)

    default:
      return valueLabel(entry)
  }
}

/** `7m 35s`, `1h 13m` — a duration as the SINCE line says it. Null when there is none. */
export function durationWords(minutes: number | null | undefined): string | null {
  if (minutes == null) return null
  const hours = Math.floor(minutes / 60)
  const wholeMinutes = Math.floor(minutes % 60)
  // Seconds are dropped past the hour: `1h 13m 4s` answers a question nobody asked about a nap.
  if (hours > 0) return `${hours}h ${wholeMinutes}m`
  const seconds = Math.round((minutes - Math.floor(minutes)) * 60)
  if (wholeMinutes === 0) return `${seconds}s`
  return seconds > 0 ? `${wholeMinutes}m ${seconds}s` : `${wholeMinutes}m`
}

/**
 * When it happened, as the SINCE line's tail: `8:33 PM` today, `Aug 10` before that.
 *
 * The switch is the point. A clock time on something three days old is a number that looks precise
 * and tells you nothing — by then the question has moved on to which *day*, which is the same
 * reason {@link elapsedLabel} drops to whole days at the right-hand end of the row.
 */
export function whenLabel(iso: string, now: Date = new Date()): string {
  const at = new Date(iso)
  if (at.toDateString() === now.toDateString()) return clockLabel(at)
  return at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * `Today` / `Yesterday` / `Tuesday 12 August` — the heading a run of rows sits under.
 *
 * <b>One definition, read by both logs.</b> It began inside `MikaView`, which has had day sub-heads
 * over the robot's events since that screen was built; the baby's entries list now blocks by day for
 * the same reason, and two screens deciding separately what to call yesterday is how one of them
 * ends up saying `Aug 18` while the other says `Yesterday` about the same rows.
 *
 * The boundary is local midnight, not 24 hours ago: a 1:25 AM feed happened *today* whatever the
 * elapsed figure beside it says. Note this deliberately disagrees with the TODAY page's 6 AM
 * window, which is a different question and documented as such in {@link careWindowStart}.
 */
export function dayLabel(iso: string, now: number): string {
  const day = new Date(iso)
  const today = new Date(now)
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  if (day.getTime() >= midnight) return 'Today'
  if (day.getTime() >= midnight - 86_400_000) return 'Yesterday'
  return day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
}

/**
 * The panel counts in words up to ten, then in figures.
 *
 * Ten is where a spelled number stops being easier to read than a numeral — and the counts these
 * labels carry (a day's entries, a selection) are almost always under it.
 */
export function countWord(n: number): string {
  const words = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
  return n < words.length ? words[n] : String(n)
}

/** `nine entries` — the tally on the right of a day heading. */
export function entriesLabel(count: number): string {
  return `${countWord(count)} ${count === 1 ? 'entry' : 'entries'}`
}

/*
 * `whenStamp` used to live here — the clock with `Aug 14 · ` in front of it once a row was older
 * than today. The entries list was its only caller, and that list now puts the day in a heading
 * above each run of rows, so every row under `YESTERDAY` reading `Aug 18 · 1:35 PM` was the date
 * said twice. The rows carry {@link clockLabel} alone and the heading carries the day.
 */

/**
 * `2H 23M` split so the letters can be set small beside the numerals.
 *
 * The design sets the figure in Marcellus 24px and its unit letters at 12px, which cannot be done
 * with one string. Derived from {@link elapsedLabel} rather than recomputed, so there is still one
 * place that decides when an age stops being hours and becomes days.
 */
export function elapsedParts(fromIso: string, now: Date = new Date()): {
  parts: { value: string; unit: string }[]
  stale: boolean
} {
  const { value, stale } = elapsedLabel(fromIso, now)
  const parts = [...value.matchAll(/(\d+)([A-Z])/g)].map((m) => ({ value: m[1], unit: m[2] }))
  return { parts, stale }
}

/**
 * The start of the current care day: 6 AM, not midnight.
 *
 * <b>A night feed belongs to the night it happened in.</b> A 1:25 AM bottle is part of the stretch
 * that began the previous morning, and a calendar day splits that stretch in half — so at 2am the
 * midnight totals read as though almost nothing had been given, which is the opposite of true.
 *
 * Deliberately *not* reconciled with the calendar-day list in Today's log. The handoff is explicit
 * that the two answer different questions: this one is "how has the night gone", that one is "what
 * was logged on the 13th".
 */
/**
 * How many days of log one read reaches back — and therefore how far TODAY can be paged.
 *
 * <b>One number, because two places need to agree about it.</b> `useCareLog` asks the server for
 * this many days, and the TODAY page lets a swipe walk back through them; a cap larger than the
 * read would page onto days that are empty because nothing was *fetched*, which on a totals page
 * is indistinguishable from a day where nothing happened. Raising the read raises the walk, in one
 * edit.
 *
 * The last reachable window opens at 6 AM on the earliest day read, which is inside the read — it
 * starts at that day's midnight — so every day in the range is whole.
 */
export const CARE_HISTORY_DAYS = 7

export function careWindowStart(now: Date = new Date()): Date {
  const start = new Date(now)
  start.setHours(6, 0, 0, 0)
  if (now.getHours() < 6) start.setDate(start.getDate() - 1)
  return start
}

/**
 * The 6 AM → 6 AM window that `daysBack` days ago belongs to.
 *
 * <b>Counted in days, not in milliseconds.</b> `setDate` walks the calendar, so a window either
 * side of a daylight-saving change is still the same 6 AM to 6 AM the household would recognise;
 * subtracting 86,400,000 would put one of them at 5 AM or 7 AM twice a year, silently, and only in
 * the weeks nobody is looking for it.
 *
 * `daysBack` of zero is the window TODAY already counts, so the two agree by construction.
 */
export function careWindowFor(daysBack: number, now: Date = new Date()): { from: Date; to: Date } {
  const from = careWindowStart(now)
  from.setDate(from.getDate() - daysBack)
  const to = new Date(from)
  to.setDate(to.getDate() + 1)
  return { from, to }
}

/**
 * The day a window is *called*, which is not always the day it opened on.
 *
 * The window in force at 2 AM opened at 6 AM yesterday, and the page has always called it TODAY —
 * because that is what somebody standing at the panel at 2 AM means by today. So the name comes
 * from the calendar day the window is counted *against*, not from its start: today less `daysBack`.
 *
 * Read through {@link dayLabel}, so TODAY, YESTERDAY and `Monday, 18 August` are the same three
 * words the LOG page's day headings use. One vocabulary for the same fact.
 */
export function careWindowLabel(daysBack: number, now: Date = new Date()): string {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  day.setDate(day.getDate() - daysBack)
  return dayLabel(day.toISOString(), now.getTime())
}

/** One row of the TODAY page: what it was, how much, and whether the window is empty of it. */
export interface WindowTotal {
  type: CareEntryTypeName
  detail: string
  /**
   * The row's own time column — `Last 4:00 AM`, `8:20 AM`, or null.
   *
   * Its own field rather than a clause on the end of {@link detail}, because the design gives the
   * time a fixed column of its own on every page of the pager
   * (`design_handoff_baby/README.md` §"List row"). A row with nothing to put here renders no column
   * at all and lets the name block have the width — an empty 88px gap is worse than no column.
   */
  time: string | null
  value: string
  unit: string | null
  /**
   * A value that is not a number, when a numeral would be a claim nobody made.
   *
   * `ring` — nothing was recorded in this window. Deliberately not `0`: "nothing recorded" and
   * "nothing happened" are different statements, and the second is not one the panel can make.
   * `rule` — the thing happened and was never measured. Two pump sessions with no amount are not
   * zero ounces; the old app called them that, which is the bug this notation exists to refuse.
   */
  mark: 'ring' | 'rule' | null
  /** Nothing in the window — the row recedes rather than disappearing, so its absence is legible. */
  dim: boolean
}

/**
 * The types the TODAY page reports on, in the design's order.
 *
 * <b>Sleep is the sixth, and it is new.</b> The block used to be five rows tall and these were the
 * five. Widening it to six — so that SINCE's sixth row is not stranded below a fold that gives no
 * hint it is there — would have left TODAY a row short and looking clipped. Sleep is the row that
 * belongs in the gap rather than the one that fills it: SINCE already asks how long since the last
 * one, the grid logs it, and total sleep in a window is the figure a household with a twelve-week-
 * old actually counts.
 */
const TOTAL_TYPES: CareEntryTypeName[] = ['Bottle', 'Nursing', 'Pump', 'Diaper', 'Medicine', 'Sleep']

/** One line on the SINCE page: what it reports on, and what to call it. */
export interface SinceRowSpec {
  key: string
  type: CareEntryTypeName
  label: string
  /**
   * Diaper rows only — which half of a nappy this row is about.
   *
   * A `mixed` nappy satisfies both, because it contained both. Anything else would have a wet
   * nappy silently reset the how-long-since on a dirty one.
   */
  side?: 'pee' | 'poo'
}

/**
 * What SINCE reports on — the things with a rhythm somebody tracks.
 *
 * A fixed set rather than "the most recent five", which silently drops a whole type on a quiet day:
 * pump left the list as soon as five other kinds had been logged since the last session, which is
 * precisely when how-long-since is worth asking about it.
 *
 * <b>Wet and dirty are separate lines.</b> One `Diaper` row answers "when was the last change",
 * which is not a question anybody asks — the two have different rhythms and different reasons for
 * watching them, and a wet nappy an hour ago tells you nothing about how long it has been since a
 * dirty one. Six rows in a five-row window, so the last of them sits just below the fold.
 */
export const SINCE_ROWS: SinceRowSpec[] = [
  { key: 'bottle', type: 'Bottle', label: 'Bottle' },
  { key: 'nursing', type: 'Nursing', label: 'Breast feeding' },
  { key: 'pump', type: 'Pump', label: 'Pump' },
  { key: 'diaper-pee', type: 'Diaper', label: 'Diaper · pee', side: 'pee' },
  { key: 'diaper-poo', type: 'Diaper', label: 'Diaper · poo', side: 'poo' },
  { key: 'sleep', type: 'Sleep', label: 'Sleep' },
]

/** Whether an entry is the kind of thing this row reports on. */
export function matchesSince(spec: SinceRowSpec, entry: CareEntryDto): boolean {
  if (entry.type !== spec.type) return false
  if (!spec.side) return true
  return entry.kind === spec.side || entry.kind === 'both'
}

/**
 * The line under a SINCE row's name.
 *
 * The split diaper rows report **their own** size rather than the entry's: a mixed nappy carries a
 * figure for each half, and showing the poo's size on the wet row would be reporting the wrong
 * number with complete confidence.
 */
export function sinceDetail(spec: SinceRowSpec, entry: CareEntryDto): string {
  if (!spec.side) return detailLabel(entry)
  const size = spec.side === 'pee' ? entry.peeAmount : entry.pooAmount
  const mixed = entry.kind === 'both' ? ' · mixed' : ''
  return `${size ? `${capitalise(size)} ${spec.side}` : capitalise(spec.side)}${mixed}`
}

/**
 * The 6 AM–6 AM totals, one row per reported type.
 *
 * Every row is always present. A diaper row reading `0` beside `NONE IN THIS WINDOW` is the fact
 * somebody is looking for at 4am; a row that vanished when the count hit zero would leave them
 * counting the rows to work out which type was missing.
 */
export function windowTotals(entries: CareEntryDto[]): WindowTotal[] {
  return TOTAL_TYPES.map((type): WindowTotal => {
    const rows = entries.filter((e) => e.type === type)
    if (rows.length === 0) {
      // A ring, not a zero — see `WindowTotal.mark`.
      return { type, detail: 'None in this window', time: null, value: '', unit: null, mark: 'ring', dim: true }
    }

    // Newest first, so "last 8:33 PM" and "Pepcid · 9:47 AM" name the most recent one.
    const latest = [...rows].sort((a, b) => Date.parse(b.atUtc) - Date.parse(a.atUtc))[0]
    const count = rows.length

    switch (type) {
      case 'Bottle': {
        const ounces = rows.reduce((sum, e) => sum + (e.amount ?? 0), 0)
        return {
          type,
          detail: plural(count, 'bottle'),
          time: `Last ${clockLabel(new Date(latest.atUtc))}`,
          value: trim(ounces),
          unit: 'oz',
          mark: null,
          dim: false,
        }
      }

      case 'Nursing': {
        const minutes = rows.reduce((sum, e) => sum + (e.durationMinutes ?? 0), 0)
        const sides = [...new Set(rows.map((e) => e.side).filter(Boolean))].join(' · ')
        return {
          type,
          detail: [plural(count, 'session'), sides].filter(Boolean).join(' · '),
          // No time column: the design gives this row a count and a duration and nothing else, and
          // "last fed at" is the SINCE page's question rather than this one's.
          time: null,
          // `16` `M`, matching the elapsed figures and the entry rows. The design sets this as a
          // clock, but a block that writes a duration three different ways is a block somebody has
          // to decode rather than read.
          value: String(Math.round(minutes)),
          unit: 'M',
          mark: null,
          dim: false,
        }
      }

      case 'Pump': {
        const ounces = rows.reduce((sum, e) => sum + (e.amount ?? 0), 0)
        const unmeasured = rows.filter((e) => e.amount == null).length
        return {
          type,
          detail: [
            plural(count, 'session'),
            // Named, because a total that silently drops three sessions is one nobody can act on —
            // and the old app's answer was to count them as `0 oz`, which is worse.
            unmeasured > 0 ? `${unmeasured} with no amount` : null,
          ].filter(Boolean).join(' · '),
          time: null,
          value: ounces > 0 ? trim(ounces) : '',
          unit: ounces > 0 ? 'oz' : null,
          // Sessions happened and none was weighed: the rule, not a zero and not an em dash.
          mark: ounces > 0 ? null : 'rule',
          dim: false,
        }
      }

      case 'Medicine':
        return {
          type,
          detail: latest.kind ?? '',
          time: clockLabel(new Date(latest.atUtc)),
          value: String(count),
          // Lower case: `dose` is a word here, not an abbreviation like the `M` and `OZ` above it.
          unit: count === 1 ? 'dose' : 'doses',
          mark: null,
          dim: false,
        }

      /*
       * Minutes, the same as nursing — and deliberately not hours.
       *
       * `7H 20M` would be a fourth way of writing a duration on a block that has settled on one,
       * and the window this counts is not a day, so an hours figure invites being read as "slept
       * 7 of 24". The unit letter is the one the elapsed column and the entry rows already use.
       *
       * A session still running is not counted: it has no `durationMinutes` until it is completed,
       * which is the same reason the totals do not tick.
       */
      case 'Sleep': {
        const minutes = rows.reduce((sum, e) => sum + (e.durationMinutes ?? 0), 0)
        return {
          type,
          detail: plural(count, 'sleep'),
          time: `Last ${clockLabel(new Date(latest.atUtc))}`,
          value: String(Math.round(minutes)),
          unit: 'M',
          mark: null,
          dim: false,
        }
      }

      default:
        return {
          type,
          detail: detailLabel(latest),
          time: `Last ${clockLabel(new Date(latest.atUtc))}`,
          value: String(count),
          unit: null,
          mark: null,
          dim: false,
        }
    }
  })
}

/**
 * One entry's figure, split so the unit can be set small beside it.
 *
 * <b>The same shape `windowTotals` returns</b>, so the ENTRIES rows and the TODAY rows can be the
 * same row. They were not: entries carried a fixed time column and a 17px value while the totals
 * beside them put the name at the gutter under a 24px figure, and swiping between the two pages
 * moved every piece of text on the block.
 */
export function valueParts(entry: CareEntryDto): { value: string; unit: string | null } {
  if (entry.amount != null) return { value: trim(entry.amount), unit: entry.unit ?? null }
  // Minutes with an `M` beside them, the same unit letter the elapsed figures use — a colon clock
  // was a third way of writing a duration on a block that already had one.
  if (entry.durationMinutes != null) return { value: String(Math.round(entry.durationMinutes)), unit: 'M' }
  if (entry.pounds != null) return { value: `${trim(entry.pounds)} lb ${trim(entry.ounces ?? 0)}`, unit: 'oz' }
  return { value: '—', unit: null }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/**
 * What a tile says under its name, before anybody taps it.
 *
 * The design's point is that the default is visible in advance: the caption <i>is</i> the value the
 * sheet will open on. A type nobody has logged says so rather than showing a plausible zero.
 */
export function tileCaption(type: CareEntryTypeName, last: CareEntryDto | undefined): string {
  if (!last) return type === 'Solids' ? 'Not started' : 'No record'

  switch (type) {
    case 'Bottle':
      return `${trim(last.amount ?? 0)} ${last.unit ?? 'oz'}`
    case 'Nursing':
      // Nursing inverts deliberately — the side offered is the opposite of the last one.
      return `Timer · ${otherSide(last.side) ?? 'left'} next`
    case 'Pump':
      // The two phase lengths, not the word "timer": the pump panel opens on a stimulation and an
      // expression phase, and `5 + 20 MIN` is the thing somebody checks before starting one.
      return `${PUMP_PHASES[0]} + ${PUMP_PHASES[1]} min`
    case 'Diaper':
      return kindLabel(last.kind) ?? 'Logged'
    case 'Medicine': {
      // The dose *and* what it was. A bare `0.6 ml` on a tile beside four other medicines the
      // household gives is the number without the noun that makes it mean anything.
      const dose = last.amount != null ? `${trim(last.amount)} ${last.unit ?? 'ml'}` : null
      return [dose, last.kind].filter(Boolean).join(' ') || 'Logged'
    }
    // The caption *is* what the panel opens on, and for these the panel opens on a start button.
    // Reporting the last session's length instead would promise a stepper that is no longer the
    // first thing on the sheet.
    case 'Sleep':
    case 'TummyTime':
      return 'Timer'
    default:
      return last.durationMinutes != null ? `${trim(last.durationMinutes)} min` : 'Logged'
  }
}

/** The side a nursing sheet should offer next: the one that was not used last. */
export function otherSide(side: string | null | undefined): string | null {
  if (side === 'left') return 'right'
  if (side === 'right') return 'left'
  return null
}

/**
 * The review line above SAVE — the sentence that <i>is</i> the confirmation.
 *
 * <b>It names what is missing as well as what is set.</b> "no colour or consistency" is the design's
 * own wording, and the reason is that an unfilled optional field should be a visible choice rather
 * than a silent gap: somebody who meant to record a colour sees that they did not.
 */
export function reviewSentence(input: CareEntryInput, at: Date): string {
  const time = clockLabel(at)

  switch (input.type) {
    case 'Bottle': {
      const contents = input.kind ? ` of ${spell(input.kind)}` : ''
      /*
       * The sentence names both ends when they differ.
       *
       * What is written is what was *taken* — the panel does the subtraction — so a line that said
       * only "writes 3 oz" would leave somebody who dialled 4 offered wondering which of the two
       * numbers had been recorded. When the bottle went back empty there is nothing to reconcile
       * and the sentence reads exactly as it did before.
       */
      const from = input.offered != null && input.offered !== input.amount
        ? `, from ${trim(input.offered)} offered`
        : ''
      return `Writes ${trim(input.amount ?? 0)} ${input.unit ?? 'oz'}${contents} at ${time}${from}.`
    }

    case 'Diaper': {
      const amount = input.pooAmount ?? input.peeAmount
      const kind = input.kind ?? 'change'
      const missing = omissions(input)
      const tail = missing ? `, ${missing}` : ''
      return `Writes a ${amount ? `${amount} ` : ''}${kind} at ${time}${tail}.`
    }

    case 'Nursing': {
      const side = input.side ? ` on the ${input.side}` : ''
      return `Writes ${trim(input.durationMinutes ?? 0)} minutes${side}, starting ${time}.`
    }

    /*
     * The typed route, named as such.
     *
     * <b>The sentence says which of the panel's two routes SAVE belongs to.</b> A pump panel offers
     * START SESSION and SAVE at once, and they are not rivals: starting runs a session whose amount
     * is asked for at the end, while SAVE writes a session that is already over and whose amount is
     * therefore in hand. Naming the route is what keeps the two apart at a glance.
     *
     * Kept to one line — the handoff sets `white-space:nowrap` on it — so the phrasing stays short
     * rather than wrapping above SAVE.
     */
    case 'Pump': {
      const amount = input.amount == null ? 'no amount' : `${trim(input.amount)} ${input.unit ?? 'oz'}`
      return input.durationMinutes == null
        ? `Writes a session with ${amount} at ${time}.`
        : `Writes the typed session: ${trim(input.durationMinutes)} min, ${amount}, from ${time}.`
    }

    case 'Medicine': {
      const name = input.kind ? ` of ${input.kind}` : ''
      return input.amount == null
        ? `Writes a dose${name} at ${time}.`
        : `Writes ${trim(input.amount)} ${input.unit ?? 'ml'}${name} at ${time}.`
    }

    case 'Temperature':
      return input.amount == null
        ? `Writes a temperature reading at ${time}.`
        : `Writes ${trim(input.amount)}°${(input.unit ?? 'f').toUpperCase()} at ${time}.`

    case 'Sleep':
    case 'TummyTime':
      return input.durationMinutes == null
        ? `Writes ${CARE_LABELS[input.type].toLowerCase()} at ${time}.`
        : `Writes ${trim(input.durationMinutes)} minutes of ${CARE_LABELS[input.type].toLowerCase()} at ${time}.`

    case 'Solids':
      return input.kind
        ? `Writes ${input.kind} at ${time}.`
        : `Writes solids at ${time}.`

    case 'Bath':
      return `Writes a bath at ${time}.`

    default:
      return `Writes ${CARE_LABELS[input.type].toLowerCase()} at ${time}.`
  }
}

/** "no colour or consistency" — the optional diaper fields nobody filled. */
function omissions(input: CareEntryInput): string | null {
  const missing: string[] = []
  if (!input.color) missing.push('colour')
  if (!input.consistency) missing.push('consistency')
  if (missing.length === 0) return null
  return `no ${missing.join(' or ')}`
}

/**
 * `9:09 PM` — the way the review line and the log say a time.
 *
 * Re-exported rather than reimplemented: this was its own copy of the arithmetic, written before
 * there was one place for it, and two copies of "what hour is it really" is two places for midnight
 * to be wrong in. Kept under this name because Care's callers read as Care's own vocabulary — and
 * imported as well as re-exported, since half this file says a time itself.
 */
export { clockLabel }

/**
 * `breast_milk` → `breast milk`, for a sentence rather than a wire value.
 *
 * Deferred to {@link kindLabel} rather than stripping underscores itself. This was the third copy
 * of that mapping in the log — the row, the chip and this sentence — and the review line is the one
 * place the household is asked to confirm what is about to be written: a bottle whose chip reads
 * BREAST / FORMULA and whose review reads "breast formula" is asking them to agree to something
 * they were not shown.
 */
function spell(kind: string): string {
  return (kindLabel(kind) ?? kind).toLowerCase()
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/** `3.50` → `3.5`, `4.0` → `4`. A trailing zero on a feed amount reads as false precision. */
function trim(value: number): string {
  return Number(value.toFixed(2)).toString()
}
