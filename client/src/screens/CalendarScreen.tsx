import { useNavigate } from 'react-router-dom'
import { DrillInHeader, ScreenShell, ScrollArea, EmptyState } from '../components'

/** Calendar section (nav). Month grid + agenda wired in Stage 4. */
export function CalendarScreen() {
  const navigate = useNavigate()
  return (
    <ScreenShell header={<DrillInHeader title="Calendar" status="July 2026" onBack={() => navigate('/')} />}>
      <ScrollArea>
        <EmptyState label="No events" hint="Google Calendar connects in Stage 4." />
      </ScrollArea>
    </ScreenShell>
  )
}
