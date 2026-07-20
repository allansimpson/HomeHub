import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import './components/ledger.css'
import { App } from './app/App'
import { ConnectionProvider } from './app/ConnectionProvider'
import { SessionProvider } from './app/SessionProvider'
import { SensorsProvider } from './app/SensorsProvider'
import { WeatherProvider } from './app/WeatherProvider'
import { CalendarProvider } from './app/CalendarProvider'
import { TasksProvider } from './app/TasksProvider'
import { ClimateProvider } from './app/ClimateProvider'
import { VoiceProvider } from './app/VoiceProvider'
import { WriteQueueProvider } from './app/WriteQueueProvider'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ConnectionProvider>
      <SessionProvider>
        <SensorsProvider>
          <WeatherProvider>
            <WriteQueueProvider>
              <CalendarProvider>
                <TasksProvider>
                  <ClimateProvider>
                    <VoiceProvider>
                      <App />
                    </VoiceProvider>
                  </ClimateProvider>
                </TasksProvider>
              </CalendarProvider>
            </WriteQueueProvider>
          </WeatherProvider>
        </SensorsProvider>
      </SessionProvider>
      </ConnectionProvider>
    </BrowserRouter>
  </StrictMode>,
)
