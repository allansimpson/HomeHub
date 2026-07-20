import { useNavigate } from 'react-router-dom'
import { DashboardHeader, ScreenShell, SectionLabel, LedgerRow } from '../components'
import { useClock } from '../app/useClock'

/**
 * Dashboard — home AND idle screen. Never scrolls. Stage 0 wires the live clock and the
 * ledger structure with empty states; sensors (S2), weather (S3), calendar (S4), tasks (S5)
 * and the climate strip (S6) fill these sections in later stages.
 */
export function DashboardScreen() {
  const { time, date } = useClock()
  const navigate = useNavigate()

  return (
    <ScreenShell header={<DashboardHeader clock={time} date={date} />} fixedContent>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <SectionLabel label="Next" status="No engagements" />
        <LedgerRow
          major
          title={<span style={{ color: 'var(--text-muted)' }}>Nothing scheduled</span>}
          sub="Calendar connects in a later stage"
          onClick={() => navigate('/calendar')}
        />

        <SectionLabel label="The House" status="No readings yet" />
        <LedgerRow
          major
          title={<span style={{ color: 'var(--text-muted)' }}>No sensors yet</span>}
          sub="Sensor zones appear once connected"
          onClick={() => navigate('/sensor')}
        />

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
