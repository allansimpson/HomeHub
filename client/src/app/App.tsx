import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { Routes, Route, Navigate, useLocation, useNavigationType, useParams, type Location } from 'react-router'
import { IconSprite } from '../icons/IconSprite'
import { MicLiveBanner, LiveCards, NotificationDrawer, NotificationPullTab, RestartingScreen } from '../components'
import { useBaby } from './BabyProvider'
import { PumpAlert } from '../screens/care/pumpPhases'
import { useUpdate } from './UpdateProvider'
import { OnScreenKeyboard } from '../components/keyboard/OnScreenKeyboard'
import { directionFor } from './routeMotion'
import { activeSectionPath } from './navConfig'
import { rememberTab } from './lastTab'
import { useSession } from './SessionProvider'
import { useVoice } from './VoiceProvider'
import { useConnection } from './ConnectionProvider'
import { useWriteQueue } from './WriteQueueProvider'
import type { DroppedOp } from './writeQueue'
import { useIdleReset } from './useIdleReset'
import { useAmbient } from './useAmbient'
import { DashboardScreen } from '../screens/DashboardScreen'
import { CalendarScreen } from '../screens/CalendarScreen'
import { CareScreen } from '../screens/care/CareScreen'
import { LitterHistoryScreen } from '../screens/LitterHistoryScreen'
import { LitterSettingsScreen } from '../screens/LitterSettingsScreen'
import { BabySettingsScreen } from '../screens/BabySettingsScreen'
import { useNotifications } from './NotificationsProvider'
/* `ClimateScreen` and `RoomScreen` are no longer routed — see the redirects below. The files stay
   in the tree: the AC device screen is younger than they are and has not yet absorbed everything
   the room drill-in knew how to do (the press-and-slide gesture, the borrow/keep flow). */
import { DevicesScreen } from '../screens/devices/DevicesScreen'
import { AcDeviceScreen } from '../screens/devices/AcDeviceScreen'
import { WeatherScreen } from '../screens/WeatherScreen'
import { TodoScreen } from '../screens/TodoScreen'
import { SensorHistoryScreen } from '../screens/SensorHistoryScreen'
import { SettingsScreen } from '../screens/SettingsScreen'
import { EventEditorScreen } from '../screens/EventEditorScreen'
import { LockScreen } from '../screens/LockScreen'
import { MealsHomeScreen } from '../screens/meals/MealsHomeScreen'
import { KitchenHomeScreen } from '../screens/kitchen/KitchenHomeScreen'
import { KitchenPlanScreen } from '../screens/kitchen/KitchenPlanScreen'
import { KitchenPantryScreen } from '../screens/kitchen/KitchenPantryScreen'
import { KitchenListScreen } from '../screens/kitchen/KitchenListScreen'
import { KitchenRecipesScreen } from '../screens/kitchen/KitchenRecipesScreen'
import { KitchenMatchingScreen } from '../screens/kitchen/KitchenMatchingScreen'
import { KitchenSortMatchScreen } from '../screens/kitchen/KitchenSortMatchScreen'
import { KitchenItemSheet } from '../screens/kitchen/KitchenItemSheet'
import { KitchenAteItScreen } from '../screens/kitchen/KitchenAteItScreen'
import { KitchenReceiptScreen } from '../screens/kitchen/KitchenReceiptScreen'
import { KitchenAddScreen } from '../screens/kitchen/KitchenAddScreen'
import { KitchenShopScreen } from '../screens/kitchen/KitchenShopScreen'
import { KitchenShelfLifeScreen } from '../screens/kitchen/KitchenShelfLifeScreen'
import { KitchenAisleOrderScreen } from '../screens/kitchen/KitchenAisleOrderScreen'
import { KitchenCheckScreen } from '../screens/kitchen/KitchenCheckScreen'
import { KitchenReviewScreen } from '../screens/kitchen/KitchenReviewScreen'
import { KitchenPutAwayScreen } from '../screens/kitchen/KitchenPutAwayScreen'
import { KitchenCookScreen } from '../screens/kitchen/KitchenCookScreen'
import { KitchenRecipeScreen } from '../screens/kitchen/KitchenRecipeScreen'
import { KitchenAddRecipeScreen } from '../screens/kitchen/KitchenAddRecipeScreen'
import { KitchenDeliveryScreen } from '../screens/kitchen/KitchenDeliveryScreen'
import { KitchenNightScreen } from '../screens/kitchen/KitchenNightScreen'
import { KitchenSuggestScreen } from '../screens/kitchen/KitchenSuggestScreen'
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

/**
 * `/climate/room/3` → `/devices/ac/3`.
 *
 * The room drill-in became the unit's own screen when CLIMATE left the bar. The id survives the
 * trip because it is the same zone either side — only what owns it changed.
 */
function LegacyRoomRedirect() {
  const { id } = useParams()
  return <Navigate to={id ? `/devices/ac/${id}` : '/devices'} replace />
}

/**
 * Why a write was set aside, in the household's words rather than the queue's.
 *
 * The server's own sentence wins where it wrote one — a 400 from these controllers is written to be
 * read ("That barcode already belongs to Olive oil.") and explains the failure better than any
 * category name could.
 */
function droppedReason(d: DroppedOp): string {
  if (d.message) return d.message
  if (d.reason === 'legacy-orphaned') return 'Saved before sign-in — not sent'
  if (d.reason === 'retry-exhausted') return 'Kept failing — gave up'
  return 'Refused by the server'
}

export function App() {
  // Global mic state (Stage 8): the banner must appear on ANY screen whenever the mic is open.
  const { micLive } = useVoice()
  /* The running pump session, if any — see the mount below. It rides the provider that already
     polls the care log for the Dashboard's figures rather than a second reader of its own. */
  const { pumpTimer } = useBaby()

  const { locked, settings } = useSession()
  const { reconnecting, offline } = useConnection()
  const { pendingCount, conflicts, dropped, resolveConflict, dismissDropped } = useWriteQueue()
  const update = useUpdate()
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

  /*
   * Remember which tab this is, for the next launch on a phone.
   *
   * Recorded from the *section* rather than the path, so a drill-in notes the tab it belongs to —
   * being killed halfway through a recipe should return somebody to MEALS, not to a recipe screen
   * they did not ask to reopen. `activeSectionPath` returns '' for the screens that own no tab (the
   * event editor, the lock screen), and `rememberTab` ignores anything that is not a tab root, so
   * those simply leave the last real tab standing.
   */
  useEffect(() => {
    rememberTab(activeSectionPath(location.pathname))
  }, [location.pathname])

  // Honest reconnecting state on every screen. The dashboard carries its own header chip
  // (design 01), so the app-level bar is shown on the other screens.
  //
  // `reconnecting` rather than `!online`: the provider holds this back for a few seconds so that the
  // ordinary wake-from-background blip — tab frozen, probe killed with it, everything fine again
  // before anyone has read the banner — never paints one. See `ConnectionProvider`.
  const showReconnecting = reconnecting && !showLock && location.pathname !== '/'

  /*
   * The reload takes the screen.
   *
   * Above everything and instead of everything — no nav, no plate, no Dashboard behind it. Returned
   * before the routes rather than layered over them so nothing underneath keeps running for the
   * second it is up; the page is on its way out, and anything still polling in the background is
   * work aimed at a document that will not be here to receive it.
   */
  if (update.status === 'restarting') return <RestartingScreen version={update.version} />

  return (
    <>
      <IconSprite />
      <div className="app-root">
        {micLive && <MicLiveBanner />}
        {/*
          The pump's two boundaries, felt from anywhere in the app.

          <b>Mounted beside the mic banner for the same reason it is.</b> Both have to survive the
          household being on some other screen — and this one had not been: `PumpAlert` sat inside
          the Baby tab, so walking away unmounted it and the switch passed in silence. That is the
          whole situation the buzz exists for, and on a panel that idles on the Dashboard it was
          most of them. Renders nothing; it is here for the vibration.

          Still only while the app is open. A backgrounded PWA runs no timers, and answering that
          needs push notifications rather than a different mount.
        */}
        {pumpTimer && <PumpAlert timer={pumpTimer} />}
        {showReconnecting && (
          /*
           * Two sentences, because they describe two different situations.
           *
           * "Reconnecting" is a promise that something is in progress — right for a deploy restart
           * or a dropped packet, and wrong twenty seconds later, when nothing is reconnecting and
           * the panel is simply somewhere the server is not. On a phone that has left the house
           * that is not a fault at all: the app works, it is holding what was written, and it will
           * sync. Saying so is the difference between a household that trusts what it just logged
           * and one that logs it again to be sure.
           */
          <div className={'ml-reconnect' + (offline ? ' ml-reconnect--offline' : '')} role="status">
            <span className="ml-reconnect__dot" aria-hidden="true" />
            <span className="ml-reconnect__text">
              {offline
                ? 'Offline — saved here, will sync when you’re back'
                : 'Reconnecting — showing last known'}
            </span>
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
        {!showLock && dropped.length > 0 && (
          /*
           * Writes that did not go through, and will not be tried again.
           *
           * Three failures arrive here — a record queued before the queue knew whose it was, one
           * that spent its retries, and one the server refused outright — and to somebody standing
           * at the panel all three look the same: the thing they entered is not there. Failing
           * closed is the right policy and it is only half of one; the other half is saying so.
           * Without this strip, "we did not replay that" and "we lost that" are the same event.
           */
          <div className="ml-dropped" role="alert">
            <span className="ml-dropped__title">Did not go through — please re-enter</span>
            {dropped.map((d) => (
              <div key={d.id} className="ml-dropped__row">
                <span className="ml-dropped__label">{d.label}</span>
                <span className="ml-dropped__reason">{droppedReason(d)}</span>
              </div>
            ))}
            <button type="button" className="ml-linkbtn" onClick={dismissDropped}>Dismiss</button>
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
                {/* The Kitchen's answering page. Added alongside /meals rather than replacing it:
                    the section's destinations are still the Meals screens until each is reworked,
                    and a half-migrated nav that pointed at pages which do not exist yet would be
                    worse than two doors into the same section for one release. */}
                <Route path="/kitchen" element={<KitchenHomeScreen />} />
                <Route path="/kitchen/plan" element={<KitchenPlanScreen />} />
                <Route path="/kitchen/pantry" element={<KitchenPantryScreen />} />
                <Route path="/kitchen/list" element={<KitchenListScreen />} />
                <Route path="/kitchen/recipes" element={<KitchenRecipesScreen />} />
                <Route path="/kitchen/matching" element={<KitchenMatchingScreen />} />
                <Route path="/kitchen/matching/sort" element={<KitchenSortMatchScreen />} />
                <Route path="/kitchen/pantry/add" element={<KitchenAddScreen />} />
                <Route path="/kitchen/list/shop" element={<KitchenShopScreen />} />
                <Route path="/kitchen/list/review" element={<KitchenReviewScreen />} />
                <Route path="/kitchen/list/put-away" element={<KitchenPutAwayScreen />} />
                <Route path="/kitchen/pantry/shelf-life" element={<KitchenShelfLifeScreen />} />
                <Route path="/kitchen/pantry/check" element={<KitchenCheckScreen />} />
                <Route path="/kitchen/pantry/delivery" element={<KitchenDeliveryScreen />} />
                <Route path="/kitchen/recipes/add" element={<KitchenAddRecipeScreen />} />
                <Route path="/kitchen/recipes/:id" element={<KitchenRecipeScreen />} />
                <Route path="/kitchen/cook/:id" element={<KitchenCookScreen />} />
                <Route path="/kitchen/plan/:date" element={<KitchenNightScreen />} />
                <Route path="/kitchen/plan/:date/fill" element={<KitchenSuggestScreen />} />
                <Route path="/kitchen/settings/aisles" element={<KitchenAisleOrderScreen />} />
                <Route path="/kitchen/pantry/:id" element={<KitchenItemSheet />} />
                <Route path="/kitchen/ate-it" element={<KitchenAteItScreen />} />
                <Route path="/kitchen/receipt/:entryId" element={<KitchenReceiptScreen />} />
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
                {/* Baby. The route keeps its `/care` path — the household's bookmarks, the
                    Attendant and every notification deep link emit it — while the tab that reaches
                    it is BABY again after the split. */}
                <Route path="/care" element={<CareScreen />} />
                {/*
                  Devices — the litter robot and the air conditioners.

                  The robot's own view is unchanged and simply re-homed: it was reached through the
                  Care tab's subject switcher, which the split removes.
                */}
                <Route path="/devices" element={<DevicesScreen />} />
                <Route path="/devices/litter" element={<CareScreen />} />
                <Route path="/devices/litter/history" element={<LitterHistoryScreen />} />
                {/* An AC and the room it reads are one screen — the room is a property of its unit,
                    which is what taking CLIMATE out of the bar actually meant. */}
                <Route path="/devices/ac/:id" element={<AcDeviceScreen />} />
                {/* The robot's history went with the robot. Kept as a redirect for one release —
                    it is a path the Attendant and the drawer both emit. */}
                <Route path="/care/history" element={<Navigate to="/devices/litter/history" replace />} />
                {/*
                  Redirects, not deletions, and kept for one release.
                  The Attendant, notification deep links and anything the household has bookmarked
                  still emit the old paths. `replace` so Back doesn't bounce off the redirect.
                */}
                <Route path="/baby" element={<Navigate to="/care" replace />} />
                <Route path="/litter" element={<Navigate to="/devices/litter" replace />} />
                <Route path="/litter/history" element={<Navigate to="/devices/litter/history" replace />} />
                <Route path="/litter/settings" element={<Navigate to="/settings/devices" replace />} />
                {/* One splat rather than seven redirects: every `/pantry/*` path re-parents to the
                    same tail under `/meals`, and the stock check and the deduction receipt carry
                    ids and query strings that have to survive the trip. */}
                <Route path="/pantry/*" element={<LegacyPantryRedirect />} />
                {/*
                  Climate has no tab and no screen of its own any more.

                  Each AC is a device and the room it reads lives inside it, which is what taking
                  CLIMATE out of the bar actually meant — a list of rooms was a list of readings
                  nobody could act on without first working out which unit owned each one. The two
                  paths redirect for one release: the Attendant, the dashboard block and anything
                  bookmarked still emit them.
                */}
                <Route path="/climate" element={<Navigate to="/devices" replace />} />
                <Route path="/climate/room/:id" element={<LegacyRoomRedirect />} />
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
                <Route path="/lists" element={<TodoScreen />} />
                <Route path="/sensor" element={<SensorHistoryScreen />} />
                {/* Reached from Config, which the account avatar opens — the inbox is not a tab. */}
                {/* The inbox screen is gone — notifications are one slide-down panel now
                    (`NotificationDrawer`). The address stays, because installed panels and phones
                    hold shortcuts to it: it opens the panel and hands the route back to the
                    dashboard, so a link still lands somewhere that answers it. */}
                <Route path="/notifications" element={<OpenNotifications />} />
                <Route path="/settings" element={<SettingsScreen />} />
                {/* Declared before `/settings/:section` so `devices` is read as the Litter-Robot
                    page rather than as a Config view that does not exist. The screen is unchanged
                    internally — only its address moved, with its tab (CONFIG.md). */}
                <Route path="/settings/devices" element={<LitterSettingsScreen />} />
                <Route path="/settings/baby" element={<BabySettingsScreen />} />
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

/**
 * `/notifications` — the address the inbox screen used to answer.
 *
 * Notifications are a panel now, not a place, so there is nothing to route *to*: this opens the
 * panel and sends the route home underneath it. Kept rather than deleted because installed panels
 * and phones hold shortcuts to this path, and a saved link that lands on a blank dashboard is worse
 * than one that does what it always did.
 */
function OpenNotifications() {
  const { openDrawer } = useNotifications()
  useEffect(() => { openDrawer() }, [openDrawer])
  return <Navigate to="/" replace />
}
