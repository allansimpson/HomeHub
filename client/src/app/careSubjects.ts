import { useBaby } from './BabyProvider'
import { useLitter } from './LitterProvider'
import { useCatName } from './catName'
import { useBabyName } from './babyName'
import { useNow } from './useNow'
import type { LitterRobotDto } from '../api/types'

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

/*
 * `ageLabel` — `12 weeks` / `9 days`, the metadata beside Conrad's name — was removed with the
 * Huckleberry integration on 2026-08-30. Its only input was that service's child record, and with
 * no birthday held locally it had no argument to be called with. `design_handoff_baby` asks for
 * `16 WEEKS` back in the header; that needs a household birthday setting first, and the function is
 * eight lines to write again once there is one.
 */

/**
 * Conrad's sync line — one state, because there is no longer a service to be out of sync with.
 *
 * <b>This had five states and every one of them described the Huckleberry integration.</b> Two of
 * them (`HomeAssistantUnreachable`, `IntegrationMissing`) were read as hard faults, and once that
 * integration was retired the second became permanently true: `needsYou` promoted it to the
 * dashboard's strongest row and told the household to `GO AND LOOK` at a system nobody was going to
 * put back. The log is HomeHub's own now — it has no upstream, so it has no sync, and the honest
 * line is that it is the panel's own record.
 *
 * Kept as a function rather than inlined because `mikaSync` beside it is a real one: the robot does
 * have an upstream, and the two subjects have to produce the same shape.
 */
export function conradSync(): CareSyncLine {
  /*
   * No right-hand meta, because Conrad no longer draws a sync line at all.
   *
   * It was the clock — before that, `8 feeds · 23 diapers`. Both are gone with the row: the Baby
   * tab dates its own header, and a freshness stamp over a log that is written here was a claim
   * about the wrong thing (see `CareScreen`).
   */
  return { text: 'Logged here', tone: 'muted', meta: '' }
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
  const { loading: babyLoading } = useBaby()
  const { health: catHealth, robots, loading: catLoading } = useLitter()
  const cat = useCatName()
  const babyName = useBabyName()
  const now = useNow(30_000)

  const robot = robots[0] ?? null
  const catConnected = catHealth?.configured !== false

  const mikaFaulted = robot?.faultClass === 'NeedsHuman'

  const subjects: CareSubject[] = [
    {
      id: 'conrad',
      // The household's word for the child, and now the only source of it — see `useBabyName`.
      name: babyName ?? 'Baby',
      /*
       * No age.
       *
       * `16 WEEKS` came off the integration's child record, which is gone, and nothing local holds
       * a birthday. It had already been blank for as long as that integration was returning
       * nothing, so this is writing down what the screen was doing rather than changing it. The
       * design asks for the age back; that needs a household birthday setting, which does not exist.
       */
      meta: '',
      /*
       * Conrad cannot fault. There is no upstream to lose — the log is written here, and a panel
       * that cannot reach its own server is already saying so through `ConnectionProvider`. Mika
       * still can, because a litter robot is a real device that really jams.
       */
      faulted: false,
      configured: true,
      sync: conradSync(),
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
