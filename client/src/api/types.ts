/** Shared API shapes for Stage 1 (profiles + household settings). Mirror the C# DTOs. */

/** What a member may do on the panel. Mirrors the C# `ProfileRole` (enums serialize as strings). */
export type ProfileRole = 'Member' | 'Admin'

export interface ProfileDto {
  id: number
  name: string
  initial: string
  hasPin: boolean
  requirePinWhenIdle: boolean
  stayLoggedIn: boolean
  displayOrder: number
  /** Household administrator; everyone else is a Member. */
  role: ProfileRole
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
   * What the household calls the child — the name the Baby tab leads with.
   *
   * Kept by the panel rather than read from the integration it used to come from: the Care log is
   * HomeHub's own now, and a header that says "Baby" until an upstream service answers is a panel
   * naming a child after a system outage. Null falls back to the literal word, which is also what
   * the nav cell says in every state.
   */
  babyName: string | null
  /**
   * Waste-drawer fullness (%) at which the panel raises a change-the-litter alert and notification.
   *
   * Deliberately ahead of the robot's own drawer-full fault, which only fires once the box has
   * already stopped cycling — by then the choice has been made for you.
   */
  litterFullPercent: number
  /**
   * The night window, `HH:mm` in local wall time. A start later than the end is the ordinary case —
   * the window crosses midnight.
   *
   * Local, not UTC: this is a fact about when the household stops wanting a bright screen in the
   * room, and a UTC window would shift by an hour twice a year. `idleDimmingEnabled` is the switch
   * above it; the manual override is panel-local and lives nowhere on the server.
   */
  nightDimStart: string
  nightDimEnd: string
  /**
   * Whether Assist keeps conversations at all. Off means the chat in front of you is all there is —
   * no list, no history, nothing to search.
   *
   * Household state rather than panel state, because the transcripts are: they moved off the panel's
   * `localStorage` when Assist became a chat system a phone can also read, and a policy held on one
   * device would leave the two disagreeing about the household's own conversations.
   */
  storeConversations: boolean
  /** Days a conversation is kept after its last message. Enforced on read, not by a timer. */
  conversationRetentionDays: number
  /**
   * Whether a photograph read into an engagement is kept with it.
   *
   * Governs new engagements only. Turning it off does not go back and delete flyers already kept —
   * a privacy switch that removed things the household had been relying on would be a worse surprise
   * than the one it exists to prevent.
   */
  keepEventPhotos: boolean
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

  /**
   * The CAP product behind the banner — everything the one-line banner has no room for, shown by
   * the statement sheet (`design_handoff_weather_alert/ALERT_SHEET.md` §2).
   *
   * **Optional, not merely nullable.** Two different things are absent here and both are ordinary.
   * An alert that is only ever a banner line — every sensor threshold — sends these as null. And a
   * panel running a newer bundle than the API it is talking to will not receive the keys at all,
   * which on this project is a routine state rather than a fault: what is deployed and what is
   * built move separately (`brain/STATE.md`). Typing them as present-but-null would make the second
   * case a lie the compiler helps tell.
   *
   * `event` is the field to test: it is the sheet's title, so an alert without one has no sheet to
   * open and its banner stays inert. The rest are independently absent because CAP makes them so —
   * a Special Weather Statement routinely carries no `instruction`, and the sheet drops that whole
   * section rather than printing a placeholder.
   */
  expiresAtUtc?: string | null
  event?: string | null
  /** CAP `description`, verbatim. NWS's hard line wraps survive the trip; the sheet reflows them. */
  description?: string | null
  /** CAP `instruction` — the call to action. Absent on most statements and advisories. */
  instruction?: string | null
  /** CAP `areaDesc` — counties, semicolon-separated at the source. */
  areaDesc?: string | null
  /** CAP `senderName`, e.g. `NWS Minneapolis MN`. */
  senderName?: string | null
  /** CAP `sent` — when the office issued it, which is not when the panel noticed. */
  sentUtc?: string | null
  /** CAP `onset ?? effective` — start of the IN EFFECT window. */
  onsetUtc?: string | null
  /** CAP `ends` — end of the IN EFFECT window, which can fall before `expiresAtUtc`. */
  endsUtc?: string | null
  urgency?: string | null
  certainty?: string | null
  /** CAP `severity` as NWS worded it — `severity` above collapses Extreme into Severe. */
  severityText?: string | null
  /** CAP `id`, for the provenance footer that lets somebody check the panel against weather.gov. */
  productId?: string | null
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

/**
 * Where the forecast is for, as the provider names it.
 *
 * Reported by NWS from the coordinates, never typed by anybody — which is what makes it worth putting
 * on the screen. A household that set a latitude and longitude has no way to check they got the digits
 * right; a town name is the forecast provider's own answer to "where do you think this is", and it is
 * the only answer that matters when the numbers are wrong.
 */
export interface PlaceDto {
  city: string
  /** Two-letter state abbreviation. Null where NWS gave none. */
  state: string | null
  /** `Minneapolis, MN` — what the screens actually draw. */
  label: string
}

export interface WeatherSnapshotDto {
  current: CurrentWeatherDto | null
  hourly: HourlyDto[]
  daily: DailyDto[]
  fetchedAtUtc: string | null
  /** Home location for the radar view. */
  latitude: number | null
  longitude: number | null
  /** Null before the first refresh, and for a point NWS cannot name. */
  place: PlaceDto | null
}

/** The weather-location page's whole state — see `SettingsController.GetWeatherLocation`. */
export interface WeatherLocationDto {
  /** In force right now: the household's coordinates if they set any, else the deployment's. */
  latitude: number
  longitude: number
  /**
   * Whether that is the household's own answer or the configured fallback.
   *
   * Said out loud on the page, because "the panel is showing a forecast for somewhere I did not
   * choose" is otherwise indistinguishable from "I chose this and mistyped it".
   */
  fromHousehold: boolean
  /** What the provider called it on the last refresh. Null before there has been one. */
  place: string | null
}

// ---- Stage 4: calendar ----

export interface CalendarEventDto {
  id: number
  title: string
  startUtc: string
  endUtc: string
  /**
   * Whole days rather than an hour of one — stated by the server, not inferred here.
   *
   * `startUtc`/`endUtc` still bound the event when this is true: local midnight to local midnight,
   * end exclusive. See {@link isAllDay} in `app/calendarMarks`, which prefers this flag and keeps
   * the old boundary heuristic only for rows synced before the column existed.
   */
  isAllDay: boolean
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
  /**
   * Read off a photograph rather than typed.
   *
   * Drives the FROM A PHOTO line under a calendar row, and stays true whether or not the picture
   * survived — how an event reached the calendar is a fact about the event, not about some bytes.
   */
  fromPhoto: boolean
  /** Whether the source photograph is still there to show. Fetch it from `/events/{id}/photo`. */
  hasPhoto: boolean
  /**
   * The photograph's EXIF original date, or null.
   *
   * Null is ordinary rather than missing: a screenshot carries no EXIF, so the detail screen reads
   * ADDED instead of TAKEN rather than passing off a file's timestamp as when a camera was pointed
   * at something.
   */
  photoTakenUtc: string | null
  /**
   * When the engagement was written down, or null for a row older than the column.
   *
   * The date the ADDED form of the source label shows — a screenshot has no EXIF, so there is no
   * TAKEN to show and the file's own timestamp is not an answer. Not the edited-at time, which
   * answers a different question and moves.
   */
  createdUtc: string | null
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
  /**
   * Whole days rather than an hour of one. Send local midnight to local midnight, end exclusive —
   * the zone is this device's, because there is no household timezone and the panel is the only
   * thing that knows one.
   */
  isAllDay?: boolean
  location: string | null
  notes: string | null
  ownerIds: number[]
  /** Owning profile (whose Google account the event is created on). Null for the local calendar. */
  profileId?: number | null
  /** Target Google calendar for a new event; null = the profile's primary calendar. */
  googleCalendarId?: string | null
  /** Mark for this one event, overriding its kind and its calendar's mark; null to inherit. */
  mark?: string | null
  /**
   * The photograph this engagement was read from, base64 without a data-URL prefix.
   *
   * Sent with the *write*, not with the reading: a flyer is kept because somebody pressed ADD TO
   * CALENDAR, so a photo that was read and discarded leaves nothing behind. The server stores it and
   * keeps only the filename.
   */
  photoBase64?: string | null
  /** The photograph's EXIF original date, or null when it carried none. */
  photoTakenUtc?: string | null
  /** Whether this engagement came off a photograph at all — true even when the photo is not kept. */
  fromPhoto?: boolean
}

// ---- Reading an engagement off a photograph ----

/**
 * A photograph handed over to be read, and the day the panel believes it is.
 *
 * `localDate` is sent rather than left to the server because it is the anchor for an unstated year —
 * "Saturday 14 September" is next September or last September depending on what today is — and there
 * is no household timezone here to reconcile the two clocks with.
 */
export interface ReadPhotoRequest {
  imageBase64: string
  mediaType: string
  /** The panel's own date, `YYYY-MM-DD`. */
  localDate: string
  /** What the member typed alongside the photo. A hint, never an instruction. */
  context?: string | null
}

/** `Empty`, `Partial` or `Complete` — the same verdict vocabulary as recipe import. */
export type ExtractionConfidenceName = 'Empty' | 'Partial' | 'Complete'

export interface ReadPhotoResponse {
  confidence: ExtractionConfidenceName
  events: DraftEventDto[]
  /** A sentence for the household when there is nothing, else null. */
  reason: string | null
  /**
   * Whether a reading could be attempted at all.
   *
   * Separate from an empty result on purpose. "There is no date on that photograph" and "this panel
   * cannot read photographs" are different facts, and only one of them is about the photograph — the
   * panel stays quiet for the second rather than blaming a picture that may be perfectly clear.
   */
  available: boolean
}

/**
 * One engagement as read, before anybody has confirmed it.
 *
 * <b>Dates without zones.</b> `date`, `begins` and `ends` are calendar values, not instants: the
 * confirm sheet resolves them to UTC when the household presses ADD TO CALENDAR, because the
 * confirming device is the only thing in the system that knows a timezone.
 */
export interface DraftEventDto {
  /** Stable within one reading, so the sheet can tick and untick rows. */
  id: string
  /** What the engagement is. Empty when the photograph named no event. */
  title: string
  /** `YYYY-MM-DD`. */
  date: string
  /**
   * Whole days rather than an hour of one. True whenever the photograph gave a date and no hour —
   * most school and deadline flyers — because the alternative is inventing a time, and an invented
   * 9 AM is indistinguishable from a read one.
   */
  allDay: boolean
  /** `HH:MM:SS`, or null when {@link allDay}. */
  begins: string | null
  /** `HH:MM:SS`, or null when {@link allDay}. */
  ends: string | null
  where: string | null
  note: string | null
  /** Fields read badly — a fold, glare, small print. Drives the amber underline. */
  lowConfidence: DraftField[]
  /** Fields not on the photograph at all, filled by rule. Same amber, different sentence under it. */
  assumed: DraftField[]
}

/** The field names {@link DraftEventDto.lowConfidence} and {@link DraftEventDto.assumed} carry. */
export type DraftField = 'title' | 'date' | 'year' | 'begins' | 'ends' | 'where'

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

// ---- Climate ----
//
// Zones are rooms; units are machines. The screen reads zones and writes *targets*; a unit's set
// point belongs to the control loop and appears only in the drill-in, as a fact.

export type ClimateModeName = 'Off' | 'Cool' | 'Heat' | 'Fan' | 'Auto'

/** A mini-split as it reports itself. Drill-in only — no row on the Climate list shows a set point. */
export interface ClimateUnitDto {
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

/** Automated rooms get the band and the gesture; the other two are read, never commanded. */
export type ZoneClassName = 'Automated' | 'Watched' | 'ColdStorage'

export type CorrectionName = 'Gentle' | 'Steady' | 'Hard'

/**
 * The state the server says a room is in. The panel turns this into the row's sentence and its
 * colour — see `climateCopy.ts`.
 *
 * `standing` is the one state the server never sends: "for the rest of the session" is a fact about
 * this panel rather than about the house, so the screen raises it from `previousStandingTargetF`
 * plus what it has seen itself do.
 */
export type ZoneStateName =
  | 'holding' | 'correcting' | 'cantHold' | 'borrowed' | 'backOn' | 'standing'
  | 'probeLost' | 'paused' | 'quiet' | 'unreachable' | 'unitOff' | 'noProbe'
  | 'watched' | 'inRange' | 'outOfRange'

export interface ZoneOverrideDto {
  targetF: number
  startedAtUtc: string
  expiresAtUtc: string
}

export interface LoopWriteDto {
  id: number
  atUtc: string
  probeF: number | null
  targetF: number
  setPointFrom: number | null
  setPointTo: number
  reason: string
  outcome: 'Written' | 'Unreachable' | 'Rejected' | 'Skipped'
  error: string | null
}

export interface ClimateZoneDto {
  id: number
  name: string
  class: ZoneClassName
  /** Null when the probe is silent — a reading older than 15 minutes is never sent. */
  readingF: number | null
  humidity: number | null
  readingAtUtc: string | null
  probeSilentMinutes: number | null
  /** The number a person owns. Null on watched and cold-storage rows. */
  standingTargetF: number | null
  standingSetAtUtc: string | null
  /** The effective target: the live loan's, or the standing one. */
  targetF: number | null
  toleranceF: number
  correction: CorrectionName
  quietFrom: string
  quietTo: string
  isPaused: boolean
  pausedAtUtc: string | null
  override: ZoneOverrideDto | null
  /** Present for as long as UNDO should be reachable — the way out of a promotion. */
  previousStandingTargetF: number | null
  state: ZoneStateName
  steadySinceUtc: string | null
  etaLocal: string | null
  above: boolean | null
  deviationF: number | null
  outsideMinutes: number | null
  unreachableSinceUtc: string | null
  degraded: boolean
  overrideEndedAtUtc: string | null
  lowBattery: boolean
  rangeLowF: number | null
  rangeHighF: number | null
  outOfRangeMinutes: number | null
  ratePerHour: number | null
  unitSetPointF: number | null
  unitMode: ClimateModeName | null
  probeRef: string | null
  unitRef: string | null
  /** The sensor zone behind the probe — where `24H ▸` goes. */
  sensorZoneId: number | null
  lastWrite: LoopWriteDto | null
}

/** "You've cooled the Master Bedroom to about 69° three evenings running. Make it standing?" */
export interface RepeatOfferDto {
  zoneId: number
  zoneName: string
  targetF: number
  windowHour: number
}

/** Everything the Climate screen renders, in one call. */
export interface ClimatePanelDto {
  housePaused: boolean
  zones: ClimateZoneDto[]
  offer: RepeatOfferDto | null
  atUtc: string
}

/** The four per-room knobs. Only what is sent is changed. */
export interface ClimateZonePatch {
  toleranceF?: number
  correction?: CorrectionName
  quietFrom?: string
  quietTo?: string
  isPaused?: boolean
}

// ---- Stage 7: AI assistant ----

/**
 * Which backend answered. Mirrors the C# `AssistantOrigin` by name — enums cross as strings, so
 * these move in lockstep or the indicator renders blank.
 *
 * `Agent` is the deliberate path: still on the LAN, but slower, with memory, and able to act.
 */
export type AssistantOriginName = 'Local' | 'Cloud' | 'Agent'

export interface AssistantChatRequest {
  history: { role: string; text: string }[]
  prompt: string
  imageBase64?: string | null
  imageMediaType?: string | null
  force?: string | null
  /** Signed-in profile, so an in-app action (add a task, …) runs as that member. */
  profileId?: number | null
  /**
   * True when the answer will be read aloud. Pins the turn to the fast on-server model: a spoken
   * reply has a couple of seconds before the silence is the answer, and the agent path does not fit
   * in that. Text turns have a screen to wait on, so they get the better answer instead.
   */
  spoken?: boolean
}

export interface AssistantChatResponse {
  text: string
  origin: AssistantOriginName
  escalated: boolean
  model: string | null
  /** Set (e.g. "task") when the turn performed an in-app action, so the UI can refresh. */
  action?: string | null
}

// ---- Assist: the chat system (ASSIST.md) ----

/** One agent on the roster — a Hermes profile with its own memory, sessions and skills. */
export interface Agent {
  key: string
  /** What the household calls it. The Assist header and the composer placeholder both read this. */
  name: string
  /** The dropdown's second line, e.g. "Household · default agent". */
  tagline: string | null
  isDefault: boolean
  /**
   * Whether this agent has an address and a credential — **not** whether it is reachable. Knowing
   * that would cost a network call on every poll. A configured-but-down agent still lists; the turn
   * is what discovers the outage.
   */
  configured: boolean
  /** Unread chats with this agent. Rides the dropdown so nothing hides behind the switch. */
  unread: number
}

/** One agent as the Config assignment editor sees it — every configured agent, granted or not. */
export interface AssignableAgent {
  key: string
  name: string
  tagline: string | null
  /** Has an address and a credential. Still assignable if false; Config says so rather than hiding it. */
  configured: boolean
  /**
   * The household agent. Always assigned and not removable — a member with no agent would have an
   * Assist tab that cannot do anything.
   */
  isHouseholdAgent: boolean
  assigned: boolean
  /**
   * The one Assist opens on for this member.
   *
   * Exactly one row carries it, and with no choice made it is the household agent's — so the editor
   * draws a chosen state rather than needing a second, emptier answer for "nobody has decided".
   */
  isMemberDefault: boolean
}

export interface AgentAssignments {
  agents: AssignableAgent[]
}

/** A row in the conversation list. */
export interface Conversation {
  id: number
  agentKey: string
  title: string
  /** Who spoke last — the member's name or the agent's. Renders as the row's `Speaker — ` prefix. */
  speaker: string
  preview: string
  startedAtUtc: string
  lastAtUtc: string
  pinned: boolean
  /** Null is active. Set is archived, and the date is what the archive row shows. */
  archivedAtUtc: string | null
  unread: boolean
  unreadCount: number
  messageCount: number
}

/** Everything the Assist main screen renders, in one call. */
export interface ConversationList {
  conversations: Conversation[]
  /** Drives `ARCHIVED CHATS (n)` — the only entry point to the archive. */
  archivedCount: number
  /** False means the household turned storing off: the list is empty by policy, and says so. */
  storeConversations: boolean
  retentionDays: number
  agents: Agent[]
}

export interface ConversationMessage {
  id: number
  role: 'user' | 'assistant'
  text: string
  atUtc: string
  origin: AssistantOriginName | null
  escalated: boolean
  /** The IT TOUCHED receipt — the kind of in-app write this turn performed. */
  action: string | null
  /**
   * What was handed over with this turn, if anything.
   *
   * **The name, not the thing.** Neither an image's bytes nor a text file's contents are stored — an
   * attachment is sent, not kept. This exists so that a member who attaches a photo, sends it and
   * watches the stored transcript reload does not find their message reading as though they had asked
   * about nothing at all. On a shared panel the person reading a turn is often not the one who sent
   * it, and a question about a picture nobody can see is not a question.
   */
  attachmentName: string | null
  attachmentKind: 'image' | 'text' | null
  attachmentBytes: number | null
}

export interface ConversationDetail {
  conversation: Conversation
  messages: ConversationMessage[]
}

/**
 * One turn. **No history array** — the server holds the transcript now, and with a Hermes session
 * there is no history to send at all because the session is the context.
 *
 * Omitting `conversationId` starts a new chat: there is no NEW CHAT button, so the absence of an id
 * is the signal.
 */
export interface AssistChatRequest {
  conversationId?: number | null
  agentKey?: string | null
  prompt: string
  imageBase64?: string | null
  imageMediaType?: string | null
  force?: string | null
  /** What the attached file was called on the member's device. Shown in the transcript. */
  attachmentName?: string | null
  /** `image` or `text` — the two things a Hermes content part can be. */
  attachmentKind?: 'image' | 'text' | null
  /** The original file's size, for the transcript's meta line. */
  attachmentBytes?: number | null
  /**
   * A text-like file's contents, read on the panel and already capped.
   *
   * Separate from `prompt` rather than pasted into it: the prompt is what the member said and is what
   * the ledger stores, while this is what they handed over. Folding a file into the prompt would put
   * ten thousand characters of CSV into the household's transcript under somebody's name.
   */
  attachmentText?: string | null
  // No profileId. The server reads the member from the session cookie (AUDIT A1.2); sending one
  // used to let a caller file a chat into somebody else's history.
  spoken?: boolean
}

export interface AssistChatResponse {
  /** The chat this landed in, new or existing. `0` when the household has storing switched off. */
  conversationId: number
  title: string
  message: ConversationMessage
  origin: AssistantOriginName
  escalated: boolean
  model: string | null
}

/** Absent means leave it alone — a swipe-to-pin must not silently unarchive. */
export interface UpdateConversationRequest {
  pinned?: boolean
  archived?: boolean
  read?: boolean
  /**
   * A name the household typed. The one title Assist will not write over — a chat is named twice
   * before anyone sees it (from the opening turn, then by the agent), and this ends that.
   */
  title?: string
}

export interface DeleteConversationsResponse {
  deleted: number
  /**
   * How many Hermes transcripts went with them. Short of `deleted` means the modal's promise about
   * the agent's memory was only partly kept — the agent was unreachable.
   */
  agentTranscriptsRemoved: number
}

/** One hit. Search is per **match**, not per chat. */
export interface SearchHit {
  conversationId: number
  title: string
  atUtc: string
  archived: boolean
  snippet: string
  /** Offset of the term within `snippet`, so the highlight lands on the right occurrence. */
  matchStart: number
  matchLength: number
}

export interface SearchResults {
  hits: SearchHit[]
  matches: number
  conversations: number
}

/**
 * What became of a turn whose stream the panel lost — `GET /assist/chat/turns/{id}`.
 *
 * There is no `failed` status. A turn that could not run at all never got far enough to be worth
 * remembering, and the 404 that answers for it already means the same thing to the panel: stop
 * asking, and read the stored transcript.
 */
export interface TurnStatus {
  status: 'running' | 'done'
  /** The chat it landed in, or 0 when the household stores none. */
  conversationId: number
  /** The stored reply, or 0 when nothing was stored. */
  messageId: number
  /** Why the reply stops where it does. Null while it is still running. */
  finishReason: string | null
  /**
   * The reply itself — the whole of it, not the prefix that arrived before the connection died.
   *
   * Kept by the server because for a household with conversation storage switched off the stream was
   * the only copy, so there is nowhere else for a reconnecting panel to read the answer from.
   */
  text: string | null
  /** The kind of write the turn made, for the IT TOUCHED receipt. */
  action: string | null
}

/**
 * Who this device is signed in as (AUDIT A1). Replaces `VerifyPinResult`, which reported whether a
 * PIN was right and left it to the client whether to care.
 */
export interface SessionDto {
  /** Null when nobody is signed in on this device. */
  profileId: number | null
  name: string | null
  /** Whether to offer the admin-only parts of Config. The server enforces it regardless. */
  isAdmin: boolean
  signedIn: boolean
}

/** Why a sign-in was refused, and how long to wait if it was the lockout. */
export interface SignInFailure {
  message: string
  retryAfterSeconds?: number | null
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

// ---- Litter (Litter-Robot via Home Assistant) ----

/**
 * Five deliberately distinguishable states. "HA is down" and "the integration isn't there" need
 * different fixes and the panel says which; `NotConfigured` is not an error.
 *
 * Declared here rather than shared: this was `= BabyStatusName` until the Huckleberry integration
 * was removed on 2026-08-30, which is a fair description of where it was first written but not of
 * what it means. It is the health of a Home Assistant-backed integration, and the litter robot is
 * the only one of those the panel still has.
 */
export type CatStatusName =
  | 'NotConfigured'
  | 'Ok'
  | 'HomeAssistantUnreachable'
  | 'IntegrationMissing'
  | 'Stale'

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
/**
 * How a recipe got here. `Pasted` is distinct from `Manual` on purpose: both were entered by a
 * person, but a pasted recipe went through the ingredient parser and so has amounts that scale.
 */
export type RecipeImportMethodName = 'Manual' | 'JsonLd' | 'Pasted'

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
  /**
   * The single word a planned week row carries (PLAN_WEEK §1).
   *
   * On the week response rather than fetched per night: the alternative is a stock check per row,
   * seven round trips to draw seven words, on the screen that opens most.
   */
  stockSummary: PlanStockSummaryName | null
}

/**
 * How a planned night reads at a glance.
 *
 * `NoClaim` is a night that reserves nothing — free text, takeaway, or out. It is a plan, not a gap
 * (PLAN_WEEK §1), which is why it has its own word rather than being left blank.
 */
export type PlanStockSummaryName = 'NoClaim' | 'Covered' | 'Short' | 'Unknown'

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
  /** What to call it. Overrides the page's own title, which is a headline as often as a name. */
  title?: string | null

}

/**
 * A recipe copied off a page and pasted in — the path for publishers that refuse the fetcher.
 *
 * `sourceUrl` is kept as attribution and is **never fetched**: this endpoint does no network I/O at
 * all, which is exactly why it works where the link importer cannot.
 */
export interface RecipePasteInput {
  text: string
  sourceUrl?: string | null
  /** What to call it. Overrides the name the parser reads off the top of the block. */
  title?: string | null
  /** The cuisine chip — the parser has no way to read that off a block of text. */
  tags?: string[] | null
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
  /**
   * How many actually sat down, when fewer did than were cooked for (COOKING_AND_AFTER §2's
   * `OR SOME OF IT`).
   *
   * Omitted means everyone — a plain yes, and nothing spare. The difference between this and the
   * night's servings is what the leftovers card offers to put in the fridge.
   */
  portionsEaten?: number | null
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

/**
 * One unit the household measures in, and every spelling it answers to.
 *
 * The aliases are here rather than left on the server because the unit field has to resolve
 * "ounces" to `oz` **while somebody is typing it**, and a round trip per keystroke to answer a
 * question about a thirty-row table is a field that lags behind the thumb. The whole list is a few
 * hundred bytes and is fetched once per session.
 */
export interface MeasurementUnitDto {
  /** The one spelling that gets stored and shown — `oz`, `mL`, `bunch`. */
  canonical: string
  /** The word in full, for the suggestion's second line. Null on units the household typed. */
  displayName: string | null
  /** Folded spellings — lowercased, trimmed, periods dropped. Includes the canonical's own. */
  aliases: string[]
  /** False for a unit somebody introduced by typing it. Those sort after the predefined ones. */
  isSeeded: boolean
}

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
  // Three kinds the server has written since the opened-window and leftovers work, and which this
  // union did not name — so the item sheet's history fell through to a generic word on exactly the
  // events it most needed to describe (`PantryEventKind`, values 9–11).
  | 'Produced' | 'MarkedOpened' | 'MarkedFinished'

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
  /**
   * A count of **packages** when `packSize` is set, and an amount in `unit` when it is not.
   *
   * Never read alongside `packSize` by hand — `amountLabel` and `onHand` in `pantryDomain` do it,
   * and getting the pairing wrong is silent: "five containers" and "five ounces" are both plausible
   * numbers on a shelf list.
   */
  quantity: number | null
  unit: string | null
  estimateState: EstimateStateName | null
  /**
   * How much is in one package — the `3 oz` in `3 oz ×5`. Null on anything not sold in a package,
   * which is most of a pantry: loose lemons, a bag of flour measured in grams.
   *
   * It is part of what the row *is*, not a detail of it. Two sizes of the same product are two
   * things to run out of and two rows, which is why the scan path matches on it.
   */
  packSize: number | null
  packUnit: string | null
  lastSeenAtUtc: string | null
  lastSeenByName: string | null
  catalogueRef: string | null
  isArchived: boolean
  version: number
  /**
   * When it was opened — the `OPEN 5 D` label (KITCHEN_LOOP_ADDENDUM §4).
   *
   * `null` means "not opened", not "unknown". Nothing infers it; it is the observable fact the
   * section ranks freshness by, having refused to store expiry dates it would have to guess.
   */
  openedAtUtc: string | null
  /**
   * A date the packet stated, if one did — `YYYY-MM-DD` (ADD_TO_PANTRY §6).
   *
   * **Sorts; never warns.** The pantry stores a date somebody read off a packet and nothing else;
   * it does not infer one, and it does not turn one into a notification.
   */
  goodUntil: string | null
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
  /**
   * How much is in one package — "five containers of 3 oz each".
   *
   * Optional, because most of a pantry is not packaged. Supplying it switches the row over: the
   * count becomes a count of packages and the row reads `3 oz ×5`. Null or `0` means loose.
   */
  packSize?: number | null
  packUnit?: string | null
  /**
   * The pack's barcode, when one is in hand.
   *
   * A barcode sticks to the product wherever it is supplied — not only on the scan screen. A pack
   * the outside lookup could not name gets typed in by hand, and keeping the code the phone read is
   * what makes the *second* pack of it resolve on its own. Sending it writes both the item's
   * `catalogueRef` and a household catalogue entry.
   *
   * Three states, and they mean different things: `undefined` leaves whatever the item has alone,
   * a code sets it, and `''` clears it.
   */
  barcode?: string | null
  /** The symbology the browser's BarcodeDetector reported, for the ambiguous 8-digit case. */
  barcodeFormat?: string | null
  /**
   * A date the packet states — `2027-03-14` (ADD_TO_PANTRY §6).
   *
   * The one sanctioned exception to the section's ban on expiry dates, and narrow by design:
   * optional, typed only from what is printed on the pack, never inferred from a shelf-life table,
   * and **never the subject of a notification, badge or counter**. It sorts; it does not warn.
   */
  goodUntil?: string | null
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
  /**
   * What caused it, named — the dish a deduction cooked, the vendor a delivery came from.
   *
   * `One used — Piccata`, `Tesco order`. Null wherever the event had no cause worth naming; a hand
   * correction is caused by the person, who is already in `byName`.
   */
  sourceLabel: string | null
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
export type StockStatusName =
  | 'Fine'
  | 'Short'
  | 'Gone'
  | 'Unknown'
  | 'NotCounted'
  | 'NoMatch'
  /**
   * Wanted, present, and already spoken for by an earlier night (KITCHEN_LOOP_ADDENDUM §1).
   *
   * Distinct from `Short` deliberately: "you have none" and "you have one and Saturday is having
   * it" call for different answers — buy some, or move the night.
   */
  | 'ClaimedAway'

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
  /** The earlier night that already spoke for this item, if one has. Names the first claimant. */
  claimedByEntryId: number | null
  /** How much those earlier nights hold, in the item's own measure unit. */
  claimedQuantity: number | null
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
  /**
   * What the night left over, or `null` when it left nothing (KITCHEN_LOOP_ADDENDUM §5).
   *
   * Null on a plain "yes, we ate it" — everyone sat down, so there is nothing spare and no card.
   * Offering a card for zero portions after every meal is how a household learns to dismiss it.
   */
  produced: ProducedSuggestionDto | null
  /**
   * Who confirmed the night, and when — `Written by Aiden · just now`.
   *
   * From the deduction's own first event, not from whoever is at the panel when the receipt is
   * re-opened. A wrong number is arguable when a name is on it and merely annoying when it is not.
   */
  writtenByName: string | null
  writtenAtUtc: string | null
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
  /**
   * Which aisle it falls in, for the shop's grouping (KITCHEN_LOOP_ADDENDUM §6).
   *
   * Null is ordinary and expected — an unfiled line sorts last under `ELSEWHERE` rather than being
   * hidden or guessed at.
   */
  aisle: string | null
  /** Which shop it is meant for. Null means "whoever is out", which is the common case. */
  store: string | null
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

/**
 * A photograph handed to the Kitchen to be read.
 *
 * The same request shape for a cookbook page and a delivery screenshot, because it is the same
 * mechanism — only the endpoint differs, and the endpoint is what fixes the rules the reading is
 * judged by.
 */
export interface ReadKitchenPhotoRequest {
  imageBase64: string
  mediaType: string | null
}

/**
 * One line exactly as it was read.
 *
 * `unclear` renders `UNCLEAR` and blocks nothing. A line nobody could read is still a line that was
 * on the page, and dropping it is how an import quietly comes up short.
 */
export interface ReadLineDto {
  rawText: string
  unclear: boolean
}

/** What a photograph of a recipe yielded. Nothing has been saved. */
export interface RecipeReadingDto {
  /**
   * Whether a reading could be attempted at all.
   *
   * False is not a fact about the photograph, and the panel must not phrase it as one.
   */
  available: boolean
  title: string | null
  servings: number | null
  ingredients: ReadLineDto[]
  steps: ReadLineDto[]
  /** Counted server-side, so `11 lines · 2 unclear` and the tags cannot disagree. */
  unclearCount: number
  reason: string | null
}

/** What a photograph of an order or a till receipt yielded. Nothing has been saved. */
export interface PurchaseReadingDto {
  available: boolean
  vendorLabel: string | null
  lines: ReadLineDto[]
  unclearCount: number
  reason: string | null
}

export interface ImportLineInput {
  proposedName?: string | null
  proposedQuantity?: number | null
  proposedUnit?: string | null
  proposedLocation?: PantryLocationName | null
  proposedTracking?: TrackingClassName | null
  matchedPantryItemId?: number | null
}

// ---- Care logging HomeHub owns ----

/**
 * The ten things a household logs, plus growth.
 *
 * Ten, where the integration this replaced could log four. That gap is why the panel keeps its own
 * log at all — six of these had no service to write them and no sensor to read them.
 */
export type CareEntryTypeName =
  | 'Bottle' | 'Nursing' | 'Pump' | 'Diaper' | 'Solids'
  | 'Sleep' | 'Medicine' | 'Bath' | 'TummyTime' | 'Temperature' | 'Growth'

export interface CareEntryDto {
  id: number
  childKey: string
  type: CareEntryTypeName
  /** When it happened — not when it was written down. */
  atUtc: string
  /**
   * The measured value, or null when nothing was measured.
   *
   * Null is not zero. A pump session with no amount is the ordinary case; the integration this
   * replaced stored that as `0 oz` and reported it back as though somebody had weighed it, which is
   * the bug the distinction exists to refuse. Here it renders as an em dash.
   */
  amount: number | null
  unit: string | null
  /**
   * A bottle's two ends: what was poured, and what came back. Null on every other type.
   *
   * `amount` above stays the figure everything else reads — it is what was *taken*, and the totals,
   * the log row and the last-fed line should not have to know that one type subtracts to get it.
   * These are here so a correction can open on what was actually entered: before they were stored,
   * reopening a feed put the consumed figure in `OFFERED` and left `REMAINING` empty, which reads
   * as a bottle nobody drank from.
   *
   * <b>Null on a bottle logged before they existed.</b> Those rows genuinely never recorded the
   * pair, and the sheet falls back to its old behaviour for them rather than inventing one.
   */
  offered: number | null
  left: number | null
  durationMinutes: number | null
  kind: string | null
  side: string | null
  peeAmount: string | null
  pooAmount: string | null
  color: string | null
  consistency: string | null
  diaperRash: boolean | null
  pounds: number | null
  ounces: number | null
  heightInches: number | null
  headInches: number | null
  notes: string | null
  /**
   * How the row got here. `Panel` for everything written now.
   *
   * <b>Rows imported before 2026-08-30 still read `HuckleberryImport`</b>, and deliberately so: the
   * import is gone but the entries it produced are the household's history, and rewriting stored
   * rows to claim somebody typed them would be falsifying the log to tidy up a value. Nothing
   * branches on it — it is a free string, and reading an unfamiliar one costs nothing.
   */
  source: string
  /** Corrected since it was written. The log marks it rather than quietly showing the new number. */
  edited: boolean
  /**
   * What the panel called this entry when it wrote it, or null where it did not say.
   *
   * How an entry logged offline finds itself again. The panel shows a queued entry from its own
   * store under an id the server has never issued; when the queue replays and the read comes back,
   * this is what says *the row you are holding is that one*. Without it the entry appears twice —
   * once as the local copy and once as the server's — and the household counts two feeds where
   * there was one. See `mergeEntries` in `careOffline.ts`.
   */
  clientKey: string | null
  /** Bumped on every correction. Sent back as `?baseVersion=` so a queued edit is conditional. */
  version: number
  /**
   * Client-only: written on this device and not yet acknowledged by the server.
   *
   * Never sent by the API — it is set on the local rows `careOffline` mints and is what the log
   * marks so a queued entry reads as *saved, not yet sent* rather than as an ordinary row.
   */
  pending?: boolean
}

/** A session running or paused. The server works out the elapsed minutes; a pause is not simple subtraction. */
export interface CareTimerDto {
  type: CareEntryTypeName
  side: string | null
  startedUtc: string
  paused: boolean
  elapsedMinutes: number
  phaseOneMinutes: number | null
  phaseTwoMinutes: number | null
  phase: number | null
  /**
   * Elapsed minutes at the moment expression began, so it can be counted from there.
   *
   * Null before the switch, and on a session that was already running when the server learned to
   * record it. Expression gets its whole length from the switch however long stimulation actually
   * ran — see `CareTimer.PhaseTwoAtMinutes` on the server for why the phase that used to come up
   * short was the wrong one to shorten.
   */
  phaseTwoAtMinutes: number | null
  /**
   * Finished and held for its amount — the session is measured, and nothing is written yet.
   *
   * Pump only. How much was expressed is knowable only once the session is over, so FINISH stops
   * the clock and holds it here; the panel asks for the amount once and completes with it in hand.
   * A held session survives the panel closing, the app restarting and a move to another device.
   */
  endedUtc: string | null
}

/** Everything the landing screen needs, in one read — ten tile captions and any running timer. */
export interface CareSummaryDto {
  lastByType: CareEntryDto[]
  timers: CareTimerDto[]
}

/** What a sheet sends. One shape for all ten types; each fills the fields it has. */
export interface CareEntryInput {
  type: CareEntryTypeName
  /** Omit for now, which is what every sheet defaults to. */
  atUtc?: string | null
  amount?: number | null
  unit?: string | null
  durationMinutes?: number | null
  kind?: string | null
  side?: string | null
  peeAmount?: string | null
  pooAmount?: string | null
  color?: string | null
  consistency?: string | null
  diaperRash?: boolean | null
  /**
   * A bottle's two ends: what went in, and what came back.
   *
   * `amount` is what was *taken* — offered less left — because that is the figure that matters and
   * the only one the upstream bottle service accepts. These two are what it was worked out from.
   *
   * Stored since `AddBottleOfferedAndLeft`. They were sent for a while before that and silently
   * dropped, which is why a correction used to open on the taken amount: it was the only figure
   * that survived the round trip.
   */
  offered?: number | null
  left?: number | null
  pounds?: number | null
  ounces?: number | null
  heightInches?: number | null
  headInches?: number | null
  notes?: string | null
  /**
   * This panel's own name for the entry, so writing it twice records it once.
   *
   * <b>What makes a queued entry safe to replay.</b> A write that goes out on a returning
   * connection can fail in the one way a retry cannot tell apart: the row landed and the response
   * did not. Retrying logs the feed twice, not retrying loses it, and neither is a choice worth
   * making on a child's record — so the server keys on this instead and a second write of the same
   * key returns the first row.
   */
  clientKey?: string | null
}

// ---- The Kitchen loop (KITCHEN_LOOP_ADDENDUM, MATCHING_AND_ALIASES) ----

/** A recipe worth cooking soon, and what it would use up. */
export interface DueRecipeDto {
  recipeId: number
  title: string
  /** Days-open summed across matched ingredients. A sort, never a warning. */
  score: number
  /** Named, not counted — the lead card says *which* things are turning. */
  uses: string[]
}

/** The walk order for one shop, first aisle to last. */
export interface AisleOrderDto {
  store: string
  aisles: AisleOrderLineDto[]
}

export interface AisleOrderLineDto {
  aisle: string
  position: number
  /** Open lines currently falling in this aisle — a reorder is judged against what is still to buy. */
  lineCount: number
}

/** What a night left over, offered rather than assumed (COOKING_AND_AFTER §3). */
export interface ProducedSuggestionDto {
  suggestedName: string
  /** Servings cooked minus portions eaten. A guess, and labelled one on the panel. */
  suggestedPortions: number
  location: PantryLocationName
}

/** Where matching stands overall — M3. */
export interface MatchingCoverageDto {
  percent: number
  matchedLines: number
  totalLines: number
  /** `HOW IT GOT LEARNED` — counts by source, so the household sees it taught by shopping. */
  bySource: Record<string, number>
  /** `WORTH SORTING`, ordered by how many recipes each one unblocks. */
  worthSorting: MatchingGapDto[]
  /** `WHAT WE GET WRONG` — pairings undone, never suggested again. */
  undone: number
}

export interface MatchingGapDto {
  name: string
  recipesBlocked: number
}

/** A week the household saved to use again (KITCHEN_LOOP_ADDENDUM §6). */
export interface MealPlanTemplateDto {
  id: number
  name: string
  nightCount: number
  createdUtc: string
}

/** What applying a saved week did. `skipped` is not an error count — see the server's note. */
export interface ApplyTemplateResultDto {
  written: number
  skipped: number
}

/**
 * Where one recipe stands against the shelves — the folder's band (RECIPES §1).
 *
 * `CantSay` is the honest third state and is never folded into the other two. A recipe listed as
 * ready that turns out to be missing two things at seven in the evening costs more than one that
 * admitted it did not know.
 */
export interface CookabilityDto {
  recipeId: number
  band: 'Ready' | 'Short' | 'CantSay'
  shortCount: number
  unmatchedCount: number
}

/**
 * A night that has spoken for this item (PANTRY_SHELVES §2).
 *
 * The row knowing it is claimed is what stops the household counting the same tin twice across two
 * screens: the shelf says three, and the sheet says one of them is Saturday's.
 */
/**
 * What a barcode turns out to be — identification only, writing nothing (ADD_TO_PANTRY §2).
 *
 * Distinct from `ScanResultDto`, which is the phone's tally path and moves stock. Scanning on the
 * add form "names the thing and fills its size; it never increments a count".
 */
export interface BarcodeLookupDto {
  /** The normalised 13-digit form, which a later `NAME IT` has to teach against. */
  barcode: string
  /** Whether the household or global catalogue already knows this pack. */
  known: boolean
  name: string | null
  unit: string | null
  packSize: number | null
  packUnit: string | null
  location: PantryLocationName | null
  tracking: TrackingClassName | null
  /** What an outside catalogue thinks it is. Pre-fills the form and teaches nothing. */
  suggestion: ProductSuggestionDto | null
}

/**
 * A recipe that cooks this item, with what it asks for (PANTRY_SHELVES §2, `USED BY`).
 *
 * `packs` is the amount restated in the item's own containers and is null far more often than not —
 * it needs both a pack size on the shelf and a conversion the unit table is willing to make. Null
 * means the row says `30 oz` and stops, rather than guessing how many tins that is.
 */
export interface ItemUsageDto {
  recipeId: number
  title: string
  quantity: number | null
  unit: string | null
  packs: number | null
  packUnit: string | null
  /** The night holding this recipe's claim, when one does — the amber `claimed for Saturday`. */
  claimedForDate: string | null
}

export interface ItemClaimDto {
  planEntryId: number
  date: string
  slot: MealSlotName
  dishName: string | null
  quantity: number | null
}

/** How long the household reckons one kind of food lasts (SETTINGS_AND_IMPORT §1). */
export interface ShelfLifeDto {
  id: number
  foodKind: string
  /** Grouped by the state food is in — an opened jar and an unopened one are two questions. */
  state: 'Fresh' | 'Chilled' | 'Opened'
  days: number
  /** False once somebody has moved it. What `PUT THEM BACK` restores. */
  isSeeded: boolean
}
