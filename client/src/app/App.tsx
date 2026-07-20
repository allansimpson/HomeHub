import { Routes, Route, useLocation } from 'react-router-dom'
import { IconSprite } from '../icons/IconSprite'
import { MicLiveBanner } from '../components'
import { ScreenTransition } from './ScreenTransition'
import { useSession } from './SessionProvider'
import { useVoice } from './VoiceProvider'
import { useConnection } from './ConnectionProvider'
import { useWriteQueue } from './WriteQueueProvider'
import { useIdleReset } from './useIdleReset'
import { useAmbient } from './useAmbient'
import { DashboardScreen } from '../screens/DashboardScreen'
import { CalendarScreen } from '../screens/CalendarScreen'
import { ClimateScreen } from '../screens/ClimateScreen'
import { WeatherScreen } from '../screens/WeatherScreen'
import { AssistantScreen } from '../screens/AssistantScreen'
import { TodoScreen } from '../screens/TodoScreen'
import { SensorHistoryScreen } from '../screens/SensorHistoryScreen'
import { SettingsScreen } from '../screens/SettingsScreen'
import { EventEditorScreen } from '../screens/EventEditorScreen'
import { LockScreen } from '../screens/LockScreen'

export function App() {
  // Global mic state (Stage 8): the banner must appear on ANY screen whenever the mic is open.
  const { micLive } = useVoice()

  const { locked, settings } = useSession()
  const { online } = useConnection()
  const { pendingCount, conflicts, resolveConflict } = useWriteQueue()
  const location = useLocation()
  useIdleReset()
  useAmbient(settings?.daylightBoost ?? 'auto')

  // The Lock screen is a gate, not a routed page: it takes over whenever the active profile
  // is locked (boot / idle) or the profile switcher (`/lock`) is open. On success it routes
  // back to the dashboard.
  const showLock = locked || location.pathname === '/lock'

  // Honest reconnecting state on every screen. The dashboard carries its own header chip
  // (design 01), so the app-level bar is shown on the other screens.
  const showReconnecting = !online && !showLock && location.pathname !== '/'

  return (
    <>
      <IconSprite />
      <div className="app-root">
        {micLive && <MicLiveBanner />}
        {showReconnecting && (
          <div className="ml-reconnect" role="status">
            <span className="ml-reconnect__dot" aria-hidden="true" />
            <span className="ml-reconnect__text">Reconnecting — showing last known</span>
          </div>
        )}
        {!showLock && conflicts.length > 0 && (
          <div className="ml-conflict" role="alert">
            <span className="ml-conflict__title">Sync conflict — changed on another device</span>
            {conflicts.map((c) => (
              <div key={c.op.id} className="ml-conflict__row">
                <span className="ml-conflict__label">{c.op.label}</span>
                <span className="ml-conflict__actions">
                  <button type="button" className="ml-linkbtn" onClick={() => resolveConflict(c.op.id, 'discard')}>Use server</button>
                  <button type="button" className="ml-linkbtn" onClick={() => resolveConflict(c.op.id, 'keep-mine')}>Keep mine</button>
                </span>
              </div>
            ))}
          </div>
        )}
        {!showLock && conflicts.length === 0 && pendingCount > 0 && (
          <div className="ml-queuebar" role="status">
            <span className="ml-queuebar__dot" aria-hidden="true" />
            <span className="ml-queuebar__text">{`${pendingCount} change${pendingCount === 1 ? '' : 's'} pending — will sync when back online`}</span>
          </div>
        )}
        <div className="app-viewport">
          {showLock ? (
            <LockScreen />
          ) : (
            <ScreenTransition>
              <Routes>
                <Route path="/" element={<DashboardScreen />} />
                <Route path="/calendar" element={<CalendarScreen />} />
                <Route path="/calendar/new" element={<EventEditorScreen />} />
                <Route path="/calendar/edit/:id" element={<EventEditorScreen />} />
                <Route path="/climate" element={<ClimateScreen />} />
                <Route path="/weather" element={<WeatherScreen />} />
                <Route path="/assistant" element={<AssistantScreen />} />
                <Route path="/todo" element={<TodoScreen />} />
                <Route path="/sensor" element={<SensorHistoryScreen />} />
                <Route path="/settings" element={<SettingsScreen />} />
                {/* Idle/unknown routes return to the dashboard (home + idle screen). */}
                <Route path="*" element={<DashboardScreen />} />
              </Routes>
            </ScreenTransition>
          )}
        </div>
      </div>
    </>
  )
}
