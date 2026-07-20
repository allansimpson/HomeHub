import { useNavigate } from 'react-router-dom'
import { DrillInHeader, ScreenShell, ScrollArea, EmptyState } from '../components'

/** To-Do drill-in (from the dashboard Tasks section). Wired to Microsoft To Do in Stage 5. */
export function TodoScreen() {
  const navigate = useNavigate()
  return (
    <ScreenShell header={<DrillInHeader title="Tasks" status="—" onBack={() => navigate(-1)} />}>
      <ScrollArea>
        <EmptyState label="No tasks" hint="Microsoft To Do connects in Stage 5." />
      </ScrollArea>
    </ScreenShell>
  )
}
