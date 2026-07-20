import { useNavigate } from 'react-router-dom'
import { DashboardHeader, ScreenShell, SectionLabel, LedgerRow, AlertBanner } from '../components'
import { useClock } from '../app/useClock'
import { useSession } from '../app/SessionProvider'
import { useSensors } from '../app/SensorsProvider'
import { useWeather } from '../app/WeatherProvider'
import { useCalendar } from '../app/CalendarProvider'
import { useTasks } from '../app/TasksProvider'
import { formatTime } from '../app/dates'
import type { ZoneReadingDto, CalendarEventDto, TaskItemDto, ProfileDto } from '../api/types'

/** Rooms shown before the dashboard collapses the rest into an "ALL N ROOMS" link (no-scroll). */
const HOUSE_PREVIEW = 3
/** Events shown before the NEXT section collapses the rest into a "+N MORE" link (no-scroll). */
const NEXT_PREVIEW = 2
/** Open tasks shown before the TASKS section collapses the rest. */
const TASKS_PREVIEW = 3

/** Route an alert source ("sensor:3", "weather") to its screen. */
function alertTarget(source: string): string {
  const [kind, id] = source.split(':')
  if (kind === 'weather') return '/weather'
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
  const { activeProfile, profiles } = useSession()
  const { zones, alerts } = useSensors()
  const { weather, offline: weatherOffline } = useWeather()
  const { upcoming } = useCalendar()
  const { tasks } = useTasks()

  const nextPreview = upcoming.slice(0, NEXT_PREVIEW)
  const nextHidden = upcoming.length - nextPreview.length

  const openTasks = tasks.filter((t) => !t.completed)
  const tasksPreview = openTasks.slice(0, TASKS_PREVIEW)
  const tasksHidden = openTasks.length - tasksPreview.length
  const doneCount = tasks.filter((t) => t.completed).length

  const topAlert = alerts[0]
  const preview = zones.slice(0, HOUSE_PREVIEW)
  const hidden = zones.length - preview.length
  const houseWell = alerts.every((a) => a.type !== 'sensor')

  const current = weather?.current
  const conditions = current?.tempF != null
    ? `${Math.round(current.tempF)}° ${(current.condition ?? '').toUpperCase()}${current.feelsLikeF != null ? ` · FEELS ${Math.round(current.feelsLikeF)}°` : ''}`.trim()
    : undefined

  return (
    <ScreenShell
      header={
        <DashboardHeader
          clock={time}
          date={date}
          conditions={conditions}
          offline={weatherOffline && !current}
          profileInitial={activeProfile?.initial ?? '?'}
          onSwitchProfile={() => navigate('/lock')}
        />
      }
      fixedContent
    >
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {topAlert && (
          <AlertBanner
            title={topAlert.severity === 'Severe' ? 'Severe Alert' : 'Alert'}
            detail={topAlert.message}
            severe={topAlert.severity === 'Severe'}
            onClick={() => navigate(alertTarget(topAlert.source))}
          />
        )}

        <SectionLabel
          label="Next"
          status={upcoming.length === 0 ? 'No engagements' : `${upcoming.length} ${upcoming.length === 1 ? 'engagement' : 'engagements'}`}
        />
        {nextPreview.length === 0 ? (
          <LedgerRow
            major
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
          label="The House"
          status={houseWell ? 'All systems well' : 'Check readings'}
          statusLive={houseWell}
        />
        {preview.length === 0 ? (
          <LedgerRow
            major
            title={<span style={{ color: 'var(--text-muted)' }}>No readings yet</span>}
            sub="Sensor zones appear once connected"
            onClick={() => navigate('/sensor')}
          />
        ) : (
          preview.map((z) => <HouseRow key={z.id} zone={z} onClick={() => navigate(`/sensor?zone=${z.id}`)} />)
        )}
        {hidden > 0 && (
          <LedgerRow
            title={<span className="ml-linkadd">{`All ${zones.length} rooms ▸`}</span>}
            onClick={() => navigate('/sensor')}
          />
        )}

        <SectionLabel
          label="Tasks"
          status={tasks.length === 0 ? '—' : `${doneCount} of ${tasks.length} done`}
        />
        {tasksPreview.length === 0 ? (
          <LedgerRow
            major
            title={<span style={{ color: 'var(--text-muted)' }}>{tasks.length === 0 ? 'No tasks' : 'All done'}</span>}
            sub="Tap to add a task"
            onClick={() => navigate('/todo')}
          />
        ) : (
          tasksPreview.map((t) => <TaskLine key={t.id} task={t} profiles={profiles} onClick={() => navigate('/todo')} />)
        )}
        {tasksHidden > 0 && (
          <LedgerRow
            title={<span className="ml-linkadd">{`＋ ${tasksHidden} more ▸`}</span>}
            onClick={() => navigate('/todo')}
          />
        )}

        {/* Climate strip pinned to the bottom of the (non-scrolling) content. */}
        <div style={{ marginTop: 'auto' }}>
          <LedgerRow
            major
            title={<span className="label" style={{ fontSize: '0.6875rem', color: 'var(--brass)' }}>Climate</span>}
            sub={<span style={{ color: 'var(--text-muted)' }}>Not connected</span>}
            right={<span style={{ color: 'var(--text-disabled)' }}>—</span>}
            onClick={() => navigate('/climate')}
          />
        </div>
      </div>
    </ScreenShell>
  )
}

/** Relative-day hint for an event: Today / Tomorrow / weekday. */
function dayHint(start: Date): string {
  const now = new Date()
  const days = Math.round((new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime()
    - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  return start.toLocaleDateString('en-US', { weekday: 'long' })
}

/** NEXT event row: Marcellus time (hero = larger) + title + day/location sub. */
function NextRow({ event, hero, onClick }: { event: CalendarEventDto; hero: boolean; onClick: () => void }) {
  const start = formatTime(new Date(event.startUtc))
  const sub = [dayHint(new Date(event.startUtc)), event.location].filter(Boolean).join(' · ')
  return (
    <button className={'ml-row ml-row--major ml-row--tappable ml-next' + (hero ? ' ml-next--hero' : '')} onClick={onClick} type="button">
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

/** One task line: owner chip + title. */
function TaskLine({ task, profiles, onClick }: { task: TaskItemDto; profiles: ProfileDto[]; onClick: () => void }) {
  const owner = profiles.find((p) => p.id === task.profileId)
  return (
    <button className="ml-row ml-row--major ml-row--tappable" onClick={onClick} type="button">
      {owner && <span className="ml-ownerchip" style={{ flex: '0 0 auto' }}>{owner.initial}</span>}
      <div className="ml-row__main">
        <div className="ml-row__title" style={{ color: 'var(--text-secondary)' }}>{task.title}</div>
      </div>
    </button>
  )
}

/** One room row: name left; humidity + big temp right. */
function HouseRow({ zone, onClick }: { zone: ZoneReadingDto; onClick: () => void }) {
  return (
    <button className="ml-row ml-row--tappable" onClick={onClick} type="button">
      <div className="ml-row__main">
        <div className="ml-row__title" style={{ color: 'var(--text-secondary)' }}>{zone.name}</div>
      </div>
      <div className="ml-house__reading">
        <span className="ml-house__humidity">{zone.humidity == null ? '—' : `${Math.round(zone.humidity)}%`}</span>
        <span className="ml-house__temp serif">{zone.tempF == null ? '—' : `${Math.round(zone.tempF)}°`}</span>
      </div>
    </button>
  )
}
