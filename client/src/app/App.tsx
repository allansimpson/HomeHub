import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { Routes, Route, useLocation, type Location } from 'react-router-dom'
import { IconSprite } from '../icons/IconSprite'
import { MicLiveBanner } from '../components'
import { OnScreenKeyboard } from '../components/keyboard/OnScreenKeyboard'
import { NAV_SECTIONS } from './navConfig'
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

const SECTION_PATHS = new Set(NAV_SECTIONS.map((s) => s.path))

/** Which motion a route change gets: drilling into a deeper screen rises; backing out to a tab
 *  settles down; tab ↔ tab is a soft cross-fade. Drives the `data-vt` attribute the CSS reads. */
function directionFor(from: string, to: string): 'fade' | 'slideup' | 'slidedown' {
  const toSection = SECTION_PATHS.has(to)
  if (!toSection) return 'slideup' // into a drill-in (event editor, sensor history, config sub-page)
  if (!SECTION_PATHS.has(from)) return 'slidedown' // out of a drill-in, back to a tab
  return 'fade' // tab ↔ tab
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (cb: () => void) => { finished: Promise<void> }
}

export function App() {
  // Global mic state (Stage 8): the banner must appear on ANY screen whenever the mic is open.
  const { micLive } = useVoice()

  const { locked, settings } = useSession()
  const { online } = useConnection()
  const { pendingCount, conflicts, resolveConflict } = useWriteQueue()
  const location = useLocation()
  useIdleReset()
  useAmbient(settings?.daylightBoost ?? 'auto')

  // Smooth route motion via the View Transitions API (Chromium kiosk). The router location updates
  // at once, but the routed screens render against `displayed`, which we only advance *inside*
  // startViewTransition — the browser snapshots the old screen, we flush the new one, and it
  // cross-fades/slides between the two. Centralized here so every navigation animates with no
  // per-call wiring. Falls back to an instant swap where the API is absent or motion is reduced.
  const [displayed, setDisplayed] = useState<Location>(location)
  useEffect(() => {
    if (location.key === displayed.key) return
    const doc = document as ViewTransitionDocument
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (typeof doc.startViewTransition !== 'function' || reduce) {
      setDisplayed(location)
      return
    }
    const dir = directionFor(displayed.pathname, location.pathname)
    document.documentElement.dataset.vt = dir
    const transition = doc.startViewTransition(() => flushSync(() => setDisplayed(location)))
    void transition.finished.finally(() => {
      if (document.documentElement.dataset.vt === dir) delete document.documentElement.dataset.vt
    })
  }, [location, displayed])

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
            <div className="ml-transition">
              <Routes location={displayed}>
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
                <Route path="/settings/:section" element={<SettingsScreen />} />
                {/* Idle/unknown routes return to the dashboard (home + idle screen). */}
                <Route path="*" element={<DashboardScreen />} />
              </Routes>
            </div>
          )}
        </div>
      </div>
      {/* Docked touch keyboard — appears whenever any text field is focused (KEYBOARD.md). */}
      <OnScreenKeyboard />
    </>
  )
}
