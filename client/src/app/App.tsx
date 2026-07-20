import { Routes, Route } from 'react-router-dom'
import { IconSprite } from '../icons/IconSprite'
import { MicLiveBanner } from '../components'
import { ScreenTransition } from './ScreenTransition'
import { DashboardScreen } from '../screens/DashboardScreen'
import { CalendarScreen } from '../screens/CalendarScreen'
import { ClimateScreen } from '../screens/ClimateScreen'
import { WeatherScreen } from '../screens/WeatherScreen'
import { AssistantScreen } from '../screens/AssistantScreen'
import { TodoScreen } from '../screens/TodoScreen'
import { SensorHistoryScreen } from '../screens/SensorHistoryScreen'
import { SettingsScreen } from '../screens/SettingsScreen'

export function App() {
  // Global mic state — wired in Stage 7+. The banner must appear on ANY screen when true.
  const micLive = false

  return (
    <>
      <IconSprite />
      <div className="app-root">
        {micLive && <MicLiveBanner />}
        <div className="app-viewport">
          <ScreenTransition>
            <Routes>
              <Route path="/" element={<DashboardScreen />} />
              <Route path="/calendar" element={<CalendarScreen />} />
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
        </div>
      </div>
    </>
  )
}
