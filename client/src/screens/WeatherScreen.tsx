import { useNavigate } from 'react-router-dom'
import { DrillInHeader, ScreenShell, ScrollArea, EmptyState } from '../components'

/** Weather section (nav). Current/forecast + severe-alert banner wired in Stage 3. */
export function WeatherScreen() {
  const navigate = useNavigate()
  return (
    <ScreenShell header={<DrillInHeader title="Weather" status="—" onBack={() => navigate('/')} />}>
      <ScrollArea>
        <EmptyState label="No forecast" hint="NWS weather connects in Stage 3." />
      </ScrollArea>
    </ScreenShell>
  )
}
