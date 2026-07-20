import { useNavigate } from 'react-router-dom'
import { DrillInHeader, ScreenShell, EmptyState } from '../components'

/** Assistant section (nav). Idle shows MIC OFF; text (S7) then voice (S8) wire it up. */
export function AssistantScreen() {
  const navigate = useNavigate()
  return (
    <ScreenShell header={<DrillInHeader title="Assistant" status="Mic off" onBack={() => navigate('/')} />}>
      <EmptyState label="Tap to speak" hint="The assistant connects in Stage 7 (text) and Stage 8 (voice)." />
    </ScreenShell>
  )
}
