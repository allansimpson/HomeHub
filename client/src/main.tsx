import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import './components/ledger.css'
// Its own file rather than another 1,500 lines on the end of ledger.css: the Meals section is
// self-contained, and keeping it separate makes it obvious which rules belong to it.
import './components/meals.css'
// Same reasoning again for Pantry — and it reuses the Meals palette without adding a token, so the
// separation costs nothing but keeps each section's rules findable.
import './components/pantry.css'
import { App } from './app/App'
import { ConnectionProvider } from './app/ConnectionProvider'
import { SessionProvider } from './app/SessionProvider'
import { SensorsProvider } from './app/SensorsProvider'
import { WeatherProvider } from './app/WeatherProvider'
import { CalendarProvider } from './app/CalendarProvider'
import { TasksProvider } from './app/TasksProvider'
import { ClimateProvider } from './app/ClimateProvider'
import { BabyProvider } from './app/BabyProvider'
import { LitterProvider } from './app/LitterProvider'
import { MealsProvider } from './app/MealsProvider'
import { PantryProvider } from './app/PantryProvider'
import { NotificationsProvider } from './app/NotificationsProvider'
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
                    <BabyProvider>
                      <LitterProvider>
                        {/* Inside WriteQueueProvider: plan edits are optimistic and queue when the
                            panel is offline, so the section needs `run` to exist above it. */}
                        <MealsProvider>
                          {/* Inside MealsProvider: the stock check reads the week to work out
                              which night "move it" lands on, and the receipt is reached from the
                              Meals confirm. Pantry depends on Meals; Meals never depends on
                              Pantry, which is what keeps the pantry advisory. */}
                          <PantryProvider>
                            {/* Inside SensorsProvider: the notification store is seeded from the alert
                                feed that provider already polls. */}
                            <NotificationsProvider>
                              <VoiceProvider>
                                <App />
                              </VoiceProvider>
                            </NotificationsProvider>
                          </PantryProvider>
                        </MealsProvider>
                      </LitterProvider>
                    </BabyProvider>
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
