import { useBaby } from './BabyProvider'
import { useLitter } from './LitterProvider'
import { useCatName } from './catName'
import { useBabyName } from './babyName'
import { useNow } from './useNow'
import type { BabyHealthDto, BabyStateDto, LitterRobotDto } from '../api/types'

/**
 * The Care section's subjects, as one list.
 *
 * Baby and Litter used to be two tabs with two providers and no shared vocabulary. `/care` needs a
 * third thing neither of them had: an answer to "who is in trouble" that both the switcher and the
 * bottom-nav badge can read without either screen being mounted. That is all this module is — a
 * projection over `BabyProvider` and `LitterProvider`, holding no state of its own.
 *
 * The rule the section is built on: **a hard fault badges its own mark *and* drops a row in the
 * notification drawer.** Both, always, and nothing is suppressed overnight — a full drawer at 3am
 * is still worth knowing (IA.md).
 */
export type CareSubjectId = 'conrad' | 'mika'

export type CareTone = 'live' | 'warn' | 'bad' | 'muted'

export interface CareSyncLine {
  text: string
  tone: CareTone
  /** Right-hand meta on the sync line — the age, the box, whatever the subject wants said. */
  meta: string
}

export interface CareSubject {
  id: CareSubjectId
  /** The name on the switcher when this subject is active. */
  name: string
  /** The metadata beside the active name — `12 WEEKS`, `LITTER-ROBOT 4`. */
  meta: string
  /**
   * A hard fault: something is wrong that will not clear itself.
   *
   * Deliberately narrow. Conrad's two unreachable-integration states and Mika's `NeedsHuman` class
   * qualify; a robot the panel is still retrying (`Recoverable`) does not, because the badge is a
   * claim that a person has to walk over, and the recovery loop has not finished saying otherwise.
   */
  faulted: boolean
  /** False when the upstream integration is not set up at all — which is not a fault. */
  configured: boolean
  sync: CareSyncLine
}

export interface CareSubjects {
  subjects: CareSubject[]
  /** Any subject in a hard fault — what the CARE tab's badge reads. */
  anyFault: boolean
  /**
   * Both providers have finished their first read.
   *
   * `/care` waits for this before latching which subject to open on. Without it the screen would
   * open on Conrad — nothing has reported a fault yet — and then swap to Mika a second later,
   * yanking the view out from under whoever was already holding a tile.
   */
  resolved: boolean
  /**
   * Which subject `/care` should open on with no `?subject=`.
   *
   * A hard fault wins; otherwise Conrad. Recency deliberately does not decide — "most recently
   * active" was considered and rejected, because a quiet day should always open the same way.
   */
  defaultSubject: CareSubjectId
}

/** Coarse elapsed label — `40 s ago`, `12 min ago`, `3 h ago`, `2 d ago`. */
function since(iso: string | null | undefined, now: number): string {
  if (!iso) return 'never'
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`
}

/** `12 weeks` / `9 days` — the metadata beside Conrad's name. */
export function ageLabel(birthday: string | null | undefined, now: number): string | null {
  if (!birthday) return null
  const days = Math.floor((now - new Date(`${birthday}T00:00:00`).getTime()) / 86_400_000)
  if (days < 0) return null
  if (days < 14) return `${days} day${days === 1 ? '' : 's'}`
  const weeks = Math.floor(days / 7)
  return `${weeks} week${weeks === 1 ? '' : 's'}`
}

/**
 * Conrad's sync line. Five states, deliberately distinguishable: "HA is down" and "the integration
 * isn't there" need different fixes, and `NotConfigured` is not an error. Lifted verbatim from the
 * screen that used to own it — the wording is the contract with whoever has to fix it.
 */
export function conradSync(
  health: BabyHealthDto | null,
  state: BabyStateDto | null,
  now: number,
): CareSyncLine {
  /*
   * No right-hand meta, because Conrad no longer draws a sync line at all.
   *
   * It was the clock — before that, `8 feeds · 23 diapers`. Both are gone with the row: the Baby
   * tab dates its own header, and a freshness stamp for the Huckleberry integration sitting over a
   * log that does not read from it was a claim about the wrong thing (see `CareScreen`).
   *
   * The text survives because `needsYou` still reads it: on a *hard* fault the dashboard says
   * `Conrad — home assistant unreachable` in these words. That is the one place the household is
   * told, so the wording is still the contract with whoever has to go and fix it.
   */
  const line = (text: string, tone: CareTone): CareSyncLine => ({ text, tone, meta: '' })
  // No product name in this line. Care does not name the integration anywhere now — the pull that
  // used to sit in the log's footer is in Config → Baby settings — and the wording here has to
  // survive the day that integration is switched off regardless.
  if (!health) return line('Reading…', 'muted')
  switch (health.status) {
    case 'NotConfigured':
      return line('Not connected', 'muted')
    case 'Ok':
      return line(`Updated ${since(state?.fetchedUtc ?? null, now)}`, 'live')
    case 'HomeAssistantUnreachable':
      return line('Home Assistant unreachable', 'bad')
    case 'IntegrationMissing':
      return line('Integration not found', 'bad')
    case 'Stale':
      return line(`Showing last known · ${since(state?.fetchedUtc ?? null, now)}`, 'warn')
  }
}

/**
 * Mika's sync line comes from her status code rather than from a health enum, because the robot's
 * class *is* the headline: `NEEDS A HUMAN · READ 20 S AGO`. A faulted robot reads terracotta.
 *
 * The right-hand meta names the box, which is the one thing the line does not otherwise say — and
 * `usable` is worth more than the model when the answer is no, because "the cat cannot use it" is
 * the fact a passer-by needs.
 */
export function mikaSync(robot: LitterRobotDto | null, now: number, connected: boolean): CareSyncLine {
  if (!connected) return { text: 'Not connected', tone: 'muted', meta: '' }
  if (!robot) return { text: 'Reading Home Assistant…', tone: 'muted', meta: '' }
  const read = `read ${since(robot.fetchedUtc, now)}`
  const meta = robot.usable ? (robot.model ?? '') : 'Out of use'
  switch (robot.faultClass) {
    case 'NeedsHuman':
      return { text: `Needs a human · ${read}`, tone: 'bad', meta }
    case 'Recoverable':
      return { text: `Recovering · ${read}`, tone: 'warn', meta }
    case 'Transient':
      return { text: `Cycle running · ${read}`, tone: 'warn', meta }
    case 'CatPresent':
      return { text: `In use · ${read}`, tone: 'live', meta }
    case 'Offline':
    case 'Unknown':
      return { text: `No reading since ${since(robot.lastSeenUtc, now)}`, tone: 'muted', meta }
    default:
      return { text: `Stable · ${read}`, tone: 'live', meta }
  }
}

/**
 * The section's subjects, in switcher order.
 *
 * Two today. A third would be another entry here and another *mark* on the switcher — never a second
 * name on the line. That rule has not been drawn past two (OPEN_QUESTIONS.md §2), so keep the order
 * stable rather than sorting by state.
 */
export function useCareSubjects(): CareSubjects {
  const { health: babyHealth, child, state, loading: babyLoading } = useBaby()
  const { health: catHealth, robots, loading: catLoading } = useLitter()
  const cat = useCatName()
  const babyName = useBabyName()
  const now = useNow(30_000)

  const robot = robots[0] ?? null
  const catConnected = catHealth?.configured !== false

  const conradFaulted = babyHealth?.status === 'HomeAssistantUnreachable'
    || babyHealth?.status === 'IntegrationMissing'
  const mikaFaulted = robot?.faultClass === 'NeedsHuman'

  const subjects: CareSubject[] = [
    {
      id: 'conrad',
      // The household's name first. The integration's is a fallback, not the source — see
      // `useBabyName` for why a name that disappears when a service is unreachable is worse than
      // no name at all.
      name: babyName ?? child?.name ?? 'Baby',
      meta: ageLabel(child?.birthday, now) ?? '',
      faulted: conradFaulted,
      configured: babyHealth?.configured !== false,
      sync: conradSync(babyHealth, state, now),
    },
    {
      id: 'mika',
      // The household's word for her, set in Config → Devices → Litter settings. The robot's own
      // name is deliberately never consulted: the panel's name is the panel's, and a name guessed
      // from an appliance is not the household's word for anything.
      name: cat.name || 'Cat',
      meta: robot?.model ?? cat.box ?? '',
      faulted: Boolean(mikaFaulted),
      configured: catConnected,
      sync: mikaSync(robot, now, catConnected),
    },
  ]

  const faulted = subjects.find((s) => s.faulted)
  return {
    subjects,
    anyFault: Boolean(faulted),
    resolved: !babyLoading && !catLoading,
    defaultSubject: faulted?.id ?? 'conrad',
  }
}
