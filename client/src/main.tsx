import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import './components/ledger.css'
import { App } from './app/App'
import { SessionProvider } from './app/SessionProvider'
import { SensorsProvider } from './app/SensorsProvider'
import { WeatherProvider } from './app/WeatherProvider'
import { CalendarProvider } from './app/CalendarProvider'
import { TasksProvider } from './app/TasksProvider'
import { ClimateProvider } from './app/ClimateProvider'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <SensorsProvider>
          <WeatherProvider>
            <CalendarProvider>
              <TasksProvider>
                <ClimateProvider>
                  <App />
                </ClimateProvider>
              </TasksProvider>
            </CalendarProvider>
          </WeatherProvider>
        </SensorsProvider>
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
)
