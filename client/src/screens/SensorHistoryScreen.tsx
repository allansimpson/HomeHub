import { useNavigate } from 'react-router-dom'
import { DrillInHeader, ScreenShell, ScrollArea, EmptyState } from '../components'

/** Sensor History drill-in (from a dashboard room row). Charts wired in Stage 2. */
export function SensorHistoryScreen() {
  const navigate = useNavigate()
  return (
    <ScreenShell
      header={<DrillInHeader title="Sensor History" status="24 hours" onBack={() => navigate(-1)} />}
    >
      <ScrollArea>
        <EmptyState label="No readings yet" hint="Sensor zones and history are added in Stage 2." />
      </ScrollArea>
    </ScreenShell>
  )
}
