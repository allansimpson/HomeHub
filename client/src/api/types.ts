/** Shared API shapes for Stage 1 (profiles + household settings). Mirror the C# DTOs. */

export interface ProfileDto {
  id: number
  name: string
  initial: string
  hasPin: boolean
  requirePinWhenIdle: boolean
  stayLoggedIn: boolean
  displayOrder: number
}

export type DaylightBoostMode = 'auto' | 'on' | 'off'

export interface SettingsDto {
  idleTimeoutMinutes: number
  idleDimmingEnabled: boolean
  daylightBoost: DaylightBoostMode
  activeProfileId: number | null
  /**
   * What the household calls the cat. Kept by the panel, not the robot — the Litter-Robot reports
   * that *a* cat is present and never which one, so this is a better word, not an identity. Null
   * everywhere it is unset, and every sentence that uses it falls back to the literal word "cat".
   */
  catName: string | null
  /**
   * Waste-drawer fullness (%) at which the panel raises a change-the-litter alert and notification.
   *
   * Deliberately ahead of the robot's own drawer-full fault, which only fires once the box has
   * already stopped cycling — by then the choice has been made for you.
   */
  litterFullPercent: number
}

// ---- Stage 2: sensors + alerts ----

export type SensorCategory = 'Ambient' | 'FoodSafety'
export type AlertSeverity = 'Info' | 'Warning' | 'Severe'

export interface ZoneReadingDto {
  id: number
  name: string
  category: SensorCategory
  source: string
  displayOrder: number
  tempF: number | null
  humidity: number | null
  timestampUtc: string | null
}

export interface TempBarDto {
  label: string
  tempF: number | null
}

export interface HumidityPeriodDto {
  label: string
  humidity: number | null
  current: boolean
}

export interface ZoneHistoryDto {
  zoneId: number
  name: string
  category: SensorCategory
  currentTempF: number | null
  currentHumidity: number | null
  currentTimestampUtc: string | null
  todayHighF: number | null
  todayHighAt: string | null
  todayLowF: number | null
  todayLowAt: string | null
  tempBars: TempBarDto[]
  humidityPeriods: HumidityPeriodDto[]
}

export interface ActiveAlertDto {
  id: number
  type: string
  severity: AlertSeverity
  message: string
  source: string
  startedAtUtc: string
}

export interface ThresholdDto {
  id: number
  zoneId: number
  zoneName: string
  metric: 'Temperature' | 'Humidity'
  direction: 'Above' | 'Below'
  value: number
  durationMinutes: number
  severity: AlertSeverity
  enabled: boolean
}

// ---- Stage 3: weather ----

export interface CurrentWeatherDto {
  tempF: number | null
  condition: string | null
  highF: number | null
  lowF: number | null
  humidity: number | null
  windMph: number | null
  feelsLikeF: number | null
}

export interface HourlyDto {
  label: string
  tempF: number | null
  shortForecast: string | null
  /** Local yyyy-MM-dd — groups hours into the Day Detail. */
  dayKey: string | null
  /** Precip probability %. */
  pop: number | null
  windMph: number | null
}

export interface DailyDto {
  day: string
  condition: string
  highF: number | null
  lowF: number | null
  severe: boolean
  /** Local yyyy-MM-dd — links a day row to its hourly periods. */
  dayKey: string | null
}

export interface WeatherSnapshotDto {
  current: CurrentWeatherDto | null
  hourly: HourlyDto[]
  daily: DailyDto[]
  fetchedAtUtc: string | null
  /** Home location for the radar view. */
  latitude: number | null
  longitude: number | null
}

// ---- Stage 4: calendar ----

export interface CalendarEventDto {
  id: number
  title: string
  startUtc: string
  endUtc: string
  location: string | null
  notes: string | null
  ownerIds: number[]
  source: string
  version: number
  /** Owning profile for Google events (per-profile calendars); null for local events. */
  profileId: number | null
  /** Display name of the owning Google calendar; null for local events. */
  calendarName: string | null
  /** What the event is — drives the day icon. Always set; 'default' when nothing identified it. */
  kind: EventKind
  /**
   * Google's own word for the event, or null. Lets the panel tell a *stated* kind from an *inferred*
   * one: kind 'birthday' with a null eventType was read off the title, so it is a guess.
   */
  googleEventType: string | null
  /**
   * Owning Google calendar id, or null for local events. The join key for the calendar mark axis —
   * {@link SyncCalendarDto.icon} is keyed by id, and the display name is not unique across accounts.
   */
  googleCalendarId: string | null
  /**
   * A mark the household chose for this one event, or null to inherit. The most specific of the
   * three axes — an explicit statement about this event — so it outranks both the provider's
   * {@link kind} and the calendar's mark.
   */
  mark: string | null
}

/**
 * Event kinds the API can emit. Each maps to a real signal — Google's `eventType`, a holiday
 * calendar's id, or a title that says so — so none of them is invented from duration or timing.
 */
export type EventKind =
  | 'default'
  | 'birthday'
  | 'anniversary'
  | 'holiday'
  | 'out-of-office'
  | 'focus-time'
  | 'working-location'
  | 'from-gmail'

export interface CalendarEventInput {
  title: string
  startUtc: string
  endUtc: string
  location: string | null
  notes: string | null
  ownerIds: number[]
  /** Owning profile (whose Google account the event is created on). Null for the local calendar. */
  profileId?: number | null
  /** Target Google calendar for a new event; null = the profile's primary calendar. */
  googleCalendarId?: string | null
  /** Mark for this one event, overriding its kind and its calendar's mark; null to inherit. */
  mark?: string | null
}

/** A Google calendar offered for display, with its current selection (CONFIG · choose-calendars). */
export interface SyncCalendarDto {
  calendarId: string
  name: string
  selected: boolean
  /**
   * Icon the household assigned to this whole calendar, or null. The second icon axis: this says
   * "everything on Work looks like this", while an event's own {@link CalendarEventDto.kind} says
   * what that single event is. The event wins where they disagree.
   */
  icon: string | null
  /**
   * Whether this account may add events here. Google publishes read-only calendars — holidays,
   * anyone else's shared calendar — so the event editor offers only the ones that can take a write.
   */
  canWrite: boolean
  /** The account's default calendar — where a new event lands unless another is chosen. */
  isPrimary: boolean
}

// ---- Stage 5: tasks ----

export interface TaskItemDto {
  id: number
  profileId: number
  title: string
  note: string | null
  dueUtc: string | null
  completed: boolean
  source: string
  version: number
  /** The To Do list this task belongs to (the TODO screen groups by it). */
  listName: string | null
  graphListId: string | null
  important: boolean
}

export interface TaskCreateInput {
  profileId: number
  title: string
  note: string | null
  dueUtc: string | null
  /** Target list for the new task (Microsoft) — id preferred, name for the local store. */
  graphListId?: string | null
  listName?: string | null
}

/** A Microsoft To Do list offered for syncing, with its current selection (spec 13 · choose-lists). */
export interface SyncListDto {
  graphListId: string
  name: string
  selected: boolean
}

// ---- Stage 6: climate ----

export type ClimateModeName = 'Off' | 'Cool' | 'Heat' | 'Fan' | 'Auto'

export interface ClimateZoneDto {
  id: number
  name: string
  currentTempF: number
  setPointF: number | null
  mode: ClimateModeName
  fanMode: string | null
  running: boolean
  source: string
  /** Local-clock estimate of when the set point is reached, e.g. "8:10 PM"; null when at set point / off. */
  reachesAtLocal: string | null
}

// ---- Stage 7: AI assistant ----

export type AssistantOriginName = 'Local' | 'Cloud'

export interface AssistantChatRequest {
  history: { role: string; text: string }[]
  prompt: string
  imageBase64?: string | null
  imageMediaType?: string | null
  force?: string | null
  /** Signed-in profile, so an in-app action (add a task, …) runs as that member. */
  profileId?: number | null
}

export interface AssistantChatResponse {
  text: string
  origin: AssistantOriginName
  escalated: boolean
  model: string | null
  /** Set (e.g. "task") when the turn performed an in-app action, so the UI can refresh. */
  action?: string | null
}

export interface VerifyPinResult {
  success: boolean
  /** Present when the profile is in a lockout cooldown. */
  lockedForSeconds?: number | null
}

// ---- Account linking (OAuth) ----

/** Whether a provider can be linked on this panel, and whether this profile already is. */
export interface LinkStatusDto {
  provider: string
  configured: boolean
  linked: boolean
  /** The callback this panel will send — shown so it can be registered before it is rejected. */
  redirectUri: string
}

/**
 * Where to send the household to consent, plus the callback that was used — surfaced so the panel
 * can show the exact string to register when a provider rejects it.
 */
export interface LinkStartDto {
  url: string
  redirectUri: string
}

// ---- Notifications ----

/**
 * One thing the household was told. Distinct from an alert: an alert is a condition that is true
 * *now* and clears itself; this is a thing that *happened* and stays until read or seven days pass.
 */
export interface NotificationDto {
  id: number
  source: string
  /** For `tasks` this is the To Do list's own name — GROCERY, HOUSEHOLD — not a flat "TASKS". */
  label: string
  severity: 'wants-you' | 'worth-knowing'
  accent: 'terracotta' | 'verdigris' | 'brass' | 'brass-bright'
  headline: string
  meta: string | null
  route: string | null
  atUtc: string
  read: boolean
}

export interface NotificationFeedDto {
  items: NotificationDto[]
  unread: number
  /** Which sources may notify. A source switched off never enters the store at all. */
  sources: Record<string, boolean>
}

// ---- Baby (Huckleberry) ----

/**
 * Five deliberately distinguishable states. "HA is down" and "the integration isn't there" need
 * different fixes and the panel says which; `NotConfigured` is not an error.
 */
export type BabyStatusName =
  | 'NotConfigured'
  | 'Ok'
  | 'HomeAssistantUnreachable'
  | 'IntegrationMissing'
  | 'Stale'

export interface BabyHealthDto {
  status: BabyStatusName
  detail: string | null
  lastGoodUtc: string | null
  configured: boolean
}

export interface BabyChildDto {
  key: string
  name: string
  birthday: string | null
}

/** One read for the whole tab root. Every measurement is nullable — see the growth rows. */
export interface BabyStateDto {
  childKey: string
  childName: string
  sleepState: string
  sleepStartedUtc: string | null
  sleepPaused: boolean
  lastSleepStartUtc: string | null
  lastSleepMinutes: number | null
  nursingRunning: boolean
  nursingPaused: boolean
  nursingStartedUtc: string | null
  nursingSide: string | null
  lastNursingUtc: string | null
  lastNursingMinutes: number | null
  lastNursingLeftMinutes: number | null
  lastNursingRightMinutes: number | null
  lastBottleUtc: string | null
  bottleAmount: number | null
  bottleUnit: string | null
  bottleType: string | null
  lastDiaperUtc: string | null
  diaperType: string | null
  growthMeasuredUtc: string | null
  weight: number | null
  weightUnit: string | null
  height: number | null
  headCircumference: number | null
  lengthUnit: string | null
  /** Feeds and diapers only — sleep is deliberately not in the counts line. */
  feedsToday: number
  diapersToday: number
  fetchedUtc: string
  stale: boolean
}

export interface BabyHistoryEventDto {
  startUtc: string
  endUtc: string | null
  kind: string
  summary: string
  detail: string | null
}

export type BabyTimerKindName = 'sleep' | 'nursing'
/** `cancel` saves no interval; `complete` writes to history. Not interchangeable. */
export type BabyTimerActionName = 'start' | 'pause' | 'resume' | 'cancel' | 'complete' | 'switchside'
export type NursingSideName = 'left' | 'right'

export type DiaperKindName = 'pee' | 'poo' | 'both' | 'dry'
export type DiaperAmountName = 'little' | 'medium' | 'big'
export type PooColorName = 'yellow' | 'brown' | 'black' | 'green' | 'red' | 'gray'
export type PooConsistencyName = 'solid' | 'loose' | 'runny' | 'mucousy' | 'hard' | 'pebbles' | 'diarrhea'
export type BottleTypeName =
  | 'formula'
  | 'breast_milk'
  | 'tube_feeding'
  | 'cow_milk'
  | 'goat_milk'
  | 'soy_milk'
  | 'other'

/** Logs now — there is no retroactive path upstream, so no timestamp crosses this boundary. */
export interface DiaperInput {
  kind: DiaperKindName
  peeAmount?: DiaperAmountName | null
  pooAmount?: DiaperAmountName | null
  color?: PooColorName | null
  consistency?: PooConsistencyName | null
  diaperRash?: boolean | null
  notes?: string | null
}

export interface BottleInput {
  amount: number
  type: BottleTypeName
  units: 'ml' | 'oz'
}

/** Weight as pounds + ounces, the way the household reads it; the API folds it to decimal pounds. */
export interface GrowthInput {
  pounds: number | null
  ounces: number | null
  heightInches: number | null
  headInches: number | null
}

// ---- Litter (Litter-Robot via Home Assistant) ----

export type CatStatusName = BabyStatusName

export interface CatHealthDto {
  status: CatStatusName
  detail: string | null
  lastGoodUtc: string | null
  configured: boolean
}

/**
 * What the panel branches on: 25 status codes collapse to the six outcomes that change what a person
 * should do.
 */
export type LitterFaultClassName =
  | 'Stable'
  | 'Transient'
  | 'CatPresent'
  | 'Recoverable'
  | 'NeedsHuman'
  | 'Offline'
  | 'Unknown'

/**
 * Which controls this robot exposes. The switch states are nullable and unknown is not off — a control
 * drawn in the off position invites a press that goes nowhere.
 */
export interface LitterRobotControlsDto {
  sleepMode: boolean | null
  nightLight: boolean | null
  panelLock: boolean | null
  canResetDrawer: boolean
  canAddLitter: boolean
  /**
   * The scheduled quiet window, read-only. Separate from `sleepMode` because the integration
   * publishes the schedule while exposing no switch to set it — a panel that can't change the
   * setting can still say what it is.
   */
  sleepStartsUtc: string | null
  sleepEndsUtc: string | null
  /**
   * The robot's multi-position settings, keyed `nightLight` · `globeBrightness` · `panelBrightness`
   * · `cleanCycleWait`. Render whatever `options` says — the real sets are not what any spec
   * predicted (the night light is off/on/auto, and the wait offers five values, not three), and they
   * differ by model and integration release.
   */
  selects: Record<string, LitterSelectDto | undefined>
  /** The LitterHopper accessory, when one is fitted and reporting. */
  hopperStatus: string | null
  /** Firmware the robot is running. Read-only — updates are applied from the Whisker app. */
  firmwareVersion: string | null
  firmwareUpdateAvailable: boolean | null
}

/** A multi-position setting. An empty `options` means readable but not changeable from here. */
export interface LitterSelectDto {
  current: string | null
  options: string[]
}

export interface RecoveryStateDto {
  enabled: boolean
  activeFaultCode: string | null
  faultSinceUtc: string | null
  attemptsThisEpisode: number
  attemptsToday: number
  lastAttemptUtc: string | null
  nextAttemptDueUtc: string | null
  holdReason: string | null
  /**
   * The ceiling the loop will actually stop at, after the per-code tightening — `otf`/`pd`/`spf`
   * allow one attempt only, because a second is how a jam becomes a broken motor.
   */
  maxAttemptsThisEpisode: number
  maxAttemptsToday: number
}

/**
 * Every percentage and weight is nullable and must render as unknown, never as 0 — a null litter level
 * shown as 0% would trip the empty-globe alert on every cloud hiccup.
 */
export interface LitterRobotDto {
  slug: string
  name: string
  statusCode: string
  /** pylitterbot's own text, so it matches what the Whisker app shows. Never paraphrase it. */
  statusText: string
  faultClass: LitterFaultClassName
  /**
   * `LR4` / `LR3`, inferred from capability rather than published by HA. The panel names the box
   * (`MIKA'S BOX · LR4`) instead of showing the entity slug, which carries a typo nobody will fix.
   */
  model: string | null
  usable: boolean
  wasteDrawerPercent: number | null
  litterPercent: number | null
  petWeightLbs: number | null
  totalCycles: number | null
  lastSeenUtc: string | null
  /**
   * When the robot entered its current status — not when we read it. Mid-cycle this is the moment
   * the cycle began, so it doesn't restate itself on every poll.
   */
  statusSinceUtc: string | null
  fetchedUtc: string
  stale: boolean
  recovery: RecoveryStateDto
  controls: LitterRobotControlsDto
}

export type LitterSwitchName = 'sleepmode' | 'nightlight' | 'panellock'

/** The `select` entities, addressed by name on `PUT /api/cats/{slug}/select/{which}`. */
export type LitterSelectName = 'nightlight' | 'globebrightness' | 'panelbrightness' | 'cleancyclewait'

export interface RecoveryAttemptDto {
  id: number
  faultCode: string
  attemptNumber: number
  step: string
  outcome: string
  resultingCode: string | null
  detail: string | null
  manual: boolean
  startedAtUtc: string
  completedAtUtc: string | null
}

/**
 * Trends from Home Assistant's recorder — HomeHub keeps no litter time series of its own.
 *
 * `complete` is load-bearing: the recorder purges (10 days by default), so a 30- or 90-day request
 * usually comes back short. A partial series drawn as a full one misstates how the box has been
 * doing, so the screen says which window it actually got.
 */
export interface LitterHistoryDto {
  slug: string
  requestedDays: number
  oldestSampleUtc: string | null
  complete: boolean
  days: LitterDaySampleDto[]
  weights: LitterWeightSampleDto[]
  /** Fault-class name → share of the window, weighted by duration. */
  classShare: Record<string, number>
  drawerFillPercentPerDay: number | null
  daysUntilDrawerFull: number | null
  /**
   * Cycles counted from status transitions into `ccp`, not from a counter — Home Assistant exposes
   * none. This is what was *observed* in the held window, so it undercounts any cycle that began and
   * ended between two cloud pushes. Never present it as a lifetime total.
   */
  cyclesObserved: number
  cyclesPerDay: number | null
  /**
   * What the box did, newest first — the source for the tab root's LATELY / TODAY / SINCE THE FAULT
   * band. Every row is a status *transition*: HA reports where the robot is, never how it got there,
   * so a status that held for six hours is one event at its start, not a row per poll.
   */
  events: LitterEventDto[]
}

/** The kinds of thing a household would say out loud about the box. Not a re-export of the 25 codes. */
export type LitterEventKind =
  | 'CatVisit'
  | 'CycleComplete'
  | 'ClearedItself'
  | 'Fault'
  | 'NeedsHuman'
  | 'Weight'
  | 'Offline'

/**
 * One thing the box did. The API sends the kind, not the sentence: the panel writes the English
 * because the sentences carry the household's name for the cat, and because the outcome tag and its
 * colour are presentation rather than data.
 */
export interface LitterEventDto {
  atUtc: string
  kind: LitterEventKind
  /** The code moved into — or, for `ClearedItself`, the code moved out of. */
  statusCode: string | null
  /** pylitterbot's own text for that code, so the panel never paraphrases it. */
  statusText: string | null
  /** The reading, where the event carries one — pet weight in pounds. */
  value: number | null
}

/** One day's closing levels; null where the recorder holds nothing for that day. */
export interface LitterDaySampleDto {
  day: string
  drawerPercent: number | null
  litterPercent: number | null
}

export interface LitterWeightSampleDto {
  atUtc: string
  pounds: number
}

/** Outcome of a manual cycle request; `reason` carries the robot's refusal when it declines. */
export interface CycleResultDto {
  started: boolean
  outcome: string
  step: string
  resultingCode: string | null
  reason: string | null
}

// ---- Meals (Stage M1) ----

/** Which meal a plan entry occupies. The week screen shows `Dinner` only for now. */
export type MealSlotName = 'Breakfast' | 'Lunch' | 'Dinner' | 'Other'

/** How a recipe got here. `JsonLd` arrives with the Stage M2 importer. */
export type RecipeImportMethodName = 'Manual' | 'JsonLd'

/**
 * Whether an imported recipe actually arrived usable. A paywalled page can emit valid
 * `Recipe` JSON-LD with the ingredients and steps stripped out, so a successful parse is
 * not a complete recipe — `Partial` rows carry `incompleteReason` saying what is missing.
 */
export type RecipeCompletenessName = 'Complete' | 'Partial'

/** A recipe as the folder list sees it — no ingredients or steps, which the list never shows. */
export interface RecipeSummaryDto {
  id: number
  title: string
  description: string | null
  sourceName: string | null
  servings: number | null
  yieldText: string | null
  totalMinutes: number | null
  hasImage: boolean
  importMethod: RecipeImportMethodName
  completeness: RecipeCompletenessName
  incompleteReason: string | null
  isArchived: boolean
  tags: string[]
  ingredientCount: number
  stepCount: number
  /** Minutes of lead time before the meal — an overnight marinade, a frozen joint. */
  leadMinutes: number | null
  /** What to do ahead, in the cook's words. Drives the week row's `START 14:00 · PORK OUT FRIDAY NIGHT`. */
  prepNote: string | null
  /**
   * Most recent past night this was actually eaten (`YYYY-MM-DD`), or null for `NEVER`. Counts
   * only confirmed nights — a night that came and went unanswered is not evidence anyone cooked
   * it, which is what keeps the `NOT LATELY` sort honest.
   */
  lastCookedDate: string | null
  /** How many past nights it was actually eaten. Drives `COOKED 2×`. */
  timesCooked: number
  /** Most recent past night it was planned and explicitly not eaten — the folder's `SKIPPED` state. */
  lastSkippedDate: string | null
  /**
   * The recipe this is a variation of (MEALS_FORK). A variation is an ordinary recipe that
   * remembers where it came from — this one field is all that makes it one.
   */
  forkedFrom: number | null
  /** The parent's title. Null once the parent is deleted; the lineage strip then drops its link. */
  forkedFromTitle: string | null
  version: number
}

/** The full recipe, for the detail screen and cook mode. */
export interface RecipeDto {
  id: number
  title: string
  description: string | null
  sourceUrl: string | null
  sourceName: string | null
  servings: number | null
  yieldText: string | null
  prepMinutes: number | null
  cookMinutes: number | null
  totalMinutes: number | null
  hasImage: boolean
  importMethod: RecipeImportMethodName
  completeness: RecipeCompletenessName
  incompleteReason: string | null
  isArchived: boolean
  tags: string[]
  ingredients: RecipeIngredientDto[]
  steps: RecipeStepDto[]
  leadMinutes: number | null
  prepNote: string | null
  /**
   * Who last edited this. Compare against the active profile before showing the attribution strip:
   * a profile is never told about, or attributed to, its own edit.
   */
  modifiedByProfileId: number | null
  /** That profile's display name, resolved server-side — "Ellen changed the amounts". */
  modifiedByName: string | null
  modifiedAtUtc: string | null
  forkedFrom: number | null
  forkedFromTitle: string | null
  createdUtc: string
  updatedUtc: string
  version: number
}

/** Save an edit as a new recipe rather than over the original (MEALS_FORK §5). */
export interface ForkRecipeInput {
  name: string
  ingredients?: RecipeIngredientInput[]
  servings?: number | null
  /** Record where it came from. Unchecking makes it a clean unlinked copy. */
  keepLink?: boolean
  modifiedByProfileId?: number | null
}

/**
 * `rawText` is what the panel renders — always. The parsed fields are best-effort and exist
 * only for serving scaling and shopping-list merging; a line the parser could not read leaves
 * them all null rather than guessing, so never fall back to them for display.
 */
export interface RecipeIngredientDto {
  id: number
  position: number
  rawText: string
  quantity: number | null
  unit: string | null
  name: string | null
  note: string | null
  sectionHeading: string | null
}

export interface RecipeStepDto {
  id: number
  position: number
  text: string
  sectionHeading: string | null
}

/** A tag and how many recipes carry it — the folder's Chip filter row. */
export interface RecipeTagCountDto {
  tag: string
  count: number
}

/**
 * Create/replace payload. Children are sent whole and replace what was stored: a recipe is
 * edited as a document, and `position` comes from array order, so reordering is a re-send.
 */
export interface RecipeInput {
  title: string
  description?: string | null
  sourceUrl?: string | null
  sourceName?: string | null
  servings?: number | null
  yieldText?: string | null
  prepMinutes?: number | null
  cookMinutes?: number | null
  totalMinutes?: number | null
  ingredients?: RecipeIngredientInput[]
  steps?: RecipeStepInput[]
  tags?: string[]
  isArchived?: boolean
  leadMinutes?: number | null
  prepNote?: string | null
  /**
   * Who is making this edit. Omitting it leaves the existing attribution alone rather than
   * clearing it, so an unattributed write doesn't erase who last actually changed the recipe.
   */
  modifiedByProfileId?: number | null
}

/** Only `rawText` is required; the parsed fields are the importer's job, not the panel's. */
export interface RecipeIngredientInput {
  rawText: string
  quantity?: number | null
  unit?: string | null
  name?: string | null
  note?: string | null
  sectionHeading?: string | null
}

export interface RecipeStepInput {
  text: string
  sectionHeading?: string | null
}

/**
 * Seven days of plan. Days with nothing planned are still present with an empty `entries`,
 * so the week screen renders seven ruled rows straight from the response.
 *
 * Dates here are plain `YYYY-MM-DD` calendar dates, **not** instants — a meal slot is
 * "Tuesday's dinner", so never parse these through `new Date()` and read the local day back.
 */
export interface MealWeekDto {
  start: string
  end: string
  days: MealDayDto[]
}

export interface MealDayDto {
  date: string
  entries: MealPlanEntryDto[]
}

/**
 * A planned meal. Holds a recipe, free text ("Leftovers"), or — for linked leftovers — both:
 * the row reads `freeText` but still opens `recipeId` at the servings it was cooked at. Never
 * neither; an empty slot is expressed by having no entry.
 */
export interface MealPlanEntryDto {
  id: number
  date: string
  slot: MealSlotName
  recipeId: number | null
  recipeTitle: string | null
  recipeHasImage: boolean
  freeText: string | null
  servingsOverride: number | null
  /**
   * Did the household actually eat this? `null` unanswered, `true` eaten, `false` skipped.
   * Written only by the confirm surface — never inferred from the date passing.
   */
  wasEaten: boolean | null
  /** Order within the slot. A night can hold a main, a side and a dessert (MEALS_GROUPS §6.1). */
  position: number
  /** A single-recipe night is always `Main`. */
  role: MealRoleName
  /** The recipe's cook time, denormalised so the night's order can be derived without N fetches. */
  totalMinutes: number | null
  version: number
}

/** What a recipe is to a night, or to a saved meal. Exactly three, deliberately (MEALS_GROUPS §1). */
export type MealRoleName = 'Main' | 'Side' | 'Dessert'

/**
 * A saved meal — a *named template* that expands into an arrangement.
 *
 * The distinction from an arrangement is the whole design: putting two recipes on a night costs
 * nothing and needs no name; a meal is only a shortcut for a pairing worth repeating.
 */
export interface MealSummaryDto {
  id: number
  name: string
  servings: number | null
  prepNote: string | null
  cuisine: string | null
  isArchived: boolean
  /** Component titles in order — the folder's meta line names the parts rather than badging them. */
  recipeTitles: string[]
  recipeCount: number
  totalMinutes: number | null
  /** History for the meal **as a unit**: nights where the whole set was confirmed eaten. */
  lastCookedDate: string | null
  timesCooked: number
  version: number
}

export interface MealDto {
  id: number
  name: string
  servings: number | null
  prepNote: string | null
  cuisine: string | null
  isArchived: boolean
  components: MealComponentDto[]
  totalMinutes: number | null
  lastCookedDate: string | null
  timesCooked: number
  modifiedByProfileId: number | null
  modifiedByName: string | null
  modifiedAtUtc: string | null
  version: number
}

export interface MealComponentDto {
  recipeId: number
  title: string
  role: MealRoleName
  position: number
  totalMinutes: number | null
  servings: number | null
  sourceName: string | null
}

export interface MealInput {
  name: string
  components?: { recipeId: number; role?: MealRoleName }[]
  servings?: number | null
  prepNote?: string | null
  cuisine?: string | null
  isArchived?: boolean
  modifiedByProfileId?: number | null
}

/** Expands the meal into plan entries; the night does not reference the meal (MEALS_GROUPS §6.2). */
export interface AssignMealInput {
  date: string
  slot: MealSlotName
  mealId: number
  servingsOverride?: number | null
}

/** A set of recipes confirmed cooked together, and how often. Offered for naming at three. */
export interface CoOccurrenceDto {
  recipeIds: number[]
  titles: string[]
  times: number
}

/**
 * How much of a recipe the importer actually got (meals-planning.md D10).
 *
 * `Empty` means nothing was written — a valid page that publishes no recipe data. `Partial` means
 * a recipe was saved but the page withheld part of it, which is the paywall shape: a well-formed
 * `Recipe` node with the ingredients and steps stripped out.
 */
export type ImportConfidenceName = 'Complete' | 'Partial' | 'Empty'

export interface RecipeImportInput {
  url: string
  /** Sets attribution only — there is no auth on this endpoint to derive it from. */
  profileId?: number | null
}

export interface RecipeImportResponse {
  confidence: ImportConfidenceName
  /** Null when nothing was saved. */
  recipe: RecipeDto | null
  /** What is missing, or why nothing was saved. Null on a clean import. */
  reason: string | null
}

/** Answer the morning-after ask for one night. The only thing that writes `wasEaten`. */
export interface MealEatenInput {
  date: string
  slot: MealSlotName
  wasEaten: boolean | null
}

/** Assign a slot. At least one of `recipeId` / `freeText`; both together is linked leftovers. */
export interface MealPlanInput {
  date: string
  slot: MealSlotName
  recipeId?: number | null
  freeText?: string | null
  /** Role on the night. The first recipe is always the Main whatever this says. */
  role?: MealRoleName
  /**
   * `true` (the default) clears the slot first — the historic behaviour every pre-meals caller
   * relies on. `false` adds alongside, which is how a night grows a side.
   */
  replace?: boolean
  /**
   * Who is making the change. Attribution only, and its sole use is deciding whether the rest of
   * the household is told — a change made at the panel by the person standing at it stays quiet.
   */
  profileId?: number | null
  servingsOverride?: number | null
}

// ---- Pantry (Stage M5) ----

/** Cupboard · Fridge · Freezer. Three places, fixed (PANTRY_DATA_CONTRACT §1). */
export type PantryLocationName = 'Cupboard' | 'Fridge' | 'Freezer'

/**
 * How much the panel claims to know about an item — the idea the section is arranged around.
 *
 * `Counted` gets arithmetic, `Estimated` moves one step at a time, `NotCounted` is never deducted
 * and never reported missing. Confusing the last two is what would make the shortfall list ask you
 * to buy salt (DECISIONS PG2), which is why they are three words rather than a flag.
 */
export type TrackingClassName = 'Counted' | 'Estimated' | 'NotCounted'

export type EstimateStateName = 'Plenty' | 'Low' | 'None'

export type PantryEventKindName =
  | 'Scanned' | 'Imported' | 'TypedIn' | 'CheckedOff'
  | 'Deducted' | 'Corrected' | 'MarkedLow' | 'MarkedOut' | 'Undone'

/**
 * One thing on a shelf. **`lastSeenAtUtc` is never dropped by the UI** — PANTRY_BEHAVIOURS §9 makes
 * any string asserting a quantity without a date a bug, so every row renders the two together and
 * `null` renders `NEVER SEEN` rather than nothing.
 */
export interface PantryItemDto {
  id: number
  name: string
  location: PantryLocationName
  tracking: TrackingClassName
  quantity: number | null
  unit: string | null
  estimateState: EstimateStateName | null
  lastSeenAtUtc: string | null
  lastSeenByName: string | null
  catalogueRef: string | null
  isArchived: boolean
  version: number
}

export interface PendingImportDto {
  id: number
  vendorLabel: string | null
  deliveredAtUtc: string | null
  lineCount: number
}

/** Everything 9a renders. The tally comes from the server so it cannot disagree with the rows. */
export interface PantryListDto {
  items: PantryItemDto[]
  total: number
  probablyLow: number
  probablyOut: number
  lastTouchedByName: string | null
  lastTouchedAtUtc: string | null
  pendingImports: PendingImportDto[]
}

export interface PantryItemInput {
  name: string
  location: PantryLocationName
  tracking: TrackingClassName
  quantity?: number | null
  unit?: string | null
  estimateState?: EstimateStateName | null
  profileId?: number | null
}

export interface PantryEventDto {
  id: number
  pantryItemId: number
  kind: PantryEventKindName
  delta: number | null
  resultingQuantity: number | null
  resultingState: EstimateStateName | null
  atUtc: string
  byName: string | null
  undone: boolean
}

/** Scan one pack. Idempotent on `scanRunId` + `sequence`, so two phones on one delivery both add. */
export interface ScanInput {
  barcode: string
  /** What BarcodeDetector reported. Settles the ambiguous 8-digit EAN-8 / UPC-E case. */
  format?: string | null
  delta: number
  location?: PantryLocationName | null
  scanRunId: string
  sequence: number
  profileId?: number | null
}

/**
 * What an outside catalogue thinks an unknown barcode is.
 *
 * `source` is shown, not hidden: the pantry stores the household's own words, so a name that came
 * from a stranger's database has to say so while somebody decides whether to keep it.
 */
export interface ProductSuggestionDto {
  name: string
  brand: string | null
  unit: string | null
  packSize: number | null
  source: string
}

/** `matched: false` is the first-class "not in the catalogue" row, not an error (DECISIONS PG4). */
export interface ScanResultDto {
  matched: boolean
  barcode: string
  item: PantryItemDto | null
  eventId: number | null
  /** Present only with `matched: false`. Pre-fills `NAME IT`; never creates anything on its own. */
  suggestion: ProductSuggestionDto | null
}

export interface CatalogueInput {
  barcode: string
  format?: string | null
  name: string
  unit?: string | null
  location: PantryLocationName
  tracking: TrackingClassName
  packSize?: number | null
  profileId?: number | null
}

/**
 * Six values, because "we don't know" is the honest answer far more often than yes or no.
 * `Fine` and `NotCounted` never appear under `WORTH A LOOK`; the other four do.
 */
export type StockStatusName = 'Fine' | 'Short' | 'Gone' | 'Unknown' | 'NotCounted' | 'NoMatch'

export interface StockCheckLineDto {
  ingredientId: number
  name: string
  needed: string | null
  status: StockStatusName
  pantryItemId: number | null
  lastSeenQuantity: number | null
  lastSeenUnit: string | null
  lastSeenState: EstimateStateName | null
  lastSeenAtUtc: string | null
}

export interface StockCheckDto {
  recipeId: number
  recipeTitle: string
  servings: number
  lines: StockCheckLineDto[]
  flaggedCount: number
  totalLines: number
  notCountedNames: string[]
  /** Null below three recorded deliveries — the clause is omitted rather than guessed (§3). */
  usualDeliveryWeekday: string | null
}

export interface CorrectStockInput {
  lines: { pantryItemId: number; atLeast?: number | null }[]
  profileId?: number | null
}

export interface ReceiptLineDto {
  eventId: number
  pantryItemId: number
  name: string
  from: number | null
  to: number | null
  resultingState: string | null
  note: string | null
  undone: boolean
}

/** Everything on 9f is already applied. The ticks are undo, not consent. */
export interface DeductionReceiptDto {
  planEntryId: number
  dishName: string
  servings: number
  date: string
  counted: ReceiptLineDto[]
  estimated: ReceiptLineDto[]
  leftAlone: string[]
  hitNone: number[]
}

export type GroceryLineSourceName = 'Meal' | 'Hand' | 'LowStock'

export interface GroceryProvenanceDto {
  label: string
  forDate: string | null
}

export interface GroceryLineDto {
  id: number
  text: string
  quantity: number | null
  unit: string | null
  pantryItemId: number | null
  sourceKind: GroceryLineSourceName
  provenance: GroceryProvenanceDto[]
  checkedAtUtc: string | null
  /** "Put 1 lb in the fridge" — shown in place of provenance once ticked. */
  returnTrip: string | null
  version: number
}

/** Four states, all supported — mirroring off is a normal way to run this (PANTRY_BEHAVIOURS §8). */
export type MirrorStateName = 'Off' | 'Healthy' | 'Failing' | 'SignInExpired'

export interface MirrorStatusDto {
  state: MirrorStateName
  listName: string | null
  ownerName: string | null
  lastSyncedUtc: string | null
  lastAttemptUtc: string | null
  queuedCount: number
  message: string | null
}

export interface GroceryListDto {
  lines: GroceryLineDto[]
  openCount: number
  mirror: MirrorStatusDto
}

export interface GroceryInput {
  text: string
  quantity?: number | null
  unit?: string | null
  pantryItemId?: number | null
  sourceKind?: GroceryLineSourceName
  sourceRecipeId?: number | null
  sourceRecipeTitle?: string | null
  sourceDate?: string | null
  profileId?: number | null
}

export interface MirrorSettingsInput {
  todoListId: string | null
  todoListName: string | null
  ownerProfileId: number | null
}

export type OrderImportSourceName = 'Email' | 'Share' | 'Photo'
export type OrderImportStatusName = 'Pending' | 'Applied' | 'Discarded'

/** `WeightGuess` renders in brass with its guess sentence, never as a plain number (PG5). */
export type ImportLineConfidenceName = 'Matched' | 'New' | 'WeightGuess' | 'Unreadable'

export interface OrderImportLineDto {
  id: number
  /** Always displayed. It is how a wrong interpretation gets caught. */
  rawText: string
  proposedName: string | null
  proposedQuantity: number | null
  proposedUnit: string | null
  proposedLocation: PantryLocationName
  proposedTracking: TrackingClassName
  matchedPantryItemId: number | null
  confidence: ImportLineConfidenceName
  guessFromPounds: number | null
  position: number
}

export interface OrderImportDto {
  id: number
  source: OrderImportSourceName
  vendorLabel: string | null
  deliveredAtUtc: string | null
  status: OrderImportStatusName
  lines: OrderImportLineDto[]
  matchedCount: number
  newCount: number
  unreadableCount: number
  /** Set on a 409 — "Lincoln put this away four minutes ago". */
  appliedByName: string | null
  appliedAtUtc: string | null
}

export interface OrderImportInput {
  source: OrderImportSourceName
  vendorLabel?: string | null
  rawPayload: string
  deliveredAtUtc?: string | null
}

export interface ImportLineInput {
  proposedName?: string | null
  proposedQuantity?: number | null
  proposedUnit?: string | null
  proposedLocation?: PantryLocationName | null
  proposedTracking?: TrackingClassName | null
  matchedPantryItemId?: number | null
}
