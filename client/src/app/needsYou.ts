import { useCareSubjects } from './careSubjects'
import { useSensors } from './SensorsProvider'
import { useTasks } from './TasksProvider'
import { usePantry } from './PantryProvider'
import { useNow } from './useNow'
import { todayKey } from './mealsDomain'

/**
 * NEEDS YOU — every exception in the house, on one list.
 *
 * The Dashboard's top block, and the reason the rework has one: a Care fault, an overdue task and an
 * empty pantry jar are the same *kind* of thing, and the panel used to surface each one somewhere
 * different or not at all. The section tag in the left margin is what lets them sit side by side
 * without becoming a soup.
 *
 * This block replaces the `AlertBanner` premise. `DashboardScreen` used to carry a long note about
 * `topAlert` having been narrowed to severe-only on the assumption that everything else "arrives as
 * a notification" — an assumption that was never true, since nothing converts sensor, climate or
 * weather alerts into notifications, and four of five seeded thresholds raise at *warning*. That
 * gap is what this closes: a warning-severity alert is now an amber row here. `AlertBanner` stays
 * for `Severe` only, which is what its hazard stripe was always for.
 *
 * **Known gap** (OPEN_QUESTIONS.md §5): this reads the alert providers directly, which works, but
 * the `＋ N more ▸` link goes to the notification inbox, and sensor/climate/weather alerts never
 * reach it. Until an alert→notification bridge exists the link is honest only about the Care rows.
 */
export type NeedsTone = 'bad' | 'warn'

export interface NeedsRow {
  key: string
  /** The section this belongs to, in the left margin: `CARE`, `TODO`, `MEALS`, `HOUSE`, `WEATHER`. */
  tag: string
  tone: NeedsTone
  /** The problem, in plain language. Never a code, never a metric name. */
  problem: string
  /** An age or an action, hard right, in the tone colour. */
  right: string
  /** Where tapping the row goes. */
  target: string
  /** For ordering within a tone — older first, because it has been waiting longer. */
  since: number
}

/** Whole-day difference from today (negative = past). */
function daysFromToday(d: Date, now: number): number {
  const today = new Date(now)
  return Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
      - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000,
  )
}

/** `2 DAYS` / `6 HOURS` / `40 MIN` — the age in the row's right column. */
function ageLabel(fromMs: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - fromMs) / 60_000))
  if (minutes < 60) return `${minutes} MIN`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} HOUR${hours === 1 ? '' : 'S'}`
  const days = Math.round(hours / 24)
  return `${days} DAY${days === 1 ? '' : 'S'}`
}

/**
 * Every exception, worst first and oldest first within that.
 *
 * Order is severity then age, deliberately and not by section: the block answers "what needs me",
 * and a freezer warming up does not wait behind a to-do because tasks happen to sort earlier.
 */
export function useNeedsYou(): NeedsRow[] {
  const { subjects } = useCareSubjects()
  const { alerts } = useSensors()
  const { tasks } = useTasks()
  const { pantry, grocery } = usePantry()
  const now = useNow(60_000)

  const rows: NeedsRow[] = []

  // ---- Care. A hard fault is the strongest thing this house says. ----
  for (const s of subjects) {
    if (!s.faulted) continue
    rows.push({
      key: `care:${s.id}`,
      tag: 'CARE',
      tone: 'bad',
      problem: `${s.name} — ${s.sync.text.toLowerCase()}`,
      right: 'GO AND LOOK',
      target: `/care?subject=${s.id}`,
      since: 0, // no start time upstream; a fault sorts to the top of its tone regardless
    })
  }

  // ---- Overdue tasks. Overdue is terracotta; due today is not an exception yet. ----
  for (const t of tasks) {
    if (t.completed || !t.dueUtc) continue
    const due = new Date(t.dueUtc)
    const days = daysFromToday(due, now)
    if (days >= 0) continue
    rows.push({
      key: `task:${t.id}`,
      tag: 'TODO',
      tone: 'bad',
      problem: t.title,
      right: `${-days} DAY${days === -1 ? '' : 'S'} LATE`,
      target: '/todo',
      since: due.getTime(),
    })
  }

  // ---- Sensor, climate and weather alerts, from the shared feed. ----
  for (const a of alerts) {
    rows.push({
      key: `alert:${a.id}`,
      tag: a.type === 'weather' ? 'WEATHER' : a.type === 'climate' ? 'CLIMATE' : 'HOUSE',
      // Severe is terracotta; everything else is amber. This is the narrowing the old banner did
      // — except here the amber ones are still on the screen instead of nowhere.
      tone: a.severity === 'Severe' ? 'bad' : 'warn',
      problem: a.message,
      right: ageLabel(new Date(a.startedAtUtc).getTime(), now),
      target: alertTarget(a.source),
      since: new Date(a.startedAtUtc).getTime(),
    })
  }

  /*
   * ---- What tonight's meal needs and the pantry hasn't got. ----
   *
   * Read off the grocery list rather than joined here from recipes and shelves: a line dated for
   * today *is* the answer to "what does tonight need that we're out of", it is already computed
   * server-side by the coupling between `DeductionScreen` and `StockCheckScreen`, and re-deriving
   * it on the Dashboard would give the panel two ways to answer one question.
   */
  const today = todayKey()
  for (const line of grocery?.lines ?? []) {
    if (line.checkedAtUtc) continue
    const forTonight = line.provenance.some((p) => p.forDate === today)
    if (!forTonight) continue
    rows.push({
      key: `grocery:${line.id}`,
      tag: 'MEALS',
      tone: 'warn',
      problem: `Tonight needs ${line.text.toLowerCase()}`,
      right: 'NOT GOT',
      target: '/meals/pantry/grocery',
      since: now,
    })
  }

  // The shelves in general, once — not one row per jar, which would fill the block with the least
  // urgent thing in the house.
  const out = pantry?.probablyOut ?? 0
  if (out > 0) {
    rows.push({
      key: 'pantry:out',
      tag: 'MEALS',
      tone: 'warn',
      problem: `${out} thing${out === 1 ? '' : 's'} probably out of the pantry`,
      right: 'CHECK',
      target: '/meals/pantry',
      since: now,
    })
  }

  return rows.sort((a, b) => (a.tone === b.tone ? a.since - b.since : a.tone === 'bad' ? -1 : 1))
}

/**
 * Route an alert source ("sensor:3", "weather", "cat:litter_robot_4") to its screen.
 *
 * `cat:` lands on Mika inside Care. It used to fall through to the trailing `/sensor` default, so
 * tapping a Litter-Robot alert opened the sensor history — a screen with nothing on it about the
 * robot that raised the alert.
 */
export function alertTarget(source: string): string {
  const [kind, id] = source.split(':')
  if (kind === 'weather') return '/weather'
  if (kind === 'cat') return '/care?subject=mika'
  if (kind === 'baby') return '/care?subject=conrad'
  return kind === 'sensor' && id ? `/sensor?zone=${id}` : '/sensor'
}
