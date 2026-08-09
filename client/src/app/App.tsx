import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { Routes, Route, Navigate, useLocation, useNavigationType, type Location } from 'react-router'
import { IconSprite } from '../icons/IconSprite'
import { MicLiveBanner, LiveCards, NotificationDrawer, NotificationPullTab } from '../components'
import { OnScreenKeyboard } from '../components/keyboard/OnScreenKeyboard'
import { directionFor } from './routeMotion'
import { useSession } from './SessionProvider'
import { useVoice } from './VoiceProvider'
import { useConnection } from './ConnectionProvider'
import { useWriteQueue } from './WriteQueueProvider'
import { useIdleReset } from './useIdleReset'
import { useAmbient } from './useAmbient'
import { DashboardScreen } from '../screens/DashboardScreen'
import { CalendarScreen } from '../screens/CalendarScreen'
import { CareScreen } from '../screens/care/CareScreen'
import { LitterHistoryScreen } from '../screens/LitterHistoryScreen'
import { LitterSettingsScreen } from '../screens/LitterSettingsScreen'
import { NotificationsScreen } from '../screens/NotificationsScreen'
import { ClimateScreen } from '../screens/climate/ClimateScreen'
import { RoomScreen } from '../screens/climate/RoomScreen'
import { WeatherScreen } from '../screens/WeatherScreen'
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
import { AssistScreen } from '../screens/assist/AssistScreen'
import { ChatScreen } from '../screens/assist/ChatScreen'
import { ArchiveScreen } from '../screens/assist/ArchiveScreen'

// Route motion (which screens rise, settle or cross-fade) lives in routeMotion.ts, where it is a
// pure function with tests — the segment-switch case is too easy to get wrong by eye.

type ViewTransitionDocument = Document & {
  startViewTransition?: (cb: () => void) => { finished: Promise<void> }
}

/**
 * `/pantry/anything` → `/meals/pantry/anything`, query string and all.
 *
 * Pantry became a Meals segment, but the two modal surfaces underneath it — the stock check and the
 * deduction receipt — are entered from Meals flows and from notifications, both of which hold paths
 * that were minted before the move. Kept for one release.
 */
function LegacyPantryRedirect() {
  const { pathname, search } = useLocation()
  return <Navigate to={`/meals${pathname}${search}`} replace />
}

export function App() {
  // Global mic state (Stage 8): the banner must appear on ANY screen whenever the mic is open.
  const { micLive } = useVoice()

  const { locked, settings } = useSession()
  const { reconnecting } = useConnection()
  const { pendingCount, conflicts, resolveConflict } = useWriteQueue()
  const location = useLocation()
  const navigationType = useNavigationType()
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
    // A replace is a URL correction, not a journey. It adds no history entry, so there is nowhere
    // the household went and nothing to animate between: the legacy redirects land on a screen the
    // person believes they already asked for, and Assist swaps `/assist/c` for `/assist/c/42` the
    // instant a new chat gets its id — with the reply still streaming on the screen that would be
    // sliding. Animating either one draws attention to bookkeeping.
    if (typeof doc.startViewTransition !== 'function' || reduce || navigationType === 'REPLACE') {
      setDisplayed(location)
      return
    }
    const dir = directionFor(displayed.pathname, location.pathname)
    document.documentElement.dataset.vt = dir
    const transition = doc.startViewTransition(() => flushSync(() => setDisplayed(location)))
    void transition.finished.finally(() => {
      if (document.documentElement.dataset.vt === dir) delete document.documentElement.dataset.vt
    })
  }, [location, displayed, navigationType])

  // The Lock screen is a gate, not a routed page: it takes over whenever the active profile
  // is locked (boot / idle) or the profile switcher (`/lock`) is open. On success it routes
  // back to the dashboard.
  const showLock = locked || location.pathname === '/lock'

  // Honest reconnecting state on every screen. The dashboard carries its own header chip
  // (design 01), so the app-level bar is shown on the other screens.
  //
  // `reconnecting` rather than `!online`: the provider holds this back for a few seconds so that the
  // ordinary wake-from-background blip — tab frozen, probe killed with it, everything fine again
  // before anyone has read the banner — never paints one. See `ConnectionProvider`.
  const showReconnecting = reconnecting && !showLock && location.pathname !== '/'

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
                {/* Pantry, now a Meals segment. `/meals/pantry/import/new` before `.../import/:id`
                    for the same reason as the recipe routes: "new" must be read as the paste
                    screen, not as an id. */}
                <Route path="/meals/pantry" element={<PantryScreen />} />
                <Route path="/meals/pantry/grocery" element={<GroceryScreen />} />
                <Route path="/meals/pantry/scan" element={<ScanScreen />} />
                <Route path="/meals/pantry/import/new" element={<ImportScreen />} />
                <Route path="/meals/pantry/import/:id" element={<ImportScreen />} />
                {/* The two modal surfaces. Both sit over a Meals flow and both are advisory: the
                    plan entry is written before the check appears, and the deduction is applied
                    before the receipt is. Neither can refuse or reverse what Meals already did. */}
                <Route path="/meals/pantry/check/:date/:slot" element={<StockCheckScreen />} />
                <Route path="/meals/pantry/taken/:planEntryId" element={<DeductionScreen />} />
                {/* Care. Both subjects live behind `/care`; `?subject=` is how the redirects,
                    notification deep links and the Attendant name one. */}
                <Route path="/care" element={<CareScreen />} />
                <Route path="/care/history" element={<LitterHistoryScreen />} />
                {/*
                  Redirects, not deletions, and kept for one release.
                  The Attendant, notification deep links and anything the household has bookmarked
                  still emit the old paths. `replace` so Back doesn't bounce off the redirect.
                */}
                <Route path="/baby" element={<Navigate to="/care?subject=conrad" replace />} />
                <Route path="/litter" element={<Navigate to="/care?subject=mika" replace />} />
                <Route path="/litter/history" element={<Navigate to="/care/history" replace />} />
                <Route path="/litter/settings" element={<Navigate to="/settings/devices" replace />} />
                {/* One splat rather than seven redirects: every `/pantry/*` path re-parents to the
                    same tail under `/meals`, and the stock check and the deduction receipt carry
                    ids and query strings that have to survive the trip. */}
                <Route path="/pantry/*" element={<LegacyPantryRedirect />} />
                <Route path="/climate" element={<ClimateScreen />} />
                {/* The room drill-in, reached by tapping a room's *name* — the band beside it belongs
                    to the gesture, so the two never compete for the same touch. */}
                <Route path="/climate/room/:id" element={<RoomScreen />} />
                <Route path="/weather" element={<WeatherScreen />} />
                {/* Assist — the inbox, and one chat. The chat is a drill-in rather than a pane
                    beside the list: the panel is portrait and 540 wide in the design, so a
                    two-column reading of this screen was never on the table. */}
                <Route path="/assist" element={<AssistScreen />} />
                {/*
                  One route, optional id. A new chat has no id until its first turn lands, and the
                  id arriving must not be a *navigation* — the reply is streaming into this screen
                  at that exact moment, and a second Route would unmount it mid-stream and abort the
                  request. An optional segment keeps `/assist/c` and `/assist/c/42` on the same
                  matched element, so the id appears and nothing else changes.
                */}
                <Route path="/assist/c/:id?" element={<ChatScreen />} />
                {/* Anything holding the previous new-chat path. */}
                <Route path="/assist/new" element={<Navigate to="/assist/c" replace />} />
                {/* Reached only from the ARCHIVED CHATS row at the foot of the inbox. */}
                <Route path="/assist/archive" element={<ArchiveScreen />} />
                {/* Anything holding the old `/assistant` link lands on the inbox. */}
                <Route path="/assistant" element={<Navigate to="/assist" replace />} />
                <Route path="/todo" element={<TodoScreen />} />
                <Route path="/sensor" element={<SensorHistoryScreen />} />
                {/* Reached from Config, which the account avatar opens — the inbox is not a tab. */}
                <Route path="/notifications" element={<NotificationsScreen />} />
                <Route path="/settings" element={<SettingsScreen />} />
                {/* Declared before `/settings/:section` so `devices` is read as the Litter-Robot
                    page rather than as a Config view that does not exist. The screen is unchanged
                    internally — only its address moved, with its tab (CONFIG.md). */}
                <Route path="/settings/devices" element={<LitterSettingsScreen />} />
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
