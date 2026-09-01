import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import './components/ledger.css'
// Its own file rather than another 1,500 lines on the end of ledger.css: the Meals section is
// self-contained, and keeping it separate makes it obvious which rules belong to it.
import './components/meals.css'
// Same reasoning again for Pantry — and it reuses the Meals palette without adding a token, so the
// separation costs nothing but keeps each section's rules findable.
import './components/pantry.css'
// And again for Care — one tab, two subjects, and a switcher/tile/fault vocabulary that belongs to
// neither of the screens it merged.
import './components/care.css'
import './components/kitchen.css'
// Assist — the chat system. The inbox rows, the transcript and the composer. Its own file because
// Assist is a section now rather than an overlay, and because the row it draws is the ledger row
// plus a preview line and a badge: close enough to want to sit next to ledger.css, different enough
// that folding it in would make both harder to read.
import './components/assist.css'
// And the reworked Dashboard: NEEDS YOU, TONIGHT, CARE, THE HOUSE and the Attendant's invitation.
import './components/dashboard.css'
// And Climate — the deviation band, the press-and-slide gesture and the room drill-in. Its own file
// for the same reason as the rest, and one more: the band and the slider are the same strip of screen
// on two different scales, and the rules that keep them apart want to be read together.
import './components/climate.css'
import { installRemScale } from './app/remScale'
import { installBackGuard } from './app/backGuard'
import { restoreLastTab } from './app/lastTab'
import { registerServiceWorker } from './app/registerServiceWorker'
import { App } from './app/App'
import { UpdateProvider } from './app/UpdateProvider'
import { ConnectionProvider } from './app/ConnectionProvider'
import { PrivateSession } from './app/PrivateSession'
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
import { AssistProvider } from './app/AssistProvider'
import { WriteQueueProvider } from './app/WriteQueueProvider'

// Before the first render, so nothing is ever painted at a scale that is about to change. Never torn
// down — the scale outlives the React tree, and the app is the page.
installRemScale()

// Before the router reads the address, so a phone relaunched by Android after being killed in the
// background starts on the tab it was on rather than flashing the dashboard first. No-op on the
// wall panel, and on any launch that was aimed somewhere specific. See `lastTab.ts`.
restoreLastTab()

// Before the router mounts, and that ordering is the whole point: this listener has to run ahead of
// React Router's own so it can correct the history before anything reads it, or an absorbed swipe
// paints the wrong tab for a frame on its way back. See `backGuard.ts`.
// After `restoreLastTab`, so its first snapshot is the address the app actually starts on.
installBackGuard()

// The offline launch, for the next time rather than this one — it defers itself to `load`. The Care
// tab's own store is what makes that launch worth anything: a shell with no log in it would open to
// an empty night. See `careOffline.ts`.
registerServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      {/* Outermost of the data providers, and answerable to none of them: whether a newer panel is
          being served is a fact about the server's files rather than about the household, and the
          plate has to be able to appear on a panel where every other feed has failed. */}
      <UpdateProvider>
      <ConnectionProvider>
      <SessionProvider>
        {/* Above the gate: queued offline writes have to outlive a lock and a profile remount, or a
            member who wrote three feeds out of range and then locked the panel would lose them.
            `SessionProvider` sets the queue's identity, so it drains for a confirmed profile only. */}
        <WriteQueueProvider>
        {/* Everything below is private and session-bound — see `PrivateSession`. Locking unmounts it
            entire, which is what stops eleven providers polling rather than merely hiding them. */}
        <PrivateSession>
          <SensorsProvider>
            <WeatherProvider>
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
                                {/* Inside VoiceProvider: Assist is the surface the mic opens onto,
                                    and the wake word navigates here from any screen.
                                    Above App rather than inside the Assist route, because the
                                    bottom nav badges unread from every screen — the count has to
                                    exist when the tab is not the one you are looking at. */}
                                <AssistProvider>
                                  <App />
                                </AssistProvider>
                              </VoiceProvider>
                            </NotificationsProvider>
                          </PantryProvider>
                        </MealsProvider>
                      </LitterProvider>
                    </BabyProvider>
                  </ClimateProvider>
                </TasksProvider>
              </CalendarProvider>
            </WeatherProvider>
          </SensorsProvider>
        </PrivateSession>
        </WriteQueueProvider>
      </SessionProvider>
      </ConnectionProvider>
      </UpdateProvider>
    </BrowserRouter>
  </StrictMode>,
)
