import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { Routes, Route, useLocation, type Location } from 'react-router-dom'
import { IconSprite } from '../icons/IconSprite'
import { MicLiveBanner, LiveCards, NotificationDrawer, NotificationPullTab } from '../components'
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
import { BabyScreen } from '../screens/BabyScreen'
import { LitterScreen } from '../screens/LitterScreen'
import { LitterSettingsScreen } from '../screens/LitterSettingsScreen'
import { LitterHistoryScreen } from '../screens/LitterHistoryScreen'
import { NotificationsScreen } from '../screens/NotificationsScreen'
import { ClimateScreen } from '../screens/ClimateScreen'
import { WeatherScreen } from '../screens/WeatherScreen'
import { AssistantScreen } from '../screens/AssistantScreen'
import { TodoScreen } from '../screens/TodoScreen'
import { SensorHistoryScreen } from '../screens/SensorHistoryScreen'
import { SettingsScreen } from '../screens/SettingsScreen'
import { EventEditorScreen } from '../screens/EventEditorScreen'
import { LockScreen } from '../screens/LockScreen'
import { MealsHomeScreen } from '../screens/meals/MealsHomeScreen'
import { MealsWeekScreen } from '../screens/meals/MealsWeekScreen'
import { AssignNightScreen } from '../screens/meals/AssignNightScreen'
import { NightConfirmScreen } from '../screens/meals/NightConfirmScreen'
import { RecipeFolderScreen } from '../screens/meals/RecipeFolderScreen'
import { RecipeDetailScreen } from '../screens/meals/RecipeDetailScreen'
import { RecipeEditScreen } from '../screens/meals/RecipeEditScreen'
import { AddRecipeScreen } from '../screens/meals/AddRecipeScreen'
import { MealsSettingsScreen } from '../screens/meals/MealsSettingsScreen'
import { MealDetailScreen } from '../screens/meals/MealDetailScreen'
import { NewMealScreen } from '../screens/meals/NewMealScreen'
import { RecipeDiffScreen } from '../screens/meals/RecipeDiffScreen'
import { PantryScreen } from '../screens/pantry/PantryScreen'
import { GroceryScreen } from '../screens/pantry/GroceryScreen'
import { ScanScreen } from '../screens/pantry/ScanScreen'
import { ImportScreen } from '../screens/pantry/ImportScreen'
import { StockCheckScreen } from '../screens/pantry/StockCheckScreen'
import { DeductionScreen } from '../screens/pantry/DeductionScreen'

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
                {/* Meals. `/meals/recipes/new` is declared before `/meals/recipes/:id` so "new"
                    is read as the add screen rather than as a recipe id that will never resolve. */}
                <Route path="/meals" element={<MealsHomeScreen />} />
                <Route path="/meals/week" element={<MealsWeekScreen />} />
                <Route path="/meals/assign/:date/:slot" element={<AssignNightScreen />} />
                <Route path="/meals/confirm/:date" element={<NightConfirmScreen />} />
                <Route path="/meals/recipes" element={<RecipeFolderScreen />} />
                <Route path="/meals/recipes/new" element={<AddRecipeScreen />} />
                <Route path="/meals/recipes/:id" element={<RecipeDetailScreen />} />
                <Route path="/meals/recipes/:id/edit" element={<RecipeEditScreen />} />
                <Route path="/meals/recipes/:id/diff" element={<RecipeDiffScreen />} />
                {/* Same ordering rule as recipes: "new" is declared first so it is read as the
                    create screen rather than as an id that will never resolve. */}
                <Route path="/meals/meals/new" element={<NewMealScreen />} />
                <Route path="/meals/meals/:id" element={<MealDetailScreen />} />
                <Route path="/meals/settings" element={<MealsSettingsScreen />} />
                {/* Pantry. `/pantry/import/new` before `/pantry/import/:id` for the same reason as
                    the recipe routes: "new" must be read as the paste screen, not as an id. */}
                <Route path="/pantry" element={<PantryScreen />} />
                <Route path="/pantry/grocery" element={<GroceryScreen />} />
                <Route path="/pantry/scan" element={<ScanScreen />} />
                <Route path="/pantry/import/new" element={<ImportScreen />} />
                <Route path="/pantry/import/:id" element={<ImportScreen />} />
                {/* The two modal surfaces. Both sit over a Meals flow and both are advisory: the
                    plan entry is written before the check appears, and the deduction is applied
                    before the receipt is. Neither can refuse or reverse what Meals already did. */}
                <Route path="/pantry/check/:date/:slot" element={<StockCheckScreen />} />
                <Route path="/pantry/taken/:planEntryId" element={<DeductionScreen />} />
                <Route path="/baby" element={<BabyScreen />} />
                <Route path="/litter" element={<LitterScreen />} />
                <Route path="/litter/settings" element={<LitterSettingsScreen />} />
                <Route path="/litter/history" element={<LitterHistoryScreen />} />
                <Route path="/climate" element={<ClimateScreen />} />
                <Route path="/weather" element={<WeatherScreen />} />
                <Route path="/assistant" element={<AssistantScreen />} />
                <Route path="/todo" element={<TodoScreen />} />
                <Route path="/sensor" element={<SensorHistoryScreen />} />
                {/* Reached from Config, which the account avatar opens — the inbox is not a tab. */}
                <Route path="/notifications" element={<NotificationsScreen />} />
                <Route path="/settings" element={<SettingsScreen />} />
                <Route path="/settings/:section" element={<SettingsScreen />} />
                {/* Idle/unknown routes return to the dashboard (home + idle screen). */}
                <Route path="*" element={<DashboardScreen />} />
              </Routes>
            </div>
          )}
        </div>
      </div>
      {/* Notifications are app-level, above the router: cards and the drawer belong to the panel,
          not to whichever screen happens to be showing. Absent on the Lock screen — a locked panel
          should not leak what the household is being told. */}
      {!showLock && (
        <>
          <NotificationPullTab />
          <LiveCards />
          <NotificationDrawer />
        </>
      )}
      {/* Docked touch keyboard — appears whenever any text field is focused (KEYBOARD.md). */}
      <OnScreenKeyboard />
    </>
  )
}
