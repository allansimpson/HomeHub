import { Routes, Route, useLocation } from 'react-router-dom'
import { IconSprite } from '../icons/IconSprite'
import { MicLiveBanner } from '../components'
import { ScreenTransition } from './ScreenTransition'
import { useSession } from './SessionProvider'
import { useIdleReset } from './useIdleReset'
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
  // Global mic state — wired in Stage 7+. The banner must appear on ANY screen when true.
  const micLive = false

  const { locked } = useSession()
  const location = useLocation()
  useIdleReset()

  // The Lock screen is a gate, not a routed page: it takes over whenever the active profile
  // is locked (boot / idle) or the profile switcher (`/lock`) is open. On success it routes
  // back to the dashboard.
  const showLock = locked || location.pathname === '/lock'

  return (
    <>
      <IconSprite />
      <div className="app-root">
        {micLive && <MicLiveBanner />}
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
