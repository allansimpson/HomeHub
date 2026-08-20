import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { EmptyState, HoldButton, LedgerRow, SectionLabel } from '../../components'
import { Icon } from '../../icons/Icon'
import { useLitter } from '../../app/LitterProvider'
import { useNow } from '../../app/useNow'
import { useCatName, type CatNaming } from '../../app/catName'
import { api, ApiError } from '../../api/client'
import { clockLabel } from '../../app/dates'
import { dayLabel, entriesLabel } from '../../app/care'
import type {
  CatHealthDto, LitterEventDto, LitterFaultClassName, LitterRobotDto, RecoveryAttemptDto,
} from '../../api/types'

// ---------------------------------------------------------------------------
// Time.
//
// Twelve-hour absolute clock times for anything the robot did or reported —
// requested-at, reading-taken-at, faulted-at, log rows. Relative durations are
// reserved for two slots: the freshness line, and the column where the elapsed
// time *is* the fact (SINCE on Cat Present, LAST GOOD on Offline).
//
// Every timestamp on the screen comes from one snapshot and they must agree: a
// screen saying the robot was last seen a day ago while its gauges were read at
// 12:30 PM today is contradicting itself out loud.
//
// Two clocks run here and must not be confused for one another. HomeHub polls
// Home Assistant every 10 s — that is the freshness line, and it is the only
// thing entitled to claim it is live. The robot reports through Whisker's cloud
// only when something happens, hours apart — that is `lastSeenUtc`, and it
// belongs in slots that show a time without asserting a condition. Reporting the
// second on the first one's terms is what put a healthy box in amber all day.
// ---------------------------------------------------------------------------

function since(iso: string | null | undefined, now: number): string {
  if (!iso) return 'never'
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`
}

/** MM:SS down to a deadline; null once it has passed. */
function countdown(iso: string | null, now: number): string | null {
  if (!iso) return null
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000)
  if (seconds <= 0) return null
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}

// The panel's own way of saying a time, not the device's: `toLocaleTimeString` follows the
// browser locale, so the same reading rendered `18:32` on a phone set to en-GB and `6:32 PM`
// on the wall panel beside it. Nothing here is 24-hour (`dates.clockLabel`).
function clock(iso: string | null | undefined): string {
  return iso ? clockLabel(new Date(iso)) : '—'
}

/**
 * Past this, the robot's silence is worth remarking on.
 *
 * Deliberately hours, not minutes. The poll is every 10 s, but the robot is *not* polled — Whisker
 * pushes to HA when something happens, so a healthy box with a sleeping cat reports twice in a
 * morning and nothing for hours between. Measured gaps on this unit run past four hours in normal
 * use. A threshold near the poll interval would mean the screen spent most of the day warning about
 * a robot that was working perfectly, which is how a warning colour stops being read at all.
 *
 * Twelve hours is longer than any legitimate gap observed and still less than half a day of genuine
 * silence. A robot that is actually unreachable does not rely on this: it reports `offline` and
 * lands in the Offline fault class, which the screen renders on its own terms.
 */
const QUIET_MS = 12 * 60 * 60 * 1000

function isQuiet(iso: string | null | undefined, now: number): boolean {
  // No timestamp at all is not evidence of silence — it means this integration stamps no entity we
  // can read. Calling that "quiet" would invent a fault out of a missing field.
  return !!iso && now - new Date(iso).getTime() > QUIET_MS
}

// ---------------------------------------------------------------------------
// Per-class presentation. One table rather than six branches scattered through
// the markup: what changes between renderings is the tone, one plain sentence,
// and how the right-hand time is labelled.
// ---------------------------------------------------------------------------

type Tone = 'live' | 'warn' | 'bad' | 'muted'

interface ClassPresentation {
  tone: Tone
  /** How the class reads in the status line — the enum name is not English. */
  name: string
  /** The plain line under the status, after `code · CLASS ·`. */
  meaning: string
  /** What the right-hand time in the status band is measuring. */
  timeLabel: string
}

const PRESENTATION: Record<LitterFaultClassName, ClassPresentation> = {
  Stable: { tone: 'live', name: 'Stable', meaning: 'nothing to do', timeLabel: 'Reading taken' },
  // The plain line explains the code; the instruction lives in DO NOT INTERVENE on the progress band,
  // so this must not repeat it.
  Transient: { tone: 'warn', name: 'Transient', meaning: 'mid-motion', timeLabel: 'Requested' },
  // A cat in the box is a good thing happening, not an error — verdigris, like every other live state.
  CatPresent: { tone: 'live', name: 'Cat present', meaning: 'the box is in use', timeLabel: 'Since' },
  Recoverable: { tone: 'warn', name: 'Recoverable', meaning: 'the panel is retrying', timeLabel: 'Faulted' },
  NeedsHuman: { tone: 'bad', name: 'Needs a human', meaning: 'retrying will not help', timeLabel: 'Faulted' },
  // Ghost grey, not terracotta: the terracotta on this rendering belongs to the freshness line. An
  // unreachable box is an absence of news, and the status word should not shout it.
  Offline: { tone: 'muted', name: 'Offline', meaning: 'no command will land', timeLabel: 'Last good' },
  Unknown: { tone: 'muted', name: 'Unknown', meaning: 'unrecognised — reporting only', timeLabel: 'Last good' },
}

/**
 * Mika — status first.
 *
 * One view that changes shape with `faultClass`. Six renderings, not six routes: the gauges and the
 * frame are identical in all of them; what changes is what owns the top of the view, whether the
 * clean-cycle control is offered, blocked or absent, and what fills the band below it.
 *
 * **The fault owns the top of the view when there is one** — code, plain-language state, how long
 * and how many attempts (CARE.md). Everything else keeps the order it has always had: status ·
 * contextual · gauges · your call · today · trailing · footer. The command block belongs above the
 * fold, which is why the cycling sequence sits *below* it rather than folded into the progress band.
 *
 * Three rules run through the whole thing:
 *
 * - **Never draw a control the panel cannot deliver.** Not greyed, not "coming soon" — absent. On
 *   this hardware `vacuum.start` is the only cycle command, so there is one clean-cycle control and
 *   no grid of tiles. A command that *is* deliverable but refused right now is different: it stays,
 *   in ghost grey, and says *why* in its meta. Never just grey it out.
 * - **Never draw a number the panel cannot source.** No derived stand-ins and no averages computed
 *   from status history. A value HA does not publish renders `—`.
 * - **Unknown is a first-class state and never renders as 0%.** A null gauge is hatched and reads
 *   `—`, with the reason beside it.
 *
 * Rendered inside `CareScreen`'s frame — no shell, no header, no sync line of its own. The sync line
 * that used to live here (the HomeHub↔HA freshness claim) is now `mikaSync` in `careSubjects.ts`,
 * where the switcher can read it without this view being mounted.
 */
export function MikaView() {
  const { health, robots, loading, pending, error, clearError } = useLitter()
  const navigate = useNavigate()
  const now = useNow(1000)
  const cat = useCatName()

  const robot = robots[0] ?? null

  if (!loading && health && !health.configured) {
    return (
      <EmptyState
        label="Not connected"
        hint="The litter box reaches the panel through Home Assistant, which owns the Whisker integration. Connect it in Config → Devices."
      />
    )
  }

  if (!loading && !robot) {
    return <EmptyState label="No litter box found" hint={health?.detail ?? undefined} />
  }

  if (!robot) return <div />

  const view = PRESENTATION[robot.faultClass]
  // Offline and Unknown mean the numbers are not merely old, they are unrelated to now.
  const dark = robot.faultClass === 'Offline' || robot.faultClass === 'Unknown'
  // The robot's silence, which is a different question from whether HomeHub can reach HA — the
  // sync line above answers that one.
  const quiet = isQuiet(robot.lastSeenUtc, now)
  const faulted = robot.faultClass === 'NeedsHuman'

  return (
    <>
      {error && (
        <div className="ml-baby__error" role="alert">
          <span className="ml-baby__errortext">{error}</span>
          <button type="button" className="ml-linkbtn" onClick={clearError}>Dismiss</button>
        </div>
      )}

      {/* The fault replaces the status band rather than sitting above it: two blocks both answering
          "what is going on" is how a screen ends up saying it twice in different words. */}
      {faulted ? (
        <FaultBanner robot={robot} now={now} />
      ) : (
        <div className={`ml-litter__status ml-litter__status--${view.tone}`}>
          <div className="ml-litter__statusmain">
            <div className="ml-litter__eyebrow">Status</div>
            {/* pylitterbot's own text, verbatim — the household reads the same words in the
                Whisker app when they are standing at the box. */}
            <div className="ml-litter__statustext serif">{robot.statusText}</div>
            <div className="ml-litter__statusclass">
              {dark
                // Nothing arrived, so there is no code to explain — the useful fact is when the
                // last thing did.
                ? `No reading since ${clock(robot.lastSeenUtc)}`
                : `${robot.statusCode} · ${view.name} · ${view.meaning}`}
            </div>
          </div>
          <div className="ml-litter__statustime">
            <div className="ml-litter__eyebrow">{view.timeLabel}</div>
            <div className="ml-litter__statusago serif">
              <StatusTime robot={robot} now={now} quiet={quiet} />
            </div>
          </div>
        </div>
      )}

      <ContextualBand robot={robot} now={now} cat={cat} />

      <Gauges robot={robot} dark={dark} />

      <ActionBand robot={robot} pending={pending} />

      {/* Below the command block, deliberately: the progress band answers *how far*, this answers
          *doing what*, and the readings people actually came for sit between them. */}
      {robot.faultClass === 'Transient' && <Sequence robot={robot} now={now} />}

      <Today robot={robot} cat={cat} />

      <TrailingBand robot={robot} now={now} health={health} cat={cat} quiet={quiet} />

      <div className="ml-care__footer">
        {/* The state's one sentence, where it has one. Stable — the common case — has none by
            design, and the footer is then just the history link. */}
        <span className="ml-care__footnote">{FOOTER_NOTES[robot.faultClass]}</span>
        <button type="button" className="ml-care__footlink" onClick={() => navigate('/devices/litter/history')}>
          History ▸
        </button>
      </div>
    </>
  )
}

/**
 * The fault, owning the top of the view: the two-letter code at 38px, the plain-language state, and
 * how long plus how many attempts.
 *
 * Every part is driven by the real status code — `statusCode` and pylitterbot's own `statusText`,
 * with the timings out of the recovery state. Nothing here re-derives the 25 codes; the classes and
 * the recovery loop already did that upstream.
 */
function FaultBanner({ robot, now }: { robot: LitterRobotDto; now: number }) {
  const { recovery } = robot
  const attempts = recovery.attemptsThisEpisode
  const meta = [
    recovery.faultSinceUtc ? `Since ${clock(recovery.faultSinceUtc)}` : `Faulted ${since(robot.statusSinceUtc, now)}`,
    attempts > 0 ? `${attempts} attempt${attempts === 1 ? '' : 's'}` : 'Not recoverable — no attempts made',
  ].join(' · ')

  return (
    <div className="ml-fault" role="status">
      <span className="ml-fault__code serif">{robot.statusCode.toUpperCase()}</span>
      <span className="ml-fault__main">
        <span className="ml-fault__title">{robot.statusText}</span>
        <span className="ml-fault__meta">{meta}</span>
      </span>
    </div>
  )
}

/**
 * TODAY — the two figures that answer "has it been working". Lifted out of the gauge block, where
 * they used to sit as unlabelled ledger rows under the bars.
 */
function Today({ robot, cat }: { robot: LitterRobotDto; cat: CatNaming }) {
  // Mid-cycle the count is the one number that would visibly disagree with itself, so it goes rather
  // than being shown against a globe that is still turning.
  const cycling = robot.faultClass === 'Transient'
  return (
    <>
      <SectionLabel label="Today" />
      {!cycling && (
        <LedgerRow
          title="Cycles"
          sub={robot.totalCycles == null ? 'Since the robot was new' : `Last complete ${clock(robot.lastSeenUtc)}`}
          right={
            <span className={'ml-care__value serif' + (robot.totalCycles == null ? ' ml-care__value--none' : '')}>
              {robot.totalCycles == null ? '—' : robot.totalCycles.toLocaleString()}
            </span>
          }
        />
      )}
      <LedgerRow
        title={cat.name ? `${cat.possessive} weight` : 'Pet weight'}
        // A *sampling* note, not an identity one: the scale weighs whoever is in the box, and the
        // figure is a single reading rather than an average.
        sub="One reading per visit"
        right={
          <span className={'ml-care__value serif' + (robot.petWeightLbs == null ? ' ml-care__value--none' : '')}>
            {robot.petWeightLbs == null
              ? '—'
              : <>{robot.petWeightLbs.toFixed(1)}<span className="ml-care__unit">lb</span></>}
          </span>
        }
      />
    </>
  )
}

/**
 * The right-hand time in the status band — labelled by what it measures, so the number needs no unit.
 *
 * Absolute for anything the robot did at a moment (requested, faulted, read). Relative only where the
 * elapsed time is itself the fact: how long the cat has been in the box, how long since the last good
 * reading, and — when the feed has gone quiet — how old the reading on screen is.
 */
function StatusTime({ robot, now, quiet }: { robot: LitterRobotDto; now: number; quiet: boolean }) {
  switch (robot.faultClass) {
    case 'Transient':
      return <>{clock(robot.statusSinceUtc ?? robot.fetchedUtc)}</>
    case 'CatPresent':
      return <>{since(robot.statusSinceUtc ?? robot.fetchedUtc, now)}</>
    case 'Recoverable':
    case 'NeedsHuman':
      return <>{clock(robot.recovery.faultSinceUtc)}</>
    case 'Offline':
    case 'Unknown':
      return <>{since(robot.lastSeenUtc, now)}</>
    default:
      // Stable: when the *robot* reported, not when we last polled. `fetchedUtc` under a "Reading
      // taken" label was the same conflation the freshness line used to make — it dated a two-hour-old
      // reading to the second the poll happened to run. Falls back to the poll only when the
      // integration stamps nothing we can read. Relative once the robot has gone quiet, where the age
      // is the fact rather than the moment.
      return <>{quiet ? since(robot.lastSeenUtc, now) : clock(robot.lastSeenUtc ?? robot.fetchedUtc)}</>
  }
}

/**
 * One sentence per state, and none on a stable box.
 *
 * The sentence is the one thing worth saying about *this* state, and there is at most one per view:
 * a calm box needs none, so its slot is deliberately empty rather than filled with the caption that
 * already lives inside the command block. The footer falls back to the settings-moved notice there.
 */
const FOOTER_NOTES: Record<LitterFaultClassName, string> = {
  Stable: '',
  Transient: 'The cycle finishes on its own. The panel confirms it by reading the robot, not by the request returning.',
  CatPresent: 'The robot decides when to start. The panel only reports it.',
  Recoverable: 'Pausing stops the retries, not the alert — a paused box is still a box the cat cannot use',
  NeedsHuman: 'The panel cannot clear this. The robot will report ready when the unit is put right.',
  Offline: 'The panel is not the problem to fix here.',
  Unknown: 'The panel is not the problem to fix here.',
}

/**
 * The cycle stopped before it finished — said plainly, above whatever else the state needs.
 *
 * Worth its own band because the alternative is what the panel did before: the progress bar and the
 * step list simply vanished and a different view took their place, leaving someone who had been
 * watching a cycle with no idea it had not completed.
 */
function InterruptedBand({ robot, cat }: { robot: LitterRobotDto; cat: CatNaming }) {
  const catArrived = robot.faultClass === 'CatPresent'
  return (
    <div className={'ml-litter__note' + (catArrived ? ' ml-litter__note--live' : ' ml-litter__note--warn')}>
      {catArrived
        ? `The cycle stopped when ${cat.object} arrived. It starts again by itself once they leave and the wait timer expires.`
        : 'The cycle stopped before it finished. Nothing was left in the globe — the drawer reading below is from before it started.'}
    </div>
  )
}

/** The band directly under the status — the one part that is genuinely per-class. */
function ContextualBand({ robot, now, cat }: { robot: LitterRobotDto; now: number; cat: CatNaming }) {
  const { previousStatus } = useLitter()
  const interrupted = cycleInterrupted(robot, previousStatus)

  switch (robot.faultClass) {
    case 'Transient':
      return <CyclingBand robot={robot} now={now} />

    case 'CatPresent': {
      const wait = robot.controls.selects.cleanCycleWait?.current
      return (
        <>
          {interrupted && <InterruptedBand robot={robot} cat={cat} />}
          <div className="ml-litter__note ml-litter__note--live">
            {`Commands are refused while ${cat.object} is in it. The cycle starts by itself once they leave and the wait timer expires.`}
          </div>
          {/* The number that answers "so when will it run?" — the same select Settings edits. */}
          {wait && (
            <div className="ml-litter__rows">
              <div className="ml-litter__row">
                <span>Wait time after exit</span>
                <span className="ml-litter__rowval">{wait} min</span>
              </div>
            </div>
          )}
        </>
      )
    }

    case 'Recoverable':
      return (
        <>
          {interrupted && <InterruptedBand robot={robot} cat={cat} />}
          <RecoveryBand robot={robot} now={now} />
        </>
      )

    case 'NeedsHuman':
      return <NeedsHumanBand robot={robot} cat={cat} />

    case 'Offline':
    case 'Unknown':
      return (
        <div className="ml-litter__note ml-litter__note--bad">
          The controls are gone rather than greyed: with the robot unreachable, nothing the panel
          sends can land, and a button that silently does nothing is worse than no button.
        </div>
      )

    default:
      // Stable. The absence of a band is the message — a calm box gets a calm screen, and anything
      // between the status and GAUGES is out of spec.
      return null
  }
}

/**
 * Mid-cycle progress — a band, not a card, sitting directly under the status.
 *
 * The fill is **estimated from elapsed time**, not reported: Home Assistant publishes no cycle
 * progress. So it carries no percentage number and never reaches 100% — it is replaced by the next
 * snapshot's view rather than completing. This band answers *how far*; the sequence below the action
 * block answers *doing what*, and they stay apart with the gauges between them.
 */
function CyclingBand({ robot, now }: { robot: LitterRobotDto; now: number }) {
  const { fraction } = cycleProgress(robot, now)

  return (
    <div className="ml-cycling">
      <div className="ml-cycling__track">
        <span className="ml-cycling__bar" style={{ width: `${(fraction * 100).toFixed(1)}%` }} />
      </div>
      <div className="ml-cycling__head">
        <span className="ml-cycling__title">Globe rotating</span>
        <span className="ml-cycling__warn">Do not intervene</span>
      </div>
    </div>
  )
}

/** The four steps of a clean cycle, in sentences rather than protocol keys. */
const CYCLE_STEPS = [
  'Globe rotates to sift',
  'Waste dropped into the drawer',
  'Globe returns and levels',
  'New reading published',
] as const

/** A clean cycle end to end. Not reported by Home Assistant — the LR4's observed typical duration. */
const CYCLE_SECONDS = 120

/** Codes that mean a cycle is running. Leaving one of these for anything else is an interruption. */
const CYCLING_CODES = ['ccp', 'ec']

/** Codes a cycle legitimately ends on. */
const FINISHED_CODES = ['ccc', 'rdy', 'df1', 'df2']

/**
 * Did the cycle we were watching stop before it finished?
 *
 * Two independent sources, because they answer at different times:
 *
 * - **`p` — "Clean Cycle Paused"** is itself the statement. pylitterbot's own vocabulary says a cycle
 *   was interrupted, so this needs no memory and survives a reload.
 * - **An observed transition** out of a running cycle into anything that is not a finish. This is the
 *   only way to catch a cat arriving mid-cycle, because `cd` alone cannot tell you whether a cycle
 *   was underway. It relies on this session having seen the previous state, so a cycle interrupted
 *   while the panel was asleep says nothing rather than guessing.
 */
function cycleInterrupted(robot: LitterRobotDto, previousStatus: Readonly<Record<string, string>>): boolean {
  if (robot.statusCode === 'p') return true
  const was = previousStatus[robot.slug]
  if (!was || !CYCLING_CODES.includes(was)) return false
  return !FINISHED_CODES.includes(robot.statusCode) && !CYCLING_CODES.includes(robot.statusCode)
}

/**
 * How far through the cycle we estimate the robot to be.
 *
 * The bar and the step list read from this one function so they can never tell different stories —
 * a bar sitting still beside a step list that advances is worse than no bar at all.
 *
 * Nothing here is measured: HA publishes no cycle progress, only the status code. So the fill is
 * capped below full — the view is replaced by the next snapshot's state, never "completed" — and no
 * percentage is ever shown, because a number would claim a precision this doesn't have.
 */
function cycleProgress(robot: LitterRobotDto, now: number) {
  const started = new Date(robot.statusSinceUtc ?? robot.fetchedUtc).getTime()
  const elapsed = Math.max(0, (now - started) / 1000)
  return {
    elapsed,
    fraction: Math.min(0.94, elapsed / CYCLE_SECONDS),
    step: Math.min(
      CYCLE_STEPS.length - 1,
      Math.floor(elapsed / (CYCLE_SECONDS / CYCLE_STEPS.length)),
    ),
  }
}

/**
 * What the robot is doing, so nobody opens the lid to find out.
 *
 * Which step is current is **estimated from elapsed time against the code's typical duration** —
 * nothing here is measured. Drawn only for the cycle codes; the power codes (`pwru`/`pwrd`) have no
 * sequence to show, and the footer carries the screen on its own.
 */
function Sequence({ robot, now }: { robot: LitterRobotDto; now: number }) {
  if (robot.statusCode !== 'ccp' && robot.statusCode !== 'ccc') return null

  const { step: current } = cycleProgress(robot, now)

  return (
    <>
      <SectionLabel label="Sequence" status="About 2 min" />
      <div className="ml-sequence">
        {CYCLE_STEPS.map((step, i) => {
          const state = i < current ? 'done' : i === current ? 'now' : 'waiting'
          return (
            <div key={step} className={`ml-sequence__row ml-sequence__row--${state}`}>
              <span className="ml-sequence__num">{i + 1}</span>
              <span className="ml-sequence__label">{step}</span>
              <span className="ml-sequence__tag">
                {state === 'done' ? 'Done' : state === 'now' ? 'Now' : 'Waiting'}
              </span>
            </div>
          )
        })}
      </div>
    </>
  )
}

/**
 * The auto-recovery block — the reason the whole subsystem exists, and the thing the first design
 * omitted entirely.
 *
 * A household watching the box try to fix itself needs to see it happening: which attempt, when the
 * next one lands, and why it is waiting. The controls that answer it live in the action band below
 * the gauges, not in here — the readings sit between the problem and the buttons on every other
 * rendering, and this one is no exception.
 */
function RecoveryBand({ robot, now }: { robot: LitterRobotDto; now: number }) {
  const { recovery } = robot
  const next = countdown(recovery.nextAttemptDueUtc, now)
  const attempt = Math.max(1, recovery.attemptsThisEpisode)
  const ceiling = Math.max(attempt, recovery.maxAttemptsThisEpisode)

  return (
    <>
      <SectionLabel
        label="Auto-recovery"
        status={recovery.enabled ? 'Running' : 'Paused'}
        statusLive={recovery.enabled}
      />
      <div className="ml-recovery">
        <div className="ml-recovery__top">
          <div>
            <div className="ml-litter__eyebrow">{next ? 'Next attempt in' : 'Next attempt'}</div>
            <div className="ml-recovery__countdown serif">{next ?? (recovery.enabled ? 'Due now' : 'Paused')}</div>
          </div>
          <div className="ml-recovery__attempt">
            <div className="ml-litter__eyebrow">Attempt</div>
            <div className="ml-recovery__attemptval">
              <span className="serif">{attempt}</span>
              <span className="ml-recovery__of">of {ceiling}</span>
            </div>
          </div>
        </div>

        <div className="ml-recovery__track">
          <span className="ml-recovery__bar" style={{ width: `${Math.min(100, (attempt / ceiling) * 100)}%` }} />
        </div>

        <div className="ml-recovery__stats">
          <span>{recovery.attemptsToday} attempt{recovery.attemptsToday === 1 ? '' : 's'} today</span>
          <span>{recovery.lastAttemptUtc ? `Last tried ${since(recovery.lastAttemptUtc, now)}` : 'Not tried yet'}</span>
        </div>

        {recovery.holdReason && <div className="ml-recovery__hold">{recovery.holdReason}</div>}
      </div>
    </>
  )
}

/**
 * The physical instruction, as numbered steps. This is the moment the panel earns its place on the
 * wall — it is the only block on the view addressed to a pair of hands rather than to a reader.
 *
 * Shown **only when there is something for a human to do.** A recoverable fault gets the recovery
 * band instead; the panel is still trying, and a numbered list under a retry counter would be
 * telling someone to go and do a job that may finish itself in ninety seconds.
 */
function NeedsHumanBand({ robot, cat }: { robot: LitterRobotDto; cat: CatNaming }) {
  const steps = ACTIONS[robot.statusCode] ?? ACTIONS.default

  return (
    <>
      <SectionLabel label="Go and do this" status={estimateFor(steps)} />
      <div className="ml-steps">
        {steps.map((step, i) => (
          <div className="ml-steps__row" key={step}>
            <span className="ml-steps__num serif">{i + 1}</span>
            <span className="ml-steps__text">{step}</span>
          </div>
        ))}
      </div>
      <div className="ml-litter__rows">
        <div className="ml-litter__row">
          <span>Auto-recovery</span>
          <span className="ml-litter__rowval">Stood down · not recoverable</span>
        </div>
        <div className="ml-litter__row">
          <span>{`${cat.subject} can use the box`}</span>
          <span className="ml-litter__rowval ml-litter__rowval--bad">No</span>
        </div>
      </div>
    </>
  )
}

/**
 * Named per code, because "drawer full" and "bonnet removed" need different hands.
 *
 * One step per physical act, in the order they happen — the last one is always the panel control,
 * so the list ends where the hands come back to the wall.
 */
const ACTIONS: Record<string, string[]> = {
  dfs: [
    'Empty the waste drawer and slide it back until it seats',
    'Wait for the ring to settle',
    'Then reset the drawer below',
  ],
  sdf: [
    'Empty the waste drawer and slide it back until it seats',
    'Wait for the ring to settle',
    'Then reset the drawer below',
  ],
  br: [
    'Seat the bonnet back onto the unit until it clicks',
    'Wait for the ring to settle',
    'Then run a clean cycle below',
  ],
  default: [
    'Check the unit — the robot is reporting a fault a reset cannot clear',
    'Put right whatever the ring is showing',
    'Then run a clean cycle below',
  ],
}

/** A minute a step, rounded to the nearest minute — coarse on purpose, because nothing times this. */
function estimateFor(steps: string[]): string {
  return `About ${Math.max(1, steps.length - 1)} min`
}

/**
 * The readings, and the two ledger rows that exist as much to explain the data as to show it.
 *
 * Mid-fault and mid-cycle the numbers on screen are the last good reading rather than a current one:
 * the meta says `HELD`, the fills dim, and every number carries the time it was taken. Animating a
 * live-looking gauge behind a moving globe would be inventing data.
 */
function Gauges({ robot, dark }: { robot: LitterRobotDto; dark: boolean }) {
  if (dark) {
    return (
      <>
        <SectionLabel label="Gauges" status="No reading" />
        <Gauge label="Waste drawer" value={null} note="No reading" tone="unknown" />
        <Gauge label="Litter level" value={null} note="No reading" tone="unknown" />
      </>
    )
  }

  const held = robot.faultClass === 'Recoverable'
    || robot.faultClass === 'NeedsHuman'
    || robot.faultClass === 'Transient'
  const asOf = `As of ${clock(robot.fetchedUtc)}`

  return (
    <>
      {/* `SHARE OF THE WINDOW` is the designed status, and it is what a live pair of gauges reads.
          A held reading keeps its own words: "last good reading" is a claim about the *data*, and
          losing it would leave two bars from before the fault looking current. */}
      <SectionLabel
        label="Gauges"
        status={held ? 'Held — last good reading' : 'Share of the window'}
      />
      <Gauge
        label="Waste drawer"
        value={robot.wasteDrawerPercent}
        note={robot.wasteDrawerPercent == null
          ? (held ? 'Unknown since the fault' : 'No reading')
          : held ? asOf : drawerNote(robot.wasteDrawerPercent)}
        // Held readings carry no judgement: a verdigris "room to spare" would be a live claim about a
        // number taken before the globe started turning.
        tone={held ? 'held' : gaugeTone(robot.wasteDrawerPercent, 'up')}
      />
      <Gauge
        label="Litter level"
        value={robot.litterPercent}
        note={robot.litterPercent == null
          ? (held ? 'Unknown since the fault' : 'No reading')
          : held ? asOf : litterNote(robot.litterPercent)}
        tone={held ? 'held' : gaugeTone(robot.litterPercent, 'down')}
      />
      {/* The pet weight and the cycle count moved out to TODAY, where they read as figures rather
          than as footnotes hanging off the bars. No `Litter hopper` row anywhere — the accessory
          isn't fitted, and an absent accessory is not a ledger row. No `Last seen` row either: the
          sync line answers that, and two answers to one question is how they end up disagreeing. */}
    </>
  )
}

function drawerNote(value: number): string {
  if (value >= 90) return 'Empty it'
  if (value >= 70) return 'Getting full'
  return 'Room to spare'
}

function litterNote(value: number): string {
  if (value <= 10) return 'Top it up now'
  if (value <= 25) return 'Top it up'
  return 'OK'
}

/** `held` is a reading taken before the current motion — shown plainly, with no judgement colour. */
type GaugeTone = 'live' | 'warn' | 'bad' | 'unknown' | 'held'

/** Waste counts up toward full; litter counts down toward empty. */
function gaugeTone(value: number | null, direction: 'up' | 'down'): GaugeTone {
  if (value == null) return 'unknown'
  return direction === 'up'
    ? value >= 90 ? 'bad' : value >= 70 ? 'warn' : 'live'
    : value <= 10 ? 'bad' : value <= 25 ? 'warn' : 'live'
}

/**
 * One gauge.
 *
 * Colour carries the judgement and the number does not: the figure is ink whatever it says, and the
 * word beside it goes verdigris, brass or terracotta. A number that changes colour reads as an alarm
 * about the *reading* rather than about the drawer.
 */
function Gauge({
  label, value, note, tone,
}: {
  label: string
  value: number | null
  note: string
  tone: GaugeTone
}) {
  const known = value != null
  return (
    <div className="ml-gauge">
      <div className="ml-gauge__head">
        <span className="ml-gauge__label">{label}</span>
        <span className={`ml-gauge__note ml-gauge__note--${tone}`}>{note}</span>
        <span className={'ml-gauge__value serif' + (known ? '' : ' ml-gauge__value--unknown')}>
          {known ? `${Math.round(value)}%` : '—'}
        </span>
      </div>
      {/* A null gauge is hatched, never drawn at 0% — reading an unknown litter level as empty
          would trip the empty-globe alert on every cloud hiccup. */}
      <div className={'ml-gauge__track' + (known ? '' : ' ml-gauge__track--unknown')}>
        {known && (
          <span
            className={`ml-gauge__fill ml-gauge__fill--${tone}`}
            style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
          />
        )}
      </div>
    </div>
  )
}

/**
 * The action band. Three treatments, never four tiles — and never a fourth treatment.
 *
 * 1. **Available** — the bordered block, the hold track and the fire-and-forget caption.
 * 2. **Blocked** — the same geometry in ghost grey, with the label *replaced by the reason it cannot
 *    run* and the state word hard right. No hold affordance and no caption: on a wall panel at cat
 *    height, anything that still reads `RUN A CLEAN CYCLE` invites a press.
 * 3. **Absent** — offline. No block, no placeholder, no skeleton.
 *
 * Recovery is its own case: it offers *choices* rather than the one command, so the band carries the
 * two hold controls instead. A clean-cycle block underneath them would be a third way to do the same
 * thing as TRY NOW.
 */
function ActionBand({ robot, pending }: { robot: LitterRobotDto; pending: ReadonlySet<string> }) {
  const { startCycle, setRecovery, resetDrawer } = useLitter()
  const busy = pending.has(`${robot.slug}:cycle`)

  if (robot.faultClass === 'Offline' || robot.faultClass === 'Unknown') return null

  if (robot.faultClass === 'Recoverable') {
    const { recovery } = robot
    return (
      <>
        <SectionLabel label="Your call" status={<span className="ml-care__warnstatus">Hold to confirm</span>} />
        <div className="ml-litter__controls">
          <HoldButton
            disabled={pending.has(`${robot.slug}:recovery`)}
            meta={recovery.enabled ? 'Pause recovery · hold 2 s' : 'Resume recovery · hold 2 s'}
            onHold={() => void setRecovery(robot.slug, !recovery.enabled)}
          >
            {recovery.enabled ? 'Leave it' : 'Resume'}
          </HoldButton>
          <HoldButton disabled={busy} meta="Force a cycle · hold 2 s" onHold={() => void startCycle(robot.slug)}>
            Try now
          </HoldButton>
        </div>
      </>
    )
  }

  const blocked = robot.faultClass === 'Transient'
    ? { reason: 'Cycle running', meta: 'Locked while moving' }
    : robot.faultClass === 'CatPresent'
      ? { reason: 'Not while occupied', meta: 'Waiting for the cat' }
      : null

  if (blocked) {
    return (
      <>
        <SectionLabel label="Clean cycle" status={blocked.meta} />
        <div className="ml-cleancycle">
          {/* Not a disabled button: a state row. It has no press handler at all, so there is nothing
              for a stray touch to find. */}
          <div className="ml-cleancycle__blocked">
            <Icon id="ico-refresh" size="1.5625rem" />
            <span className="ml-cleancycle__reason">{blocked.reason}</span>
            <span className="ml-cleancycle__state">Unavailable</span>
          </div>
        </div>
      </>
    )
  }

  /**
   * YOUR CALL — the two commands, side by side, while the robot is faulted.
   *
   * Reset drawer is live because it is the act that ends a drawer-full fault: it tells the robot the
   * drawer is empty, which is the one thing the robot cannot work out for itself. Clean cycle is
   * **blocked, not absent** — it is a deliverable command that is refused right now, and the meta
   * says exactly why. A greyed control with no reason is what sends someone to the box to check.
   */
  if (robot.faultClass === 'NeedsHuman') {
    return (
      <>
        <SectionLabel label="Your call" status={<span className="ml-care__warnstatus">Hold to confirm</span>} />
        <div className="ml-commands">
          <HoldButton
            className="ml-command"
            disabled={pending.has(`${robot.slug}:drawer`)}
            progressTrack
            meta="Tells the robot it is empty"
            onHold={() => void resetDrawer(robot.slug)}
          >
            Reset drawer
          </HoldButton>
          {/* Not a disabled button: a state row. It has no press handler at all, so there is nothing
              for a stray touch on a wall panel at cat height to find. */}
          <div className="ml-command ml-command--blocked">
            <span className="ml-command__label">Clean cycle</span>
            <span className="ml-command__meta">Blocked while faulted</span>
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <SectionLabel label="Clean cycle" />
      <div className="ml-cleancycle">
        <HoldButton
          className="ml-cleancycle__block"
          disabled={busy}
          progressTrack
          onHold={() => void startCycle(robot.slug)}
        >
          <span className="ml-cleancycle__row">
            <Icon id="ico-refresh" size="1.5625rem" />
            <span className="ml-cleancycle__title">Run a clean cycle</span>
            <span className="ml-cleancycle__hold">{busy ? 'Sending…' : 'Hold 2 s'}</span>
          </span>
        </HoldButton>
        <div className="ml-cleancycle__caption">
          The robot can accept this and quietly drop it. The panel will show the next reading, not
          the request.
        </div>
      </div>
    </>
  )
}

/** The band below the action: the event log, the attempt log, or the connection rows. */
function TrailingBand({
  robot, now, health, cat, quiet,
}: {
  robot: LitterRobotDto
  now: number
  health: CatHealthDto | null
  cat: CatNaming
  quiet: boolean
}) {
  if (robot.faultClass === 'Offline' || robot.faultClass === 'Unknown') {
    return <Connection robot={robot} now={now} health={health} />
  }

  if (robot.faultClass === 'Recoverable') {
    return <EpisodeLog robot={robot} now={now} />
  }

  // Cycling is the one state with no log: the sequence above it is already answering "what is
  // happening", and a second list under it would compete with the answer.
  if (robot.faultClass === 'Transient') return null

  const title = robot.faultClass === 'NeedsHuman'
    ? 'Since the fault'
    : robot.faultClass === 'CatPresent'
      ? 'Today'
      : 'Lately'

  return <EventLog robot={robot} cat={cat} title={title} quiet={quiet} />
}

// ---------------------------------------------------------------------------
// The event log.
//
// Home Assistant reports where the robot *is*, never how it got there, so every
// row here is a status transition read back out of HA's recorder. HomeHub
// writes the sentences: the API sends a kind, because the wording carries the
// household's name for the cat and because the outcome tag is presentation.
// ---------------------------------------------------------------------------

/** Two days: enough that a seventeen-hour-old reading still has yesterday's rows under it. */
const LOG_DAYS = 2

/** Five rows on the tab root. The rest lives behind HISTORY ▸. */
const LOG_ROWS = 5

function useLitterEvents(slug: string | undefined) {
  const [events, setEvents] = useState<LitterEventDto[] | null>(null)

  useEffect(() => {
    if (!slug) return
    let cancelled = false
    api.getLitterHistory(slug, LOG_DAYS)
      .then((h) => { if (!cancelled) setEvents(h.events) })
      // A recorder query is the heaviest thing the panel asks of HA and the likeliest to time out.
      // The log staying empty is a smaller lie than the screen failing around it.
      .catch((err) => { if (!(err instanceof ApiError)) throw err })
    return () => { cancelled = true }
  }, [slug])

  return events
}

interface EventCopy {
  text: string
  tag: string
  tone: 'live' | 'accent' | 'warn' | 'bad' | 'muted'
}

/**
 * One event, in English.
 *
 * Sentences, never uppercase protocol keys — `Waste dropped into the drawer`, not `DUMP`. The status
 * text inside them is pylitterbot's own, so it matches what the Whisker app shows when someone is
 * standing at the box comparing the two.
 */
function eventCopy(event: LitterEventDto, cat: CatNaming): EventCopy {
  switch (event.kind) {
    case 'CatVisit':
      return { text: `${cat.subject} in the box · commands refused`, tag: 'Expected', tone: 'accent' }
    case 'CycleComplete':
      return { text: 'Cycle ran to completion', tag: 'Clean', tone: 'live' }
    case 'ClearedItself':
      return {
        text: `${event.statusText ?? 'Fault'} · cleared on its own`,
        tag: 'Cleared itself',
        tone: 'warn',
      }
    case 'Fault':
      return { text: event.statusText ?? 'Faulted', tag: 'Faulted', tone: 'warn' }
    case 'NeedsHuman':
      return { text: `${event.statusText ?? 'Fault'} · needed a person`, tag: 'Needs a human', tone: 'bad' }
    case 'Weight':
      return {
        text: cat.name
          ? `${cat.subject} weighed ${event.value?.toFixed(1)} lb`
          : `Pet weight recorded · ${event.value?.toFixed(1)} lb`,
        tag: 'One visit',
        tone: 'muted',
      }
    case 'Offline':
      return { text: 'Lost contact with the robot', tag: 'Offline', tone: 'bad' }
  }
}

/*
 * `dayLabel` and `entriesLabel` were defined here. They are in `app/care.ts` now, unchanged — the
 * baby's entries list blocks by day too, and two screens deciding separately what to call yesterday
 * is how one of them ends up saying `Aug 18` about the rows the other calls `Yesterday`.
 */

/**
 * What the box has been doing, newest first.
 *
 * The day sub-head names whatever day the rows are from and counts them, which is why it can read
 * `YESTERDAY` under a reading that is seventeen hours old: stamping recorder rows as though the feed
 * were live is exactly the contradiction the freshness line exists to prevent.
 */
function EventLog({
  robot, cat, title, quiet,
}: {
  robot: LitterRobotDto
  cat: CatNaming
  title: string
  quiet: boolean
}) {
  const now = useNow(60_000)
  const events = useLitterEvents(robot.slug)
  const rows = (events ?? []).slice(0, LOG_ROWS)

  // Per-day counts across the rows actually shown, so the sub-head's tally can never overstate what
  // is under it.
  const perDay = new Map<string, number>()
  for (const row of rows) {
    const key = dayLabel(row.atUtc, now)
    perDay.set(key, (perDay.get(key) ?? 0) + 1)
  }

  let currentDay: string | null = null

  return (
    <>
      <SectionLabel
        label={title}
        status={quiet ? 'Nothing since the robot went quiet' : 'Newest first'}
      />
      <div className="ml-litter__log">
        {events !== null && rows.length === 0 && (
          <div className="ml-litter__logempty">No events in this window.</div>
        )}
        {rows.map((event) => {
          const copy = eventCopy(event, cat)
          const day = dayLabel(event.atUtc, now)
          const divider = day !== currentDay ? day : null
          currentDay = day
          return (
            <div key={`${event.atUtc}-${event.kind}`}>
              {divider && (
                <div className="ml-litter__logday">
                  <span>{divider}</span>
                  <span>{entriesLabel(perDay.get(divider) ?? 0)}</span>
                </div>
              )}
              <div className="ml-litter__logrow">
                <span className="ml-litter__logtime serif">{clock(event.atUtc)}</span>
                <span className="ml-litter__logtext">{copy.text}</span>
                <span className={`ml-litter__logtag ml-litter__logtag--${copy.tone}`}>{copy.tag}</span>
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}

/** The five-state health, spelled out, when nothing else can be shown. */
function Connection({ robot, now, health }: { robot: LitterRobotDto; now: number; health: CatHealthDto | null }) {
  const haOk = health?.status === 'Ok' || health?.status === 'Stale'
  return (
    <>
      <SectionLabel label="Connection" />
      <div className="ml-litter__rows">
        <div className="ml-litter__row">
          <span>Home Assistant</span>
          <span className={'ml-litter__rowval' + (haOk ? ' ml-litter__rowval--live' : ' ml-litter__rowval--bad')}>
            {haOk ? 'Reachable' : 'Unreachable'}
          </span>
        </div>
        <div className="ml-litter__row">
          <span>Litter-Robot integration</span>
          <span className={'ml-litter__rowval' + (health?.status === 'IntegrationMissing' ? ' ml-litter__rowval--bad' : '')}>
            {health?.status === 'IntegrationMissing' ? 'Not found' : 'OK'}
          </span>
        </div>
        <div className="ml-litter__row">
          <span>Last good reading</span>
          <span className="ml-litter__rowval">{since(health?.lastGoodUtc ?? robot.lastSeenUtc, now)}</span>
        </div>
      </div>
      {health?.detail && <div className="ml-litter__note ml-litter__note--bad">{health.detail}</div>}
    </>
  )
}

/** What the panel has already tried this episode — the answer to "is it doing anything?". */
function EpisodeLog({ robot, now }: { robot: LitterRobotDto; now: number }) {
  const [rows, setRows] = useState<RecoveryAttemptDto[]>([])

  useEffect(() => {
    let cancelled = false
    api.getLitterRecoveries(robot.slug, 1)
      .then((r) => { if (!cancelled) setRows(r) })
      .catch((err) => { if (!(err instanceof ApiError)) throw err })
    return () => { cancelled = true }
  }, [robot.slug, robot.recovery.attemptsThisEpisode])

  const since_ = robot.recovery.faultSinceUtc ? new Date(robot.recovery.faultSinceUtc).getTime() : 0
  const episode = rows.filter((r) => new Date(r.startedAtUtc).getTime() >= since_)

  return (
    <>
      <SectionLabel label="This episode" status={`${episode.length} attempt${episode.length === 1 ? '' : 's'}`} />
      <div className="ml-litter__rows">
        {episode.length === 0 && (
          <div className="ml-litter__row">
            <span className="ml-litter__rowsub">Nothing tried yet — the fault is still being confirmed.</span>
          </div>
        )}
        {episode.map((r) => (
          <div key={r.id} className="ml-litter__row">
            <div>
              <div className="ml-litter__rowtime">{clock(r.startedAtUtc)}</div>
              <div className="ml-litter__rowsub">{stepText(r.step)}</div>
            </div>
            <span className={`ml-litter__rowval ml-litter__rowval--${outcomeTone(r.outcome)}`}>
              {outcomeText(r.outcome)}
            </span>
          </div>
        ))}
        <div className="ml-litter__row">
          <div>
            <div className="ml-litter__rowtime">{clock(robot.recovery.faultSinceUtc)}</div>
            <div className="ml-litter__rowsub">Fault first seen</div>
          </div>
          <span className="ml-litter__rowval">{robot.statusText}</span>
        </div>
      </div>
      <div className="ml-litter__note">{`Last tried ${since(robot.recovery.lastAttemptUtc, now)}.`}</div>
    </>
  )
}

function stepText(step: string): string {
  switch (step) {
    case 'ShortReset': return 'Short reset'
    case 'Reset': return 'Reset, then clean cycle'
    case 'CleanCycle': return 'Clean cycle'
    case 'PowerCycle': return 'Power cycle'
    default: return step
  }
}

/** Outcomes are verified by observed status, never by the command call returning. */
function outcomeText(outcome: string): string {
  switch (outcome) {
    case 'Recovered': return 'Cleared'
    case 'Failed': return 'Faulted again'
    case 'Aborted': return 'Stood down'
    case 'Errored': return 'Did not send'
    case 'Started': return 'In flight'
    default: return outcome
  }
}

function outcomeTone(outcome: string): string {
  switch (outcome) {
    case 'Recovered': return 'live'
    case 'Failed':
    case 'Errored': return 'bad'
    default: return 'muted'
  }
}
