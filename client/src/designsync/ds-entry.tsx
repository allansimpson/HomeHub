/*
 * Design-system bundle entry — the seam between this app and claude.ai/design.
 *
 * `client/` is an application, not a published component library: there is no `dist/` of exported
 * components for the converter to read. This file is the library entry it would otherwise find.
 * It exists for /design-sync and is not imported by the running app.
 *
 * Three jobs, in the order the converter consumes them:
 *
 *  1. Pull in the stylesheets. esbuild bundles CSS reached from the JS entry into `_ds_bundle.css`,
 *     which is what every design built in Claude Design actually loads. The import ORDER below is
 *     main.tsx's, verbatim — cascade order is load order, so a divergence here restyles the panel.
 *     `index.css` carries `@import` of tokens.css and fonts.css, so those ride along.
 *  2. Re-export the component barrel — one `window.HomeHub.*` entry per component.
 *  3. Export `PreviewRoot`, the wrapper every preview card mounts inside (cfg.provider).
 *
 * Keep in lockstep with main.tsx: a provider added there is a provider a component may read here.
 */

import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'

import '../index.css'
import '../components/ledger.css'
import '../components/meals.css'
import '../components/pantry.css'
import '../components/care.css'
import '../components/attendant.css'
import '../components/dashboard.css'
import '../components/climate.css'

import { IconSprite } from '../icons/IconSprite'
import { ConnectionProvider } from '../app/ConnectionProvider'
import { SessionProvider } from '../app/SessionProvider'
import { SensorsProvider } from '../app/SensorsProvider'
import { WeatherProvider } from '../app/WeatherProvider'
import { WriteQueueProvider } from '../app/WriteQueueProvider'
import { CalendarProvider } from '../app/CalendarProvider'
import { TasksProvider } from '../app/TasksProvider'
import { ClimateProvider } from '../app/ClimateProvider'
import { BabyProvider } from '../app/BabyProvider'
import { LitterProvider } from '../app/LitterProvider'
import { MealsProvider } from '../app/MealsProvider'
import { PantryProvider } from '../app/PantryProvider'
import { NotificationsProvider } from '../app/NotificationsProvider'
import { VoiceProvider } from '../app/VoiceProvider'
import { AssistProvider } from '../app/AssistProvider'

export * from '../components'

/*
 * Hooks the overlay components are driven by. `NotificationDrawer` renders nothing until its
 * provider is opened, so without this its preview card would be blank — and a design built with the
 * DS has the same need, since it takes no `open` prop. Exported as hooks (camelCase), so the
 * converter never mistakes them for components.
 *
 * `useAttendant` is gone with the overlay: Assist is a routed screen now, so a preview renders it
 * directly rather than having to open something first. `useAssist` is exported for the conversation
 * list and the agent roster a chat mock needs.
 */
export { useAssist } from '../app/AssistProvider'
export { useNotifications } from '../app/NotificationsProvider'

/**
 * Mounts a component the way the panel does: the icon sprite, a router, and main.tsx's full
 * provider nesting. Several components read context transitively and throw without it — BottomNav
 * reaches Baby and Litter through `useCareSubjects`, AccountAvatar reads Session and Notifications
 * — so the whole chain is present rather than a guessed subset.
 *
 * Every provider degrades to an empty offline state when the API is unreachable, which is the
 * case in a preview card. Cards therefore render real chrome with empty data; realistic content
 * comes from the props each preview passes, not from the network.
 *
 * Two preview-only corrections, injected as a <style> so they land after index.css in document
 * order and win the cascade. Neither ships to designs built with the DS — those get the real app
 * behaviour, which is why the README documents the scaling rather than hiding it:
 *
 *  - `font-size: 16px` pins the root to the design's own reference (1rem = 16 mock-px on the
 *    540×960 canvas). index.css tracks the viewport instead — correct on a 4K portrait panel,
 *    but it collapses every card to a few unreadable pixels in a preview-sized frame.
 *  - The panel surface. This is a dark design with no light mode; on the browser's white default
 *    its low-contrast rules and muted text are invisible.
 */
const PREVIEW_STAGE = `
  :root { font-size: 16px; }
  html, body { background: var(--bg-screen); }
  .ds-preview-stage {
    min-height: 100%;
    background: var(--bg-screen);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-weight: var(--body-weight);
    width: 33.75rem;
    max-width: 100%;
    -webkit-font-smoothing: antialiased;
  }
`

export function PreviewRoot({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
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
                          <MealsProvider>
                            <PantryProvider>
                              <NotificationsProvider>
                                <VoiceProvider>
                                  <AssistProvider>
                                    <style>{PREVIEW_STAGE}</style>
                                    <IconSprite />
                                    <div className="ds-preview-stage">{children}</div>
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
              </WriteQueueProvider>
            </WeatherProvider>
          </SensorsProvider>
        </SessionProvider>
      </ConnectionProvider>
    </MemoryRouter>
  )
}
