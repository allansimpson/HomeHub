import { useNavigate } from 'react-router-dom'
import { DashboardHeader, ScreenShell, SectionLabel, LedgerRow, AlertBanner } from '../components'
import { useClock } from '../app/useClock'
import { useSession } from '../app/SessionProvider'
import { useSensors } from '../app/SensorsProvider'
import type { ZoneReadingDto } from '../api/types'

/** Rooms shown before the dashboard collapses the rest into an "ALL N ROOMS" link (no-scroll). */
const HOUSE_PREVIEW = 3

/** Route a "sensor:3"-style alert source to its screen. */
function alertTarget(source: string): string {
  const [kind, id] = source.split(':')
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

  const topAlert = alerts[0]
  const preview = zones.slice(0, HOUSE_PREVIEW)
  const hidden = zones.length - preview.length
  const houseWell = alerts.every((a) => a.type !== 'sensor')

  return (
    <ScreenShell
      header={
        <DashboardHeader
          clock={time}
          date={date}
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

        <SectionLabel label="Next" status="No engagements" />
        <LedgerRow
          major
          title={<span style={{ color: 'var(--text-muted)' }}>Nothing scheduled</span>}
          sub="Calendar connects in a later stage"
          onClick={() => navigate('/calendar')}
        />

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

        <SectionLabel label="Tasks" status="—" />
        <LedgerRow
          major
          title={<span style={{ color: 'var(--text-muted)' }}>No tasks</span>}
          sub="To-do connects in a later stage"
          onClick={() => navigate('/todo')}
        />

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
