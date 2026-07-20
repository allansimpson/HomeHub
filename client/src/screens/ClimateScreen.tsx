import { useNavigate } from 'react-router-dom'
import { DrillInHeader, ScreenShell, ScrollArea, EmptyState } from '../components'

/** Climate section (nav). Multi-zone control via Home Assistant wired in Stage 6. */
export function ClimateScreen() {
  const navigate = useNavigate()
  return (
    <ScreenShell header={<DrillInHeader title="Climate" status="Not connected" onBack={() => navigate('/')} />}>
      <ScrollArea>
        <EmptyState label="No zones" hint="Home Assistant climate connects in Stage 6." />
      </ScrollArea>
    </ScreenShell>
  )
}
