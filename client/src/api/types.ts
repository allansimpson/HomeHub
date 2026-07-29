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
}

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
}

/** A Google calendar offered for display, with its current selection (CONFIG · choose-calendars). */
export interface SyncCalendarDto {
  calendarId: string
  name: string
  selected: boolean
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
