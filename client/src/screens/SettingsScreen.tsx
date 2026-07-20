import { useNavigate } from 'react-router-dom'
import { DrillInHeader, ScreenShell, ScrollArea, EmptyState } from '../components'

/** Settings drill-in. Privacy/lock, alert thresholds, idle dimming wired from Stage 1. */
export function SettingsScreen() {
  const navigate = useNavigate()
  return (
    <ScreenShell header={<DrillInHeader title="Settings" status="Household" onBack={() => navigate(-1)} />}>
      <ScrollArea>
        <EmptyState label="No settings yet" hint="Profiles, PIN and thresholds arrive in Stage 1+." />
      </ScrollArea>
    </ScreenShell>
  )
}
