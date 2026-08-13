import { useNavigate } from 'react-router'
import { DashboardHeader, ScreenShell, SectionLabel, LedgerRow, AlertBanner, Stepper } from '../components'
import { useClock } from '../app/useClock'
import { useSession } from '../app/SessionProvider'
import { useSensors } from '../app/SensorsProvider'
import { useWeather } from '../app/WeatherProvider'
import { useCalendar } from '../app/CalendarProvider'
import { useClimate } from '../app/ClimateProvider'
import { useConnection } from '../app/ConnectionProvider'
import { useMeals } from '../app/MealsProvider'
import { usePantry } from '../app/PantryProvider'
import { useBaby } from '../app/BabyProvider'
import { useCareSubjects } from '../app/careSubjects'
import { useNeedsYou, alertTarget, alertHeadline, type NeedsRow } from '../app/needsYou'
import { useNow } from '../app/useNow'
import { Icon } from '../icons/Icon'
import { formatTime } from '../app/dates'
import { durationLabel, entriesFor, startBy, todayKey } from '../app/mealsDomain'
import type { CalendarEventDto, ClimateZoneDto, ZoneReadingDto } from '../api/types'

/** Events shown before the NEXT section collapses the rest into a "+N MORE" link (no-scroll). */
const NEXT_PREVIEW = 2
/**
 * Exceptions shown before NEEDS YOU collapses the rest.
 *
 * Three, and the screen does not scroll. A block that grew with the number of problems would push
 * the house off the bottom of the panel exactly on the day the house is what you need to see.
 */
const NEEDS_PREVIEW = 3
/** Rooms rolled up into the house line before it stops naming them. */
const HOUSE_ROLLUP = 2

/**
 * Dashboard — home AND idle screen. 540 × 960, and it **never scrolls**.
 *
 * The question it answers: *what needs me, what's next, is the house alright.* Three candidates were
 * built and **option A — exceptions first** was chosen, which is why NEEDS YOU is above everything
 * including the schedule.
 *
 * Nothing here changes with the hour. Option B was the only candidate whose content did — at 3am it
 * would have held the feed log and nothing else — and it was not chosen, so the 3am Dashboard is
 * the 4pm Dashboard. `useAmbient` and night mode change the *palette*, never the content.
 */
export function DashboardScreen() {
  const { time, ampm, date } = useClock()
  const navigate = useNavigate()
  const { activeProfile } = useSession()
  const { zones, alerts } = useSensors()
  const { weather, offline: weatherOffline } = useWeather()
  const { upcoming } = useCalendar()
  const { zones: climateZones, setTarget } = useClimate()
  // `reconnecting`, not `!online`: the chip is the dashboard's counterpart to the app-level banner
  // and follows the same rule — a blip that clears before anyone reads it is not worth drawing.
  const { reconnecting, stale } = useConnection()
  const needs = useNeedsYou()

  /*
   * The block leads with a room the loop actually holds.
   *
   * It used to lead with the Living Room, which has a probe and no unit — so its steppers wrote a set
   * point on whichever unit happened to be first in the list. Since Climate gained a control loop
   * that owns every set point, a stepper wired that way would be put back within ten minutes: a
   * control that silently does nothing. The first automated room is the one whose *target* a person
   * can move, and moving a target is a thing that lasts.
   */
  const climateZone = climateZones.find((z) => z.class === 'Automated' && z.standingTargetF != null) ?? null

  const nextPreview = upcoming.slice(0, NEXT_PREVIEW)
  const nextHidden = upcoming.length - nextPreview.length

  const needsPreview = needs.slice(0, NEEDS_PREVIEW)
  const needsHidden = needs.length - needsPreview.length
  const anyHard = needs.some((n) => n.tone === 'bad')

  /**
   * `AlertBanner` is now severe-only, and that narrowing is finally correct.
   *
   * It was narrowed once before on the premise that everything else "arrives as a notification",
   * which was untrue — nothing converts sensor, climate or weather alerts into notifications, so a
   * warning-severity threshold had no home-screen surface at all. NEEDS YOU is that surface. The
   * banner keeps its hazard stripe for the one severity that earns interrupting the screen.
   */
  const severeAlert = alerts.find((a) => a.severity === 'Severe')

  /**
   * Weather is the exception to severe-only, on the same test Weather itself uses.
   *
   * A watch or a warning is exactly the kind of thing the dashboard exists to say — it is the screen
   * the panel sits on all day, and a household that has to open Weather to find out a storm is coming
   * is a household that finds out late. NEEDS YOU carries the rest, but it is a list of chores with a
   * hazard hidden in it; weather gets the banner.
   *
   * Severe still wins the slot outright, whatever its source: one banner, and the worst thing in the
   * house is the thing it should be naming.
   */
  const weatherAlert = alerts.find((a) => a.source === 'weather')
  const bannerAlert = severeAlert ?? weatherAlert

  const current = weather?.current
  const conditions = current?.tempF != null
    ? `${Math.round(current.tempF)}° ${(current.condition ?? '').toUpperCase()}${current.feelsLikeF != null ? ` · FEELS ${Math.round(current.feelsLikeF)}°` : ''}`.trim()
    : undefined
  /**
   * Where those conditions are for.
   *
   * Its own line rather than appended to the conditions string, which is already at the width the
   * header gives it. It is also the more stable of the two — the temperature changes hourly and the
   * town does not — so putting them on one line would have the place jumping about as the numbers
   * either side of it changed length.
   *
   * Absent until the first refresh names it, and absent for a point NWS cannot name. The header then
   * looks exactly as it did before, which is the right fallback: nothing here is worth showing a
   * coordinate for.
   */
  const place = weather?.place?.label

  return (
    <ScreenShell
      banner={
        bannerAlert && (
          <AlertBanner
            title={alertHeadline(bannerAlert)}
            detail={bannerAlert.message}
            severe={bannerAlert.severity === 'Severe'}
            onClick={() => navigate(alertTarget(bannerAlert.source))}
          />
        )
      }
      header={
        <DashboardHeader
          clock={time}
          ampm={ampm}
          date={date}
          conditions={conditions}
          place={place}
          offline={reconnecting || (weatherOffline && !current)}
          profileInitial={activeProfile?.initial ?? '?'}
          onSwitchProfile={() => navigate('/lock')}
        />
      }
      fixedContent
    >
      <div className="ml-dash">
        <SectionLabel
          label="Needs you"
          status={
            needs.length === 0
              ? undefined
              : <span className={anyHard ? 'ml-needs__count--bad' : 'ml-needs__count--warn'}>
                  {`${needs.length} ${needs.length === 1 ? 'thing' : 'things'}`}
                </span>
          }
        />
        {needsPreview.length === 0 ? (
          // The quiet state. One line, verdigris, no dot and no tag — the screen gets calmer, not
          // emptier, and a household that reads ALL WELL every day learns to trust the block on the
          // day it says something else.
          <div className="ml-needs__well">All well</div>
        ) : (
          needsPreview.map((row) => <NeedsRowLine key={row.key} row={row} onClick={() => navigate(row.target)} />)
        )}
        {needsHidden > 0 && (
          <button type="button" className="ml-needs__more" onClick={() => navigate('/notifications')}>
            {`＋ ${needsHidden} more ▸`}
          </button>
        )}

        <SectionLabel
          label="Next"
          status={upcoming.length === 0 ? 'No engagements' : `${upcoming.length} ${upcoming.length === 1 ? 'engagement' : 'engagements'}`}
        />
        {nextPreview.length === 0 ? (
          <LedgerRow
            title={<span style={{ color: 'var(--text-muted)' }}>Nothing scheduled</span>}
            sub="Tap to add an engagement"
            onClick={() => navigate('/calendar/new')}
          />
        ) : (
          nextPreview.map((e, i) => (
            <NextRow key={e.id} event={e} hero={i === 0} onClick={() => navigate(`/calendar/edit/${e.id}`)} />
          ))
        )}
        {nextHidden > 0 && (
          <LedgerRow
            title={<span className="ml-linkadd">{`＋ ${nextHidden} more ▸`}</span>}
            onClick={() => navigate('/calendar')}
          />
        )}

        {/* TONIGHT was inside NEXT because dinner is the nearest scheduled thing. With a section of
            its own it no longer has to borrow that framing. */}
        <TonightBlock />

        <CareBlock />

        {/* The house pins to the bottom, however much the exception block above it holds. It had
            the Attendant's invitation stacked under it until ASSIST returned to the bar — one
            invitation, not two (NAV.md). */}
        <div className="ml-dash__foot">
          <HouseBlock
            zone={climateZone}
            rooms={zones}
            stale={stale}
            well={alerts.every((a) => a.type !== 'sensor' && a.type !== 'climate')}
            onOpen={() => navigate('/climate')}
            onStep={(d) => {
              if (climateZone?.standingTargetF == null) return
              void setTarget(climateZone.id, Math.round(climateZone.standingTargetF) + d)
            }}
          />
        </div>
      </div>
    </ScreenShell>
  )
}

/** One NEEDS YOU row: state dot, section tag in the left margin, the problem, an age or an action. */
function NeedsRowLine({ row, onClick }: { row: NeedsRow; onClick: () => void }) {
  return (
    <button type="button" className={`ml-needs__row ml-needs__row--${row.tone}`} onClick={onClick}>
      <span className="ml-needs__dot" aria-hidden="true" />
      <span className="ml-needs__tag">{row.tag}</span>
      <span className="ml-needs__problem">{row.problem}</span>
      <span className="ml-needs__right">{row.right}</span>
    </button>
  )
}

/** NEXT event row: Marcellus time (hero = larger) + title + location sub (no day hint per spec 01). */
function NextRow({ event, hero, onClick }: { event: CalendarEventDto; hero: boolean; onClick: () => void }) {
  const start = formatTime(new Date(event.startUtc))
  const sub = event.location ?? ''
  return (
    <button className={'ml-row ml-row--flush ml-row--tappable ml-next' + (hero ? ' ml-next--hero' : '')} onClick={onClick} type="button">
      <span className="ml-next__time serif">
        {start.time}
        <span className="ml-next__ampm">{start.ampm}</span>
      </span>
      <div className="ml-row__main">
        <div className="ml-row__title">{event.title}</div>
        {sub && <div className="ml-row__sub">{sub}</div>}
      </div>
    </button>
  )
}

/**
 * TONIGHT — the meal, what it takes, and what it is missing.
 *
 * The right-hand status is the start-by time where there is one, because "cook at 7:30" is a thing
 * you can act on. A free-text night gets no chevron: there is nothing behind it to open.
 */
function TonightBlock() {
  const navigate = useNavigate()
  const { week, settings } = useMeals()
  const { grocery } = usePantry()
  const now = new Date(useNow(60_000))

  const today = todayKey()
  const all = entriesFor(week?.days.find((d) => d.date === today), 'Dinner')
  const entry = all[0]
  // The night's start-by is its *earliest* component, so an arrangement doesn't report the main
  // dish's clock while a side needed to be on twenty minutes earlier.
  const longest = all.reduce<number | null>(
    (max, e) => (e.totalMinutes != null && (max == null || e.totalMinutes > max) ? e.totalMinutes : max),
    null,
  )
  const timing = startBy(settings.dinnerTime, longest, now)

  const status = !entry
    ? undefined
    : timing
      ? (timing.lateBy > 0 ? 'Now' : `Cook at ${timing.start}`)
      : undefined

  /*
   * `FOR SIX · 40 MIN · LEMONS GOT`.
   *
   * The third part is what the grocery list has already ticked off *for tonight* — the one line on
   * the Dashboard where the Meals↔Pantry coupling is visible, and the reason Pantry is a segment of
   * Meals rather than a tab. Absent when nothing was ticked, rather than reading `0 GOT`.
   */
  const got = (grocery?.lines ?? []).filter(
    (l) => l.checkedAtUtc && l.provenance.some((p) => p.forDate === today),
  )
  const meta = [
    entry?.servingsOverride != null ? `FOR ${entry.servingsOverride}` : null,
    longest != null ? durationLabel(longest).toUpperCase() : null,
    got.length === 1 ? `${got[0].text.toUpperCase()} GOT` : got.length > 1 ? `${got.length} GOT` : null,
  ].filter(Boolean).join(' · ')

  return (
    <>
      <SectionLabel label="Tonight" status={status} />
      <div className="ml-tonightblock">
        <span className="ml-tonightblock__main">
          <span className="ml-tonightblock__meal">
            {entry ? (entry.freeText ?? entry.recipeTitle) : 'Nothing planned'}
          </span>
          {entry && meta && <span className="ml-tonightblock__meta">{meta}</span>}
        </span>
        {!entry ? (
          <button type="button" className="ml-tonightblock__link" onClick={() => navigate(`/meals/assign/${today}/Dinner`)}>
            Plan it
          </button>
        ) : entry.recipeId != null ? (
          <button type="button" className="ml-tonightblock__link" onClick={() => navigate(`/meals/recipes/${entry.recipeId}`)}>
            Recipe ▸
          </button>
        ) : null}
      </div>
    </>
  )
}

/**
 * CARE — Conrad's three numbers on one line.
 *
 * **Mika does not appear here.** Her faults reach the Dashboard through NEEDS YOU, which is the
 * whole point of that block: one channel for anything wrong, tagged by section. A second status
 * surface for one of the two subjects would put the household back to checking two places.
 */
function CareBlock() {
  const navigate = useNavigate()
  const { state } = useBaby()
  const { subjects } = useCareSubjects()
  const now = useNow(60_000)
  const conrad = subjects.find((s) => s.id === 'conrad')

  return (
    <>
      <SectionLabel
        label="Care"
        status={conrad ? `${conrad.name}${conrad.meta ? ` · ${conrad.meta}` : ''}` : undefined}
      />
      <div className="ml-careline">
        <Stat label="Bottle" value={sinceShort(state?.lastBottleUtc ?? null, now)} />
        <Stat label="Diaper" value={sinceShort(state?.lastDiaperUtc ?? null, now)} />
        <Stat label="Today" value={state?.feedsToday == null ? '—' : String(state.feedsToday)} unit="feeds" />
        <button type="button" className="ml-careline__link" onClick={() => navigate('/care?subject=conrad')}>
          Log ▸
        </button>
      </div>
    </>
  )
}

/** `3H 10M` / `40M` / `—`. Short because three of these share one line. */
function sinceShort(iso: string | null, now: number): string {
  if (!iso) return '—'
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.round(hours / 24)}d`
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <span className="ml-stat">
      <span className="ml-stat__label">{label}</span>
      <span className="ml-stat__value serif">
        {value}
        {unit && <span className="ml-stat__unit">{unit}</span>}
      </span>
    </span>
  )
}

/**
 * THE HOUSE — the climate strip, promoted from a one-line strip to a block and pinned to the bottom.
 *
 * **What was cut to make room:** the three-row per-room list, which duplicated this block six inches
 * below it while Climate remained a tab for per-room detail; and `WATCHING`, whose single lock row
 * could not earn a heading and now rides the roll-up line.
 *
 * The ± steppers survive the promotion — they were the one thing on the old strip you could actually
 * *do*, and a block that only reads would be a downgrade dressed as a promotion. What they move
 * changed with the Climate rework: they used to write a **set point**, which the control loop now
 * owns and would put back within ten minutes, so they write the room's **target** instead. Same two
 * taps, and now they last.
 */
function HouseBlock({
  zone, rooms, stale, well, onOpen, onStep,
}: {
  zone: ClimateZoneDto | null
  rooms: ZoneReadingDto[]
  stale: boolean
  well: boolean
  onOpen: () => void
  onStep: (delta: number) => void
}) {
  // Movable means there is a target to move. A paused room, or one whose probe has gone quiet, is
  // still worth reading here — it is just not worth offering to change from the home screen.
  const movable = zone != null && zone.standingTargetF != null && !zone.isPaused && zone.readingF != null
  const target = zone?.standingTargetF == null ? null : Math.round(zone.standingTargetF)
  const doing = !zone
    ? 'Not connected'
    : zone.isPaused
      ? 'Paused'
      : zone.state === 'probeLost'
        ? 'Probe silent'
        : target == null
          ? 'Watched'
          : zone.state === 'correcting' || zone.state === 'cantHold'
            ? `${zone.above ? 'cooling' : 'warming'} to ${target}°`
            : `holding ${target}°`

  // The other rooms, rolled up rather than listed. Two names, because a third pushes the line past
  // the panel's width at 10px and the tab exists for the full list.
  const rollup = rooms
    .filter((r) => r.name !== zone?.name)
    .slice(0, HOUSE_ROLLUP)
    .map((r) => `${r.name.toUpperCase()} ${r.tempF == null ? '—' : `${Math.round(r.tempF)}°`}`)
    .join(' · ')

  return (
    <div className="ml-house">
      <div className="ml-house__head">
        <span className="ml-house__glyph" aria-hidden="true"><Icon id="ico-climate" size="1.0625rem" /></span>
        <span className="ml-house__label">The house</span>
        <span className={'ml-house__state' + (well ? ' ml-house__state--well' : ' ml-house__state--check')}>
          {well ? 'All systems well' : 'Check readings'}
        </span>
      </div>
      <div className="ml-house__body">
        <button type="button" className={'ml-house__reading' + (stale ? ' ml-stale' : '')} onClick={onOpen}>
          {/* The probe, not the unit's return-air reading — the number the loop actually controls
              against, and the only one that is the temperature of the room. */}
          <span className="ml-house__temp serif">
            {zone?.readingF == null ? '—' : `${Math.round(zone.readingF)}°`}
          </span>
          <span className="ml-house__main">
            <span className="ml-house__doing">{zone ? `${zone.name} · ${doing}` : 'No climate zone'}</span>
            {rollup && <span className="ml-house__rollup">{rollup}</span>}
          </span>
        </button>
        <div className="ml-house__steppers">
          <Stepper direction="minus" onStep={() => onStep(-1)} label="Lower the target" disabled={!movable} />
          <Stepper direction="plus" onStep={() => onStep(1)} label="Raise the target" disabled={!movable} />
        </div>
        <button type="button" className="ml-house__chev" onClick={onOpen} aria-label="Open Climate">›</button>
      </div>
    </div>
  )
}
