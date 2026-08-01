import { useNavigate } from 'react-router-dom'
import { DashboardHeader, ScreenShell, SectionLabel, LedgerRow, AlertBanner } from '../components'
import { useClock } from '../app/useClock'
import { useSession } from '../app/SessionProvider'
import { useSensors } from '../app/SensorsProvider'
import { useWeather } from '../app/WeatherProvider'
import { useCalendar } from '../app/CalendarProvider'
import { useTasks } from '../app/TasksProvider'
import { useClimate } from '../app/ClimateProvider'
import { useConnection } from '../app/ConnectionProvider'
import { useMeals } from '../app/MealsProvider'
import { Stepper } from '../components'
import { Icon } from '../icons/Icon'
import { formatTime } from '../app/dates'
import { entryFor, startBy, todayKey } from '../app/mealsDomain'
import type { ZoneReadingDto, CalendarEventDto, TaskItemDto, ClimateZoneDto } from '../api/types'

/** Rooms shown before the dashboard collapses the rest into an "ALL N ROOMS" link (no-scroll). */
const HOUSE_PREVIEW = 3
/** Events shown before the NEXT section collapses the rest into a "+N MORE" link (no-scroll). */
const NEXT_PREVIEW = 2
/** Open tasks shown before the TASKS section collapses the rest. */
const TASKS_PREVIEW = 3

/**
 * Route an alert source ("sensor:3", "weather", "cat:litter_robot_4") to its screen.
 *
 * `cat:` is handled explicitly. It used to fall through to the trailing `/sensor` default, so
 * tapping a Litter-Robot alert on the dashboard opened the sensor history — a screen with nothing
 * on it about the robot that raised the banner.
 */
function alertTarget(source: string): string {
  const [kind, id] = source.split(':')
  if (kind === 'weather') return '/weather'
  if (kind === 'cat') return '/litter'
  return kind === 'sensor' && id ? `/sensor?zone=${id}` : '/sensor'
}

/**
 * Dashboard — home AND idle screen. Never scrolls: THE HOUSE shows the first few rooms and
 * collapses the rest into a brass ledger link. Sensor readings + alerts are live (Stage 2);
 * calendar (S4), tasks (S5) and the climate strip (S6) fill the other sections later.
 */
export function DashboardScreen() {
  const { time, date } = useClock()
  const navigate = useNavigate()
  const { activeProfile } = useSession()
  const { zones, alerts } = useSensors()
  const { weather, offline: weatherOffline } = useWeather()
  const { upcoming } = useCalendar()
  const { tasks } = useTasks()
  const { zones: climateZones, adjustSetPoint } = useClimate()
  const { online, stale } = useConnection()

  // The dashboard strip controls the Living Room zone (or the first zone).
  const climateZone = climateZones.find((z) => z.name === 'Living Room') ?? climateZones[0] ?? null

  const nextPreview = upcoming.slice(0, NEXT_PREVIEW)
  const nextHidden = upcoming.length - nextPreview.length

  // TASKS DUE (spec 01): only due-dated open tasks, sorted by urgency (overdue → today → soonest).
  const dueTasks = tasks
    .filter((t) => !t.completed && t.dueUtc)
    .sort((a, b) => new Date(a.dueUtc as string).getTime() - new Date(b.dueUtc as string).getTime())
  const overdueCount = dueTasks.filter((t) => isOverdue(t.dueUtc as string)).length
  const tasksPreview = dueTasks.slice(0, TASKS_PREVIEW)
  const tasksHidden = dueTasks.length - tasksPreview.length

  /**
   * The most serious active alert — severe first, otherwise whatever else is raised.
   *
   * This was narrowed to severe-only on the premise that everything else "arrives as a notification"
   * instead. That premise is not true yet: only Baby and the Litter recovery loop call
   * `NotificationService.RecordAsync`, and nothing converts sensor, climate or weather alerts into
   * notifications at all. Four of the five seeded thresholds raise at *warning* severity, so the
   * narrowing left the freezer warming up with no surface on the home screen whatsoever.
   *
   * Revert this to severe-only once an alert→notification bridge actually exists — at which point
   * the original reasoning (banner plus card says the same thing twice) becomes correct.
   */
  const topAlert = alerts.find((a) => a.severity === 'Severe') ?? alerts[0]
  const preview = zones.slice(0, HOUSE_PREVIEW)
  const hidden = zones.length - preview.length
  const houseWell = alerts.every((a) => a.type !== 'sensor')

  const current = weather?.current
  const conditions = current?.tempF != null
    ? `${Math.round(current.tempF)}° ${(current.condition ?? '').toUpperCase()}${current.feelsLikeF != null ? ` · FEELS ${Math.round(current.feelsLikeF)}°` : ''}`.trim()
    : undefined

  return (
    <ScreenShell
      banner={
        topAlert && (
          <AlertBanner
            // The title and the hazard stripe follow the alert, rather than asserting "Severe" over
            // a warning — the stripe is what marks the difference between the two at a glance.
            title={topAlert.severity === 'Severe' ? 'Severe Alert' : 'Alert'}
            detail={topAlert.message}
            severe={topAlert.severity === 'Severe'}
            onClick={() => navigate(alertTarget(topAlert.source))}
          />
        )
      }
      header={
        <DashboardHeader
          clock={time}
          date={date}
          conditions={conditions}
          offline={!online || (weatherOffline && !current)}
          profileInitial={activeProfile?.initial ?? '?'}
          onSwitchProfile={() => navigate('/lock')}
        />
      }
      fixedContent
    >
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <SectionLabel
          tick={false}
          label="Next"
          status={upcoming.length === 0 ? 'No engagements' : `${upcoming.length} ${upcoming.length === 1 ? 'engagement' : 'engagements'}`}
        />
        {/* Tonight sits at the top of NEXT (MEALS_SCREEN §12): on a wall panel at 17:00, dinner is
            the nearest thing on the schedule, and it is the one row people walk over to read. */}
        <TonightRow />
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

        <SectionLabel
          tick={false}
          label="The House"
          status={houseWell ? 'All systems well' : 'Check readings'}
          statusLive={houseWell}
        />
        {preview.length === 0 ? (
          <LedgerRow
            title={<span style={{ color: 'var(--text-muted)' }}>No readings yet</span>}
            sub="Sensor zones appear once connected"
            onClick={() => navigate('/sensor')}
          />
        ) : (
          preview.map((z) => <HouseRow key={z.id} zone={z} stale={stale} onClick={() => navigate(`/sensor?zone=${z.id}`)} />)
        )}
        {hidden > 0 && (
          <LedgerRow
            title={<span className="ml-linkadd">{`All ${zones.length} rooms ▸`}</span>}
            onClick={() => navigate('/sensor')}
          />
        )}

        <SectionLabel
          tick={false}
          label="Tasks Due"
          status={dueTasks.length === 0 ? 'Nothing due' : `${dueTasks.length} due${overdueCount > 0 ? ` · ${overdueCount} overdue` : ''}`}
        />
        {tasksPreview.length === 0 ? (
          <LedgerRow
            title={<span style={{ color: 'var(--text-muted)' }}>Nothing due</span>}
            sub="Tap to open your lists"
            onClick={() => navigate('/todo')}
          />
        ) : (
          tasksPreview.map((t) => <TaskDueLine key={t.id} task={t} onClick={() => navigate('/todo')} />)
        )}
        {tasksHidden > 0 && (
          <LedgerRow
            title={<span className="ml-linkadd">{`＋ ${tasksHidden} more ▸`}</span>}
            onClick={() => navigate('/todo')}
          />
        )}

        {/* Climate strip pinned to the bottom of the (non-scrolling) content. */}
        <div style={{ marginTop: 'auto' }}>
          <ClimateStrip zone={climateZone} stale={stale} onOpen={() => navigate('/climate')} onStep={(d) => climateZone && adjustSetPoint(climateZone.id, d)} />
        </div>
      </div>
    </ScreenShell>
  )
}

/** Whole-day difference from today (negative = past). */
function daysFromToday(d: Date): number {
  const now = new Date()
  return Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000)
}

/** A due date is overdue once its calendar day is before today. */
function isOverdue(dueUtc: string): boolean {
  return daysFromToday(new Date(dueUtc)) < 0
}

/** Urgency label + class stem for a due date: OVERDUE / TODAY / weekday. */
function dueUrgency(dueUtc: string): { label: string; kind: 'overdue' | 'today' | 'upcoming' } {
  const days = daysFromToday(new Date(dueUtc))
  if (days < 0) return { label: 'Overdue', kind: 'overdue' }
  if (days === 0) return { label: 'Today', kind: 'today' }
  return { label: new Date(dueUtc).toLocaleDateString('en-US', { weekday: 'short' }), kind: 'upcoming' }
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
 * The dashboard's TONIGHT row (MEALS_SCREEN §12).
 *
 * Right-hand value is the start-by time where there is one and the duration otherwise, because
 * "start at 17:55" is a thing you can act on and "45 min" is only a thing you can plan around.
 * A free-text night renders its text with no chevron — there is nothing behind it to open.
 */
function TonightRow() {
  const navigate = useNavigate()
  const { week, recipes, settings } = useMeals()

  const today = todayKey()
  const entry = entryFor(week?.days.find((d) => d.date === today), 'Dinner')
  const recipe = entry?.recipeId != null ? recipes.find((r) => r.id === entry.recipeId) : undefined
  const timing = startBy(settings.dinnerTime, recipe?.totalMinutes ?? null, new Date())

  if (!entry) {
    return (
      <button className="ml-row ml-row--flush ml-row--tappable ml-tonight" type="button" onClick={() => navigate('/meals')}>
        <span className="ml-tonight__glyph" aria-hidden="true"><Icon id="ico-meals" size="1.375rem" /></span>
        <div className="ml-row__main">
          <div className="ml-tonight__label">Tonight</div>
          <div className="ml-tonight__empty">Nothing planned</div>
        </div>
        <span className="ml-tonight__plan">PLAN IT</span>
      </button>
    )
  }

  const drills = entry.recipeId != null
  return (
    <button
      className="ml-row ml-row--flush ml-row--tappable ml-tonight"
      type="button"
      onClick={() => (drills ? navigate(`/meals/recipes/${entry.recipeId}`) : navigate('/meals'))}
    >
      <span className="ml-tonight__glyph" aria-hidden="true"><Icon id="ico-meals" size="1.375rem" /></span>
      <div className="ml-row__main">
        <div className="ml-tonight__label">Tonight</div>
        <div className="ml-row__title">{entry.freeText ?? entry.recipeTitle}</div>
      </div>
      {timing && (
        <span className="ml-tonight__time serif">
          {timing.lateBy > 0 ? 'NOW' : timing.start}
        </span>
      )}
      {drills && <span className="ml-tonight__chev" aria-hidden="true">›</span>}
    </button>
  )
}

/** Dashboard climate strip: tappable label (→ Climate) + working ± set-point steppers. */
function ClimateStrip({ zone, stale, onOpen, onStep }: { zone: ClimateZoneDto | null; stale: boolean; onOpen: () => void; onStep: (delta: number) => void }) {
  const running = zone?.running ?? false
  const status = !zone
    ? 'Not connected'
    : !running
      ? 'Off'
      : zone.setPointF != null && Math.round(zone.currentTempF) !== Math.round(zone.setPointF)
        ? `${zone.mode === 'Heat' ? 'Heating' : 'Cooling'} to ${zone.setPointF}°`
        : `Holding ${zone.setPointF}°`
  return (
    <div className="ml-row ml-climatestrip">
      <button type="button" className="ml-climatestrip__body" onClick={onOpen}>
        <span className="label ml-climatestrip__label">Climate · {zone?.name ?? '—'}</span>
        <span className={'ml-climatestrip__status' + (stale ? ' ml-stale' : '')}>
          {status}
          {running && zone?.setPointF != null && <span style={{ color: 'var(--brass-bright)' }}>{` ${zone.setPointF}°`}</span>}
        </span>
      </button>
      <div className="ml-climatestrip__steppers">
        <Stepper direction="minus" onStep={() => onStep(-1)} label="Lower set point" disabled={!running} />
        <Stepper direction="plus" onStep={() => onStep(1)} label="Raise set point" disabled={!running} />
      </div>
    </div>
  )
}

/** One TASKS DUE line: fixed-width urgency label + urgency dot + title (no owner chip — spec 01). */
function TaskDueLine({ task, onClick }: { task: TaskItemDto; onClick: () => void }) {
  const u = dueUrgency(task.dueUtc as string)
  return (
    <button className="ml-row ml-row--flush ml-row--tappable ml-taskdue" onClick={onClick} type="button">
      <span className={`ml-taskdue__when ml-taskdue__when--${u.kind}`}>{u.label}</span>
      <span className={`ml-taskdue__dot ml-taskdue__dot--${u.kind}`} aria-hidden="true" />
      <div className="ml-row__main">
        <div className="ml-row__title" style={{ color: 'var(--text-secondary)' }}>{task.title}</div>
      </div>
    </button>
  )
}

/** One room row: name left; humidity + big temp right. */
function HouseRow({ zone, stale, onClick }: { zone: ZoneReadingDto; stale: boolean; onClick: () => void }) {
  return (
    <button className="ml-row ml-row--tappable" onClick={onClick} type="button">
      <div className="ml-row__main">
        <div className="ml-row__title" style={{ color: 'var(--text-secondary)' }}>{zone.name}</div>
      </div>
      <div className={'ml-house__reading' + (stale ? ' ml-stale' : '')}>
        <span className="ml-house__humidity">{zone.humidity == null ? '—' : `${Math.round(zone.humidity)}%`}</span>
        <span className="ml-house__temp serif">{zone.tempF == null ? '—' : `${Math.round(zone.tempF)}°`}</span>
      </div>
    </button>
  )
}
