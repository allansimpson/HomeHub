import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DrillInHeader, EmptyState, ScreenShell, ScrollArea, SectionLabel } from '../components'
import { useLitter } from '../app/LitterProvider'
import { api, ApiError } from '../api/client'
import type { LitterHistoryDto, RecoveryAttemptDto } from '../api/types'

const RANGES = [7, 30, 90] as const

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/**
 * How long the held window actually is, in words. "About a day" lands harder than a date does when
 * the point is that the range tab is promising more than the recorder can give.
 */
function roughSpan(oldestIso: string): string {
  const hours = Math.max(0, (Date.now() - new Date(oldestIso).getTime()) / 3_600_000)
  if (hours < 36) return 'about a day'
  const days = Math.round(hours / 24)
  if (days < 7) return `about ${days} days`
  const weeks = Math.round(days / 7)
  return weeks === 1 ? 'about a week' : `about ${weeks} weeks`
}

/** Outcomes are observed, not inferred from a command returning. */
function outcome(o: string): { text: string; tone: string } {
  switch (o) {
    case 'Recovered': return { text: 'Cleared', tone: 'live' }
    case 'Failed': return { text: 'Gave up', tone: 'bad' }
    case 'Errored': return { text: 'Did not send', tone: 'bad' }
    case 'Aborted': return { text: 'Stood down', tone: 'muted' }
    default: return { text: 'In flight', tone: 'muted' }
  }
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

/** The order the classes read in, best to worst, so the stacked bar tells a story left to right. */
const CLASS_ORDER = ['Stable', 'CatPresent', 'Transient', 'Recoverable', 'NeedsHuman', 'Offline', 'Unknown']

const CLASS_LABEL: Record<string, string> = {
  Stable: 'Stable',
  CatPresent: 'Cat present',
  Transient: 'Cycling',
  Recoverable: 'Recoverable',
  NeedsHuman: 'Needs a human',
  Offline: 'Offline',
  Unknown: 'Unknown',
}

/**
 * Litter History — the record that tells an occasionally-flaky robot apart from one that has started
 * failing and needs a service call.
 *
 * Everything here except the recovery log comes from **Home Assistant's recorder**, because HomeHub
 * persists only its own recovery attempts. The recorder purges (10 days by default), so a 30- or
 * 90-day request usually comes back short — the screen says which window it actually got rather than
 * drawing a partial series as though it were the whole story.
 *
 * Cycles per day stays visible as `—` on purpose: the absence is information, and it stops the same
 * question being asked every few months.
 */
export function LitterHistoryScreen() {
  const navigate = useNavigate()
  const { robots } = useLitter()
  const robot = robots[0] ?? null

  const [days, setDays] = useState<number>(7)
  const [rows, setRows] = useState<RecoveryAttemptDto[] | null>(null)
  const [history, setHistory] = useState<LitterHistoryDto | null>(null)
  /** The trend read failed, as opposed to succeeding with nothing in it — different sentences. */
  const [trendFailed, setTrendFailed] = useState(false)

  useEffect(() => {
    if (!robot) return
    let cancelled = false
    setRows(null)
    setHistory(null)
    setTrendFailed(false)
    void Promise.allSettled([
      api.getLitterRecoveries(robot.slug, days),
      api.getLitterHistory(robot.slug, days),
    ]).then(([recoveries, trend]) => {
      if (cancelled) return
      setRows(recoveries.status === 'fulfilled' ? recoveries.value : [])
      setHistory(trend.status === 'fulfilled' ? trend.value : null)
      setTrendFailed(trend.status === 'rejected')
      for (const r of [recoveries, trend]) {
        if (r.status === 'rejected' && !(r.reason instanceof ApiError)) throw r.reason
      }
    })
    return () => { cancelled = true }
    // Keyed on the slug, not the robot object. `LitterProvider` re-parses its snapshots on every 20s
    // poll, so `robot` is a new object each tick even when nothing about the box changed — depending
    // on it re-ran this effect three times a minute, blanking the screen back to "Reading…" and
    // re-issuing the 90-day recorder query, the heaviest call the panel makes. `useLitterEvents`
    // already keys on the slug for exactly this reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [robot.slug, days])

  // One row per episode, not per attempt: a fault that took three resets to clear is one event in
  // the household's life, and listing it three times would overstate how often the box breaks.
  const episodes = useMemo(() => {
    if (!rows) return []
    const byEpisode = new Map<string, RecoveryAttemptDto[]>()
    for (const row of [...rows].sort((a, b) => a.startedAtUtc.localeCompare(b.startedAtUtc))) {
      // Grouped by the *local* calendar day, because that is the day the rows are displayed under.
      // `toISOString()` gives the UTC day: west of Greenwich an evening fault whose retries cross
      // UTC midnight was split into two episodes and over-counted, while two genuinely separate
      // faults twelve hours apart could land on one UTC day and merge into a single row.
      const local = new Date(row.startedAtUtc)
      const day = `${local.getFullYear()}-${local.getMonth() + 1}-${local.getDate()}`
      const key = `${row.faultCode}:${day}`
      const existing = byEpisode.get(key)
      if (existing) existing.push(row)
      else byEpisode.set(key, [row])
    }
    return [...byEpisode.values()]
      .map((attempts) => ({
        first: attempts[0],
        attempts,
        cleared: attempts.some((a) => a.outcome === 'Recovered'),
      }))
      .sort((a, b) => b.first.startedAtUtc.localeCompare(a.first.startedAtUtc))
  }, [rows])

  const header = (
    <DrillInHeader title="Litter History" onBack={() => navigate('/litter')} status={robot?.name ?? ''} />
  )

  if (!robot) {
    return <ScreenShell header={header}><EmptyState label="No litter box found" /></ScreenShell>
  }

  const weights = history?.weights ?? []
  const withDrawer = (history?.days ?? []).filter((d) => d.drawerPercent != null)

  return (
    <ScreenShell header={header}>
      <ScrollArea>
        <div className="ml-range">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              className={'ml-chip' + (r === days ? ' ml-chip--active' : '')}
              onClick={() => setDays(r)}
            >
              {r} days
            </button>
          ))}
        </div>

        {/* A failed read is not an empty history. Saying "nothing recorded" when the truth is
            "we couldn't ask" would report a quiet robot instead of a broken connection. */}
        {trendFailed && (
          <div className="ml-litter__note ml-litter__note--bad">
            Home Assistant did not return history for this window. The recovery episodes below come
            from the panel's own records and are unaffected.
          </div>
        )}

        {/* The recorder is finite. Saying so is the difference between "the box was fine for 90
            days" and "we can only see the last week". */}
        {history && !history.complete && (
          <div className="ml-litter__note">
            {history.oldestSampleUtc
              ? `The recorder only holds back to ${dayLabel(history.oldestSampleUtc)} — ${roughSpan(history.oldestSampleUtc)}. Everything below is that window, not ${days} days.`
              : 'Home Assistant has no recorded history for this robot yet.'}
          </div>
        )}

        <SectionLabel
          label="Recovery episodes"
          status={rows === null ? 'Reading…' : `${episodes.length} in ${days} days`}
        />
        <div className="ml-litter__rows">
          {rows !== null && episodes.length === 0 && (
            <div className="ml-litter__row">
              <span className="ml-litter__rowsub">
                Nothing to report — the box has not faulted in this window.
              </span>
            </div>
          )}
          {episodes.map(({ first, attempts, cleared }) => {
            const last = attempts[attempts.length - 1]
            const tag = cleared ? { text: 'Cleared', tone: 'live' } : outcome(last.outcome)
            return (
              <div key={`${first.id}`} className="ml-litter__row">
                <div>
                  <div className="ml-litter__rowtime">{dayLabel(first.startedAtUtc)} · {clock(first.startedAtUtc)}</div>
                  <div className="ml-litter__rowsub">
                    {`${first.faultCode.toUpperCase()} · ${attempts.length} attempt${attempts.length === 1 ? '' : 's'} · ${stepText(last.step)}`}
                    {attempts.some((a) => a.manual) ? ' · included a manual press' : ''}
                  </div>
                </div>
                <span className={`ml-litter__rowval ml-litter__rowval--${tag.tone}`}>{tag.text}</span>
              </div>
            )
          })}
        </div>

        <HowTheWeekRead share={history?.classShare} />

        {/* The meta is the sampled count, not the window length: it is the one number that says how
            much of what follows is real. */}
        <SectionLabel
          label="Drawer, day by day"
          status={
            history
              ? `${withDrawer.length} of ${history.days.length} days sampled`
              : 'Reading…'
          }
        />
        <DayBars days={history?.days ?? []} />
        <div className="ml-litter__rows">
          <div className="ml-litter__row">
            <div>
              <div>Fills at</div>
              {/* Only rises count — emptying the drawer drops the reading, and folding that in would
                  report a box that fills more slowly the more it is used. */}
              <div className="ml-litter__rowsub">Rises only; emptying it is not a negative</div>
            </div>
            <span className="ml-litter__rowval serif">
              {history?.drawerFillPercentPerDay == null
                ? '—'
                : `${history.drawerFillPercentPerDay.toFixed(1)} % / day`}
            </span>
          </div>
          <div className="ml-litter__row">
            <div>
              <div>Reaches 90%</div>
              <div className="ml-litter__rowsub">At the current rate</div>
            </div>
            <span className="ml-litter__rowval serif">
              {history?.daysUntilDrawerFull == null
                ? '—'
                : `in ${history.daysUntilDrawerFull} day${history.daysUntilDrawerFull === 1 ? '' : 's'}`}
            </span>
          </div>
          {/* There is no cycle counter in Home Assistant — not a sensor, not an attribute on the
              vacuum entity. But every cycle passes through `ccp`, so the status history counts them.
              Observed, not the robot's odometer: a cycle that started and finished between two cloud
              pushes never appears, which is why the caption says counted rather than reported. */}
          <div className="ml-litter__row">
            <div>
              <div>Cycles per day</div>
              <div className="ml-litter__rowsub">
                {history
                  ? `${history.cyclesObserved} counted from status history — the robot reports no total`
                  : 'Counted from status history'}
              </div>
            </div>
            <span className="ml-litter__rowval serif">
              {history?.cyclesPerDay == null ? '—' : history.cyclesPerDay.toFixed(1)}
            </span>
          </div>
        </div>

        <SectionLabel label="Pet weight" status={`${weights.length} reading${weights.length === 1 ? '' : 's'}`} />
        <div className="ml-weight">
          <Sparkline values={weights.map((w) => w.pounds)} />
          <div className="ml-weight__now">
            <span className="serif">
              {robot.petWeightLbs == null ? '—' : `${robot.petWeightLbs.toFixed(1)}`}
            </span>
            <span className="ml-weight__unit">lb</span>
          </div>
        </div>
        <div className="ml-litter__rows">
          <div className="ml-litter__row">
            <span className="ml-litter__rowsub">The robot weighs whoever is in it — there is no per-cat identity</span>
          </div>
        </div>

        <div className="ml-litter__footer">
          <span className="ml-litter__footnote">
            A day with no sample is unknown, not zero — it counts toward neither the rate nor the
            share. Weights are estimated by the unit.
          </span>
        </div>
      </ScrollArea>
    </ScreenShell>
  )
}

/**
 * The honest "how is the box doing" number: share of the window in each fault class, weighted by
 * duration. It costs nothing extra — the same status history the other sections already pulled.
 */
function HowTheWeekRead({ share }: { share?: Record<string, number> }) {
  const entries = CLASS_ORDER
    .map((k) => ({ key: k, value: share?.[k] ?? 0 }))
    .filter((e) => e.value > 0)

  return (
    <>
      <SectionLabel label="How it read" status={entries.length === 0 ? 'No history' : 'Share of the window'} />
      {entries.length === 0 ? (
        <div className="ml-litter__rows">
          <div className="ml-litter__row">
            <span className="ml-litter__rowsub">Home Assistant holds no status history for this window.</span>
          </div>
        </div>
      ) : (
        <div className="ml-share">
          <div className="ml-share__bar">
            {entries.map((e) => (
              <span
                key={e.key}
                className={`ml-share__seg ml-share__seg--${e.key.toLowerCase()}`}
                style={{ width: `${e.value * 100}%` }}
              />
            ))}
          </div>
          <div className="ml-share__legend">
            {entries.map((e) => (
              <span key={e.key} className="ml-share__item">
                <span className={`ml-share__dot ml-share__seg--${e.key.toLowerCase()}`} aria-hidden="true" />
                {CLASS_LABEL[e.key] ?? e.key} {Math.round(e.value * 100)}%
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

/** One bar per day, today last. Days the recorder has nothing for are drawn as gaps, not as zero. */
function DayBars({ days }: { days: { day: string; drawerPercent: number | null }[] }) {
  const recent = days.slice(-14)
  if (recent.length === 0) {
    return (
      <div className="ml-litter__rows">
        <div className="ml-litter__row">
          <span className="ml-litter__rowsub">No recorded levels in this window.</span>
        </div>
      </div>
    )
  }

  return (
    <div className="ml-daybars">
      {recent.map((d, i) => {
        const known = d.drawerPercent != null
        const last = i === recent.length - 1
        return (
          <div key={d.day} className="ml-daybars__col">
            <div className="ml-daybars__track">
              {known ? (
                <span
                  className={'ml-daybars__bar' + (last ? ' ml-daybars__bar--today' : '')}
                  style={{ height: `${Math.max(2, Math.min(100, d.drawerPercent!))}%` }}
                />
              ) : (
                // A hatched stub at the baseline, the same treatment the gauges give an unknown —
                // visibly "no reading", never a bar at zero.
                <span className="ml-daybars__bar ml-daybars__bar--unknown" />
              )}
            </div>
            <span className="ml-daybars__label">
              {new Date(`${d.day}T00:00:00`).toLocaleDateString(undefined, { weekday: 'narrow' })}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** Plain polyline — no axes, no grid, no fill. It shows shape, and the figure beside it shows value. */
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <div className="ml-spark ml-spark--empty">Not enough readings</div>

  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * 100
      const y = 100 - ((v - min) / span) * 100
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')

  return (
    <svg className="ml-spark" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
