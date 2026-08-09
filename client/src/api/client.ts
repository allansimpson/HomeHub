import type {
  ProfileDto,
  SettingsDto,
  SessionDto,
  ZoneReadingDto,
  ZoneHistoryDto,
  ActiveAlertDto,
  ThresholdDto,
  WeatherSnapshotDto,
  WeatherLocationDto,
  CalendarEventDto,
  CalendarEventInput,
  SyncCalendarDto,
  TaskItemDto,
  TaskCreateInput,
  SyncListDto,
  ClimatePanelDto,
  ClimateUnitDto,
  ClimateZonePatch,
  ClimateModeName,
  LoopWriteDto,
  AssistantChatRequest,
  AssistantChatResponse,
  Agent,
  AgentAssignments,
  AssistChatRequest,
  AssistChatResponse,
  Conversation,
  ConversationDetail,
  ConversationList,
  DeleteConversationsResponse,
  SearchResults,
  TurnStatus,
  UpdateConversationRequest,
  BabyHealthDto,
  BabyChildDto,
  BabyStateDto,
  BabyHistoryEventDto,
  BabyTimerKindName,
  BabyTimerActionName,
  NursingSideName,
  DiaperInput,
  BottleInput,
  GrowthInput,
  CatHealthDto,
  LitterRobotDto,
  LitterSwitchName,
  LitterSelectName,
  LitterHistoryDto,
  RecoveryAttemptDto,
  CycleResultDto,
  NotificationFeedDto,
  LinkStatusDto,
  LinkStartDto,
  RecipeSummaryDto,
  RecipeDto,
  RecipeInput,
  RecipeImportInput,
  RecipePasteInput,
  ForkRecipeInput,
  RecipeImportResponse,
  RecipeTagCountDto,
  MealWeekDto,
  MealPlanEntryDto,
  MealPlanInput,
  MealEatenInput,
  MealSlotName,
  MealSummaryDto,
  MealDto,
  MealInput,
  AssignMealInput,
  CoOccurrenceDto,
  MeasurementUnitDto,
  PantryListDto,
  PantryItemDto,
  PantryItemInput,
  PantryEventDto,
  ScanInput,
  ScanResultDto,
  CatalogueInput,
  StockCheckDto,
  CorrectStockInput,
  DeductionReceiptDto,
  GroceryListDto,
  GroceryLineDto,
  GroceryInput,
  MirrorStatusDto,
  MirrorSettingsInput,
  OrderImportDto,
  OrderImportInput,
  ImportLineInput,
} from './types'

/**
 * Thin typed wrapper over the HomeHub API. Same-origin in prod; the Vite proxy forwards
 * `/api` to Kestrel in dev. Non-2xx responses throw {@link ApiError} so callers can show the
 * calm reconnecting state rather than crashing (offline-first — hardened further in Stage 9).
 */
export class ApiError extends Error {
  readonly status: number
  /**
   * The decoded response body, when there was one and it was JSON.
   *
   * Carried because a 409 is not just a failure — it answers with the **current server state**, and
   * that state is the whole input to the conflict UI. Without it the caller would have to re-fetch
   * to find out what it collided with, which is both a second round trip and a chance for the
   * server to change again in between.
   */
  readonly body: unknown
  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      // Explicit, though it is also the default for a same-origin URL: since AUDIT A1 the session
      // cookie is what authorises every one of these calls, so "cookies travel" stopped being an
      // incidental property of relative fetches and became the thing the API depends on.
      credentials: 'same-origin',
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
      ...init,
    })
  } catch (cause) {
    // Network failure (server down / offline) — surface as a 0-status ApiError.
    throw new ApiError(0, cause instanceof Error ? cause.message : 'Network error')
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    // Plain-text problem details are the common case (the controllers return BadRequest("…")), so a
    // parse failure is expected rather than exceptional — the message still carries the text.
    let body: unknown
    try { body = text ? JSON.parse(text) : undefined } catch { body = undefined }
    throw new ApiError(res.status, text || res.statusText, body)
  }
  // 204 No Content and other empty bodies decode to undefined.
  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) })

/** What a streamed turn reports as it happens. */
export interface AssistStreamHandlers {
  /**
   * What the server is calling this turn, before any of it exists.
   *
   * The name a Stop can use. Cancelling is a request of its own now (`cancelAssistTurn`) rather than
   * a hung-up connection, because those two were the same event and meant opposite things: leaving
   * the screen abandoned the turn exactly as pressing Stop did.
   */
  onOpen?: (turnId: string) => void
  /** A fragment of the reply. Called for the first one with no delay of any kind. */
  onDelta: (text: string) => void
  /**
   * A fragment of the agent's reasoning — the working, not the answer.
   *
   * Kept strictly apart from {@link onDelta}. Reasoning contradicts itself and abandons conclusions,
   * so appending it to the reply would show the household sentences the agent decided not to say.
   * Delivered whether or not anybody is watching it; whether it is *drawn* is a panel preference
   * (`assistPrefs`), so turning it on takes effect on the next turn without a round trip.
   */
  onThinking?: (text: string) => void
  /** A house tool the agent is running — live activity, never a receipt. */
  onTool?: (tool: string, status: string) => void
  /** The turn is finished and stored. Everything the screen needs arrives here. */
  onDone: (result: {
    conversationId: number
    messageId: number
    origin: string
    action?: string | null
    finishReason: string
  }) => void
  /** The turn could not run. `retryable` distinguishes "busy" from "misconfigured". */
  onError?: (message: string, retryable: boolean) => void
}

/**
 * Send a turn and receive the reply as it is produced.
 *
 * `EventSource` cannot POST, so this reads the response body directly. Frames are parsed
 * incrementally — a delta is delivered the moment its frame completes, never after buffering the
 * whole answer, because the number that matters is submit-to-first-painted-character and anything
 * that waits here is added to it.
 *
 * Pass an `AbortSignal` to cancel. That aborts the request, which HomeHub forwards upstream — though
 * Hermes notices on its next write and its tools stop cooperatively, so an abandoned turn is
 * *cancellation requested* rather than certainly stopped.
 */
async function streamAssistTurn(
  body: AssistChatRequest,
  handlers: AssistStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response
  try {
    res = await fetch('/api/assist/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal,
    })
  } catch (cause) {
    if (signal?.aborted) return
    throw new ApiError(0, cause instanceof Error ? cause.message : 'Network error')
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ApiError(res.status, text || res.statusText)
  }
  if (!res.body) throw new ApiError(0, 'The assistant stream returned no body.')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const dispatch = (frame: string) => {
    let event = 'message'
    const data: string[] = []
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue // keepalive
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    if (data.length === 0) return

    let payload: Record<string, unknown>
    try { payload = JSON.parse(data.join('\n')) } catch { return }

    if (event === 'open') handlers.onOpen?.(String(payload.turnId ?? ''))
    else if (event === 'delta') handlers.onDelta(String(payload.text ?? ''))
    else if (event === 'thinking') handlers.onThinking?.(String(payload.text ?? ''))
    else if (event === 'tool') handlers.onTool?.(String(payload.tool ?? ''), String(payload.status ?? ''))
    else if (event === 'done') handlers.onDone(payload as Parameters<AssistStreamHandlers['onDone']>[0])
    else if (event === 'error') handlers.onError?.(String(payload.message ?? 'The assistant failed.'), Boolean(payload.retryable))
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // A blank line ends a frame. Anything after the last one is a partial frame still arriving.
      let split: number
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        dispatch(buffer.slice(0, split))
        buffer = buffer.slice(split + 2)
      }
    }
    if (buffer.trim()) dispatch(buffer)
  } catch (cause) {
    // An abort mid-stream is the user's own doing; whatever arrived is already rendered.
    if (signal?.aborted) return
    throw cause instanceof ApiError ? cause : new ApiError(0, 'The assistant stream ended unexpectedly.')
  }
}

/**
 * Query string for the Assist reads, which are all scoped the same way: this member, this agent.
 *
 * The member is no longer part of it (AUDIT A1.2). It used to be `?profileId=`, which meant the
 * client got to say whose chat history to return — so the server now takes it from the session
 * cookie and there is nothing to send. Built through `URLSearchParams` so a chat title or a search
 * term carrying an `&` cannot break the URL it is being put into.
 */
const assistQuery = (
  agentKey?: string | null,
  extra?: Record<string, string>,
): string => {
  const params = new URLSearchParams()
  if (agentKey) params.set('agent', agentKey)
  for (const [key, value] of Object.entries(extra ?? {})) params.set(key, value)
  const query = params.toString()
  return query ? `?${query}` : ''
}

export const api = {
  // ---- Profiles ----
  listProfiles: () => request<ProfileDto[]>('/profiles'),
  createProfile: (name: string, initial: string) =>
    request<ProfileDto>('/profiles', { method: 'POST', ...json({ name, initial }) }),
  /**
   * `role` is optional and means *leave as it is* when absent — the server reads it the same
   * way. Everything else is a full replace, so omitting a name still blanks it; only the field
   * that governs what a member may do is protected from being changed by silence.
   */
  updateProfile: (
    id: number,
    patch: Omit<ProfileDto, 'id' | 'hasPin' | 'role'> & Partial<Pick<ProfileDto, 'role'>>,
  ) => request<ProfileDto>(`/profiles/${id}`, { method: 'PUT', ...json(patch) }),
  deleteProfile: (id: number) => request<void>(`/profiles/${id}`, { method: 'DELETE' }),
  setPin: (id: number, pin: string) =>
    request<void>(`/profiles/${id}/pin`, { method: 'PUT', ...json({ pin }) }),
  clearPin: (id: number) => request<void>(`/profiles/${id}/pin`, { method: 'DELETE' }),

  // ---- Session (AUDIT A1) ----
  /**
   * Who this device is signed in as. Answers `{ signedIn: false }` rather than 401 when nobody is,
   * so the shell can tell "signed out" from "server unreachable" — one shows a sign-in screen, the
   * other shows Reconnecting, and they must not look the same.
   */
  getSession: () => request<SessionDto>('/session'),
  /**
   * Sign in. Replaces `verifyPin`, which only ever answered a question the browser was free to
   * ignore; getting the PIN right is now what mints the cookie every other call depends on.
   *
   * `remember` is the wall panel: a persistent cookie so a power cut does not strand the household
   * at a PIN pad. A phone leaves it off and signs out when the browser closes.
   */
  signIn: (profileId: number, pin?: string, remember = false) =>
    request<SessionDto>('/session', { method: 'POST', ...json({ profileId, pin, remember }) }),
  signOutSession: () => request<void>('/session', { method: 'DELETE' }),

  // ---- Settings ----
  getSettings: () => request<SettingsDto>('/settings'),
  // The night window is optional and means *leave it alone* when omitted, so a caller that shows
  // the idle controls without showing the window cannot blank the schedule by not mentioning it.
  updateSettings: (patch: {
    idleTimeoutMinutes: number
    idleDimmingEnabled: boolean
    daylightBoost: string
    nightDimStart?: string
    nightDimEnd?: string
  }) => request<SettingsDto>('/settings', { method: 'PUT', ...json(patch) }),
  setActiveProfile: (profileId: number | null) =>
    request<SettingsDto>('/settings/active-profile', { method: 'PUT', ...json({ profileId }) }),
  /** Its own route so Litter Settings can save the name without echoing back settings it never showed. */
  setCatName: (name: string | null) =>
    request<SettingsDto>('/settings/cat-name', { method: 'PUT', ...json({ name }) }),
  /** Same reasoning as setCatName — edited from Litter Settings, which holds none of the rest. */
  setLitterFullPercent: (percent: number) =>
    request<SettingsDto>('/settings/litter-full-percent', { method: 'PUT', ...json({ percent }) }),
  /**
   * Assist's conversation policy. Its own route for the same reason as the two above: it is edited
   * from the Config privacy view, which holds none of the whole-object PUT's other state.
   *
   * Turning storing off deletes nothing — it stops new writes. Deleting is an explicit act with a
   * modal in front of it.
   */
  setConversationPolicy: (storeConversations: boolean, retentionDays: number) =>
    request<SettingsDto>('/settings/conversation-policy', {
      method: 'PUT', ...json({ storeConversations, retentionDays }),
    }),

  // ---- Sensors ----
  getZones: () => request<ZoneReadingDto[]>('/sensors/zones'),
  getZoneHistory: (id: number, hours = 24) =>
    request<ZoneHistoryDto>(`/sensors/zones/${id}/history?hours=${hours}`),

  // ---- Alerts ----
  getAlerts: () => request<ActiveAlertDto[]>('/alerts'),
  getThresholds: () => request<ThresholdDto[]>('/alerts/thresholds'),
  updateThreshold: (id: number, patch: { value: number; durationMinutes: number; enabled: boolean }) =>
    request<ThresholdDto>(`/alerts/thresholds/${id}`, { method: 'PUT', ...json(patch) }),

  // ---- Weather ----
  getWeather: () => request<WeatherSnapshotDto>('/weather'),
  /**
   * Where the weather is for, and whether the household chose it.
   *
   * Its own read rather than a field on `SettingsDto`, because the interesting part of the answer is
   * not household state: the effective coordinates fall back to the deployment's configuration, and
   * the place name comes from the last forecast the provider returned.
   */
  getWeatherLocation: () => request<WeatherLocationDto>('/settings/weather-location'),
  /**
   * Move the weather. Both null hands the question back to the deployment's configured location.
   *
   * Rejects with `ApiError(400)` on half a coordinate or an out-of-range one — the only setting here
   * that does not silently clamp, because there is no "nearest sane latitude" and a corrected
   * coordinate is a forecast for somewhere nobody asked about.
   */
  setWeatherLocation: (latitude: number | null, longitude: number | null) =>
    request<WeatherLocationDto>('/settings/weather-location', {
      method: 'PUT', ...json({ latitude, longitude }),
    }),

  // ---- Calendar (per active profile) ----
  getEvents: (fromIso: string, toIso: string) =>
    request<CalendarEventDto[]>(
      `/calendar/events?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`,
    ),
  getUpcoming: (days = 7) => request<CalendarEventDto[]>(`/calendar/upcoming?days=${days}`),
  getEvent: (id: number) => request<CalendarEventDto>(`/calendar/events/${id}`),
  // ---- Calendar selection (choose which Google calendars display) ----
  getCalendars: (profileId: number) => request<SyncCalendarDto[]>(`/calendar/calendars?profileId=${profileId}`),
  setCalendars: (profileId: number, selectedCalendarIds: string[]) =>
    request<void>('/calendar/calendars', { method: 'PUT', ...json({ profileId, selectedCalendarIds }) }),
  /** Assign an icon to a whole calendar, or clear it with null. */
  setCalendarIcon: (profileId: number, calendarId: string, icon: string | null) =>
    request<void>('/calendar/calendars/icon', { method: 'PUT', ...json({ profileId, calendarId, icon }) }),
  createEvent: (input: CalendarEventInput) =>
    request<CalendarEventDto>('/calendar/events', { method: 'POST', ...json(input) }),
  updateEvent: (id: number, input: CalendarEventInput) =>
    request<CalendarEventDto>(`/calendar/events/${id}`, { method: 'PUT', ...json(input) }),
  deleteEvent: (id: number) => request<void>(`/calendar/events/${id}`, { method: 'DELETE' }),

  // ---- Tasks ----
  getTasks: () => request<TaskItemDto[]>('/tasks'),
  createTask: (input: TaskCreateInput) => request<TaskItemDto>('/tasks', { method: 'POST', ...json(input) }),
  completeTask: (id: number, completed: boolean) =>
    request<TaskItemDto>(`/tasks/${id}/complete`, { method: 'PATCH', ...json({ completed }) }),
  setTaskImportant: (id: number, important: boolean) =>
    request<TaskItemDto>(`/tasks/${id}/importance`, { method: 'PATCH', ...json({ important }) }),
  deleteTask: (id: number) => request<void>(`/tasks/${id}`, { method: 'DELETE' }),
  // ---- To Do list selection (choose which Microsoft lists sync) ----
  getTaskLists: (profileId: number) => request<SyncListDto[]>(`/tasks/lists?profileId=${profileId}`),
  setTaskLists: (profileId: number, selectedGraphListIds: string[]) =>
    request<void>('/tasks/lists', { method: 'PUT', ...json({ profileId, selectedGraphListIds }) }),

  // ---- Climate ----
  // Every write here moves a *target*. The unit's set point is the loop's, and the one route that
  // touches it directly is deliberately not reachable from the Climate screen.
  getClimatePanel: () => request<ClimatePanelDto>('/climate/zones'),
  /** The standing target — the drill-in stepper, and an accepted repeat-offer. */
  setClimateTarget: (id: number, targetF: number) =>
    request<ClimatePanelDto>(`/climate/zones/${id}/target`, { method: 'PUT', ...json({ targetF }) }),
  /** Borrow the room for two hours. Supersedes any live loan. */
  startClimateOverride: (id: number, targetF: number) =>
    request<ClimatePanelDto>(`/climate/zones/${id}/override`, { method: 'POST', ...json({ targetF }) }),
  /**
   * Keep it — 3a's `KEEP 69°` and 3b's lift-on-keep.
   *
   * One request on purpose: setting the target and then cancelling the loan is two, and between them
   * the zone holds a new standing target with a live loan against it. `targetF` is what keeps that
   * true for 3b, which lifts on `KEEP` without ever having released a loan to promote.
   */
  promoteClimateOverride: (id: number, targetF?: number) =>
    request<ClimatePanelDto>(`/climate/zones/${id}/override/promote`, {
      method: 'POST', ...json({ targetF: targetF ?? null }),
    }),
  cancelClimateOverride: (id: number) =>
    request<ClimatePanelDto>(`/climate/zones/${id}/override`, { method: 'DELETE' }),
  /** UNDO — put back the exact standing target the last promotion replaced. */
  undoClimatePromotion: (id: number) =>
    request<ClimatePanelDto>(`/climate/zones/${id}/undo`, { method: 'POST' }),
  patchClimateZone: (id: number, patch: ClimateZonePatch) =>
    request<ClimatePanelDto>(`/climate/zones/${id}`, { method: 'PATCH', ...json(patch) }),
  getClimateWrites: (id: number, take = 30) =>
    request<LoopWriteDto[]>(`/climate/zones/${id}/writes?take=${take}`),
  answerClimateOffer: (id: number, accept: boolean, targetF: number, windowHour: number) =>
    request<ClimatePanelDto>(
      `/climate/zones/${id}/offer?targetF=${targetF}&windowHour=${windowHour}`,
      { method: 'POST', ...json({ accept }) },
    ),
  pauseClimateLoop: (paused: boolean) =>
    request<ClimatePanelDto>('/climate/pause', { method: 'POST', ...json({ paused }) }),
  allClimateUnitsOff: () => request<void>('/climate/units/off', { method: 'POST' }),

  // The machine surface. Not used by the Climate screen; kept for the assistant and for a house
  // running with the loop paused.
  getClimateUnits: () => request<ClimateUnitDto[]>('/climate/units'),
  setClimateSetPoint: (id: number, setPointF: number) =>
    request<ClimateUnitDto>(`/climate/units/${id}/setpoint`, { method: 'PUT', ...json({ setPointF }) }),
  setClimateMode: (id: number, mode: ClimateModeName) =>
    request<ClimateUnitDto>(`/climate/units/${id}/mode`, { method: 'PUT', ...json({ mode }) }),
  applyClimateScene: (scene: 'evening' | 'all-off') =>
    request<void>('/climate/scene', { method: 'POST', ...json({ scene }) }),

  // ---- Assistant ----
  // The stateless turn. Kept for callers with no conversation of their own — the Pi voice bridge
  // speaks a reply and keeps nothing. Everything on the panel goes through Assist below.
  askAssistant: (body: AssistantChatRequest) =>
    request<AssistantChatResponse>('/assistant/chat', { method: 'POST', ...json(body) }),

  // ---- Assist: the chat system ----
  getConversations: (agentKey?: string | null) =>
    request<ConversationList>(`/assist/conversations${assistQuery(agentKey)}`),
  getArchivedConversations: (agentKey?: string | null) =>
    request<Conversation[]>(`/assist/conversations/archived${assistQuery(agentKey)}`),
  // Fetching a conversation marks it read — opening a chat is what clears its badge, so there is no
  // separate call for the client to forget to make.
  getConversation: (id: number) => request<ConversationDetail>(`/assist/conversations/${id}`),
  getAgents: () => request<Agent[]>('/assist/agents'),
  // Config's editor, not the switcher's list: this one includes agents the member has *not* been
  // given, which is the whole point of an assignment screen.
  getAgentAssignments: (profileId: number) =>
    request<AgentAssignments>(`/assist/assignments/${profileId}`),
  // Whole-list, so two people editing the same member cannot interleave into a set neither chose.
  setAgentAssignments: (profileId: number, agentKeys: string[]) =>
    request<AgentAssignments>(`/assist/assignments/${profileId}`, { method: 'PUT', ...json({ agentKeys }) }),
  // Which of the member's agents Assist opens on. Its own call rather than a field on the list above:
  // that one is a whole-list replace, so a default carried on it would be cleared by every assignment
  // edit that did not think to restate it. Null returns them to the household agent.
  setDefaultAgent: (profileId: number, agentKey: string | null) =>
    request<AgentAssignments>(`/assist/assignments/${profileId}/default`, {
      method: 'PUT', ...json({ agentKey }),
    }),
  sendAssistTurn: (body: AssistChatRequest) =>
    request<AssistChatResponse>('/assist/chat', { method: 'POST', ...json(body) }),
  streamAssistTurn,
  /**
   * Stop a turn that is still being written — the Stop control under a live reply.
   *
   * Never throws. A 404 is the ordinary answer to stopping something that finished a moment earlier,
   * and a network failure here cannot be acted on: the member has already been told the turn is over,
   * and the reply is stored whether or not this call arrived.
   */
  cancelAssistTurn: (turnId: string) =>
    fetch(`/api/assist/chat/turns/${encodeURIComponent(turnId)}/cancel`, { method: 'POST' })
      .then(() => undefined, () => undefined),
  /**
   * What became of a turn whose stream this panel lost.
   *
   * The other half of a turn outliving its connection. A backgrounded phone has its network frozen
   * within seconds of the screen going off, which kills the read while the server carries on writing —
   * so the panel comes back and asks by name rather than reporting a failure it only inferred from
   * the transport. Throws `ApiError(404)` when the server has no record, which means "read the stored
   * transcript instead".
   */
  getAssistTurn: (turnId: string) =>
    request<TurnStatus>(`/assist/chat/turns/${encodeURIComponent(turnId)}`),
  updateConversation: (id: number, body: UpdateConversationRequest) =>
    request<Conversation>(`/assist/conversations/${id}`, { method: 'PATCH', ...json(body) }),
  deleteConversations: (ids: number[]) =>
    request<DeleteConversationsResponse>('/assist/conversations/delete', { method: 'POST', ...json({ ids }) }),
  searchConversations: (agentKey: string | null, q: string) =>
    request<SearchResults>(`/assist/search${assistQuery(agentKey, { q })}`),

  // ---- Account linking ----
  // The refresh token never comes near the browser: `start` hands back a consent URL, and the code
  // is exchanged server-side on the callback.
  getLinkStatus: (profileId: number) => request<LinkStatusDto[]>(`/link/status?profileId=${profileId}`),
  // `returnPath` is where the panel should land after consent. Linking a member other than the
  // signed-in one starts from that member's page, and the default destination would report the
  // result against the wrong person. Server-side it must be a relative path under /settings/.
  startLink: (provider: string, profileId: number, returnPath?: string) =>
    request<LinkStartDto>(
      `/link/${provider}/start?profileId=${profileId}` +
        (returnPath ? `&returnPath=${encodeURIComponent(returnPath)}` : ''),
      { method: 'POST' },
    ),
  unlink: (provider: string, profileId: number) =>
    request<void>(`/link/${provider}?profileId=${profileId}`, { method: 'DELETE' }),

  // ---- Notifications ----
  // One queue behind the live cards, the drawer and the inbox. Clearing is a reading gesture: it
  // never acts on the thing reported.
  getNotifications: () => request<NotificationFeedDto>('/notifications'),
  markNotificationRead: (id: number) => request<void>(`/notifications/${id}/read`, { method: 'PUT' }),
  clearNotifications: (severity?: string) =>
    request<void>(`/notifications${severity ? `?severity=${severity}` : ''}`, { method: 'DELETE' }),
  setNotificationSource: (source: string, enabled: boolean) =>
    request<void>(`/notifications/sources/${source}`, { method: 'PUT', ...json({ enabled }) }),

  // ---- Baby (Huckleberry) ----
  // Writes deliberately do NOT go through the write queue: Huckleberry is the system of record and a
  // failed baby write fails visibly rather than being retried at dawn. Nothing logged here can be
  // retracted by HomeHub — there is no delete or edit service upstream.
  getBabyHealth: () => request<BabyHealthDto>('/baby/health'),
  getBabyChildren: () => request<BabyChildDto[]>('/baby/children'),
  getBabyState: (childKey: string) => request<BabyStateDto>(`/baby/${childKey}/state`),
  getBabyHistory: (childKey: string, fromIso: string, toIso: string) =>
    request<BabyHistoryEventDto[]>(
      `/baby/${childKey}/history?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`,
    ),
  babyTimer: (
    childKey: string,
    timer: BabyTimerKindName,
    action: BabyTimerActionName,
    side?: NursingSideName,
  ) =>
    request<void>(
      `/baby/${childKey}/timer/${timer}/${action}${side ? `?side=${side}` : ''}`,
      { method: 'POST' },
    ),
  logDiaper: (childKey: string, input: DiaperInput) =>
    request<void>(`/baby/${childKey}/diaper`, { method: 'POST', ...json(input) }),
  logBottle: (childKey: string, input: BottleInput) =>
    request<void>(`/baby/${childKey}/bottle`, { method: 'POST', ...json(input) }),
  logGrowth: (childKey: string, input: GrowthInput) =>
    request<void>(`/baby/${childKey}/growth`, { method: 'POST', ...json(input) }),

  // ---- Litter (Litter-Robot) ----
  // Commands are fire-and-forget: the robot accepts commands it silently drops, so each of these
  // answers with a freshly-read snapshot rather than with "it worked".
  getCatHealth: () => request<CatHealthDto>('/cats/health'),
  // `fresh` bypasses the server's 10s display cache — for the seconds after a command, when a stale
  // status makes a working command look like it did nothing.
  getLitterRobots: (fresh = false) => request<LitterRobotDto[]>(`/cats${fresh ? '?fresh=true' : ''}`),
  getLitterRobot: (slug: string) => request<LitterRobotDto>(`/cats/${slug}`),
  getLitterRecoveries: (slug: string, days = 7) =>
    request<RecoveryAttemptDto[]>(`/cats/${slug}/recoveries?days=${days}`),
  // Trends come from HA's recorder, which purges — check `complete` before presenting the window.
  getLitterHistory: (slug: string, days = 7) =>
    request<LitterHistoryDto>(`/cats/${slug}/history?days=${days}`),
  startLitterCycle: (slug: string) => request<CycleResultDto>(`/cats/${slug}/cycle`, { method: 'POST' }),
  resetLitterDrawer: (slug: string) => request<LitterRobotDto>(`/cats/${slug}/drawer/reset`, { method: 'POST' }),
  resetLitterLevel: (slug: string) => request<LitterRobotDto>(`/cats/${slug}/litter/reset`, { method: 'POST' }),
  setLitterSwitch: (slug: string, which: LitterSwitchName, on: boolean) =>
    request<LitterRobotDto>(`/cats/${slug}/switch/${which}`, { method: 'PUT', ...json({ on }) }),
  // Multi-position settings: the night light is off/on/auto and the cat-wait offers five values, so
  // these can't ride the boolean switch endpoint. Pass one of the entity's own declared options.
  setLitterSelect: (slug: string, which: LitterSelectName, option: string) =>
    request<LitterRobotDto>(`/cats/${slug}/select/${which}`, { method: 'PUT', ...json({ option }) }),
  setLitterRecovery: (slug: string, enabled: boolean) =>
    request<LitterRobotDto>(`/cats/${slug}/recovery`, { method: 'PUT', ...json({ enabled }) }),

  // ---- Meals: recipe folder ----
  // Recipes are owned locally, not cached from anywhere, so these are plain CRUD — there is no
  // provider behind them and no "not connected" state to handle.
  getRecipes: (tag?: string, includeArchived = false) => {
    const query = new URLSearchParams()
    if (tag) query.set('tag', tag)
    if (includeArchived) query.set('includeArchived', 'true')
    const suffix = query.toString()
    return request<RecipeSummaryDto[]>(`/recipes${suffix ? `?${suffix}` : ''}`)
  },
  getRecipeTags: (includeArchived = false) =>
    request<RecipeTagCountDto[]>(`/recipes/tags${includeArchived ? '?includeArchived=true' : ''}`),
  getRecipe: (id: number) => request<RecipeDto>(`/recipes/${id}`),
  // Stage M2. The server fetches the page, so this can take a few seconds and the screen shows a
  // working state rather than pretending it is instant. A page with no recipe data comes back 200
  // with `confidence: "Empty"` — the request succeeded, the page just had nothing in it, and that
  // is a specific screen rather than an error.
  importRecipe: (input: RecipeImportInput) =>
    request<RecipeImportResponse>('/recipes/import', { method: 'POST', ...json(input) }),
  // The paste path, for publishers that refuse the fetcher — every People Inc. property answers 402
  // to any client. Nothing is fetched here: the household read the page in their own browser, and
  // the server parses the text it was handed. Same response shape as the link importer, so the
  // screen renders one set of outcomes.
  importRecipeText: (input: RecipePasteInput) =>
    request<RecipeImportResponse>('/recipes/import/text', { method: 'POST', ...json(input) }),
  /** URL of a recipe's cached hero image. Served from disk, never from wwwroot. */
  recipeImageUrl: (id: number) => `/api/recipes/${id}/image`,
  // Fork: the original is never touched. The body carries only the name and the edited amounts —
  // steps, source, cuisine and tags are copied server-side, so the client cannot drop provenance by
  // omitting a field it did not happen to be showing.
  forkRecipe: (id: number, input: ForkRecipeInput) =>
    request<RecipeDto>(`/recipes/${id}/fork`, { method: 'POST', ...json(input) }),
  createRecipe: (input: RecipeInput) => request<RecipeDto>('/recipes', { method: 'POST', ...json(input) }),
  // `baseVersion` makes it a conditional write: a 409 carries the current server state so the
  // write-queue can offer "keep mine / use server" rather than silently overwriting.
  updateRecipe: (id: number, input: RecipeInput, baseVersion?: number) =>
    request<RecipeDto>(`/recipes/${id}${baseVersion === undefined ? '' : `?baseVersion=${baseVersion}`}`, {
      method: 'PUT',
      ...json(input),
    }),
  // Its own action rather than a field on `updateRecipe`: cuisine is a reserved tag, so setting it
  // through the full replace would mean sending the whole tag list back — and a screen that only
  // wanted to say "this is Mexican" would be able to drop every other tag by omitting it.
  setRecipeCuisine: (id: number, cuisine: string | null, baseVersion?: number) =>
    request<RecipeDto>(
      `/recipes/${id}/cuisine${baseVersion === undefined ? '' : `?baseVersion=${baseVersion}`}`,
      { method: 'PUT', ...json({ cuisine }) },
    ),
  // Deleting a planned recipe doesn't blank the night it was planned for — the server rewrites
  // those entries to free text holding the title first.
  deleteRecipe: (id: number, baseVersion?: number) =>
    request<void>(`/recipes/${id}${baseVersion === undefined ? '' : `?baseVersion=${baseVersion}`}`, {
      method: 'DELETE',
    }),

  // ---- Meals: week plan ----
  // `start` is a plain YYYY-MM-DD calendar date; omit it for the week beginning today.
  getMealWeek: (start?: string) => request<MealWeekDto>(`/meals/week${start ? `?start=${start}` : ''}`),
  // An upsert, not a create: a date+slot holds at most one plan, which is what makes tapping an
  // empty row and tapping a filled one the same call.
  planMeal: (input: MealPlanInput, baseVersion?: number) =>
    request<MealPlanEntryDto>(`/meals/plan${baseVersion === undefined ? '' : `?baseVersion=${baseVersion}`}`, {
      method: 'PUT',
      ...json(input),
    }),
  clearMeal: (date: string, slot: MealSlotName, baseVersion?: number) =>
    request<void>(
      `/meals/plan?date=${date}&slot=${slot}${baseVersion === undefined ? '' : `&baseVersion=${baseVersion}`}`,
      { method: 'DELETE' },
    ),
  // The only writer of `wasEaten`, and deliberately separate from planMeal: folding it into the
  // upsert would mean every assign either carries the answer or silently clears it.
  //
  // No `baseVersion` — the question has one true answer, so a conflict prompt on "did you eat it"
  // would be ceremony. 404s rather than inventing a row for a night nothing was planned on.
  setMealEaten: (input: MealEatenInput) =>
    request<MealPlanEntryDto>('/meals/plan/eaten', { method: 'PUT', ...json(input) }),
  // Removes one dish from a night. Distinct from clearMeal, which cancels the night — dropping the
  // side is not the same act as calling dinner off.
  removePlanEntry: (entryId: number) =>
    request<void>(`/meals/plan/entry/${entryId}`, { method: 'DELETE' }),

  // ---- Saved meals (MEALS_GROUPS) ----
  getMeals: (includeArchived = false) =>
    request<MealSummaryDto[]>(`/meals/saved${includeArchived ? '?includeArchived=true' : ''}`),
  getMeal: (id: number) => request<MealDto>(`/meals/saved/${id}`),
  createMeal: (input: MealInput) => request<MealDto>('/meals/saved', { method: 'POST', ...json(input) }),
  updateMeal: (id: number, input: MealInput, baseVersion?: number) =>
    request<MealDto>(`/meals/saved/${id}${baseVersion === undefined ? '' : `?baseVersion=${baseVersion}`}`, {
      method: 'PUT',
      ...json(input),
    }),
  deleteMeal: (id: number, baseVersion?: number) =>
    request<void>(`/meals/saved/${id}${baseVersion === undefined ? '' : `?baseVersion=${baseVersion}`}`, {
      method: 'DELETE',
    }),
  /** Expands the meal onto the night, replacing whatever was there. */
  assignMeal: (input: AssignMealInput) =>
    request<MealPlanEntryDto[]>(`/meals/saved/${input.mealId}/assign`, { method: 'POST', ...json(input) }),
  /** Sets cooked together often enough to be worth naming. Confirmed nights only. */
  getCoOccurrences: () => request<CoOccurrenceDto[]>('/meals/saved/co-occurrences'),

  // ---- Pantry (Stage M5) ----
  // Every write here goes through the server's ledger; nothing sets a quantity directly. The
  // client never computes stock either — `check` and `deduct` are server-side because the
  // ingredient aliases live there.
  getPantry: (location?: string) =>
    request<PantryListDto>(`/pantry${location && location !== 'All' ? `?location=${location}` : ''}`),
  getPantryEvents: (id: number, take = 40) =>
    request<PantryEventDto[]>(`/pantry/${id}/events?take=${take}`),
  createPantryItem: (input: PantryItemInput) =>
    request<PantryItemDto>('/pantry', { method: 'POST', ...json(input) }),
  updatePantryItem: (id: number, input: PantryItemInput, baseVersion?: number) =>
    request<PantryItemDto>(`/pantry/${id}${baseVersion === undefined ? '' : `?baseVersion=${baseVersion}`}`, {
      method: 'PATCH',
      ...json(input),
    }),
  // Archive, not delete — the ledger references it, and a hard delete would take the household's
  // history of that shelf with it.
  archivePantryItem: (id: number, baseVersion?: number) =>
    request<void>(`/pantry/${id}${baseVersion === undefined ? '' : `?baseVersion=${baseVersion}`}`, {
      method: 'DELETE',
    }),
  /** One scan, written immediately. The run list is the undo (DECISIONS PG3). */
  scanIntoPantry: (input: ScanInput) =>
    request<ScanResultDto>('/pantry/scan', { method: 'POST', ...json(input) }),
  /** `NAME IT` — the entire learning mechanism for unknown barcodes. */
  namePantryBarcode: (input: CatalogueInput) =>
    request<void>('/pantry/catalogue', { method: 'POST', ...json(input) }),
  undoPantryEvent: (eventId: number) =>
    request<PantryItemDto>(
      `/pantry/events/${eventId}/undo`,
      { method: 'POST' },
    ),

  // 9b. A 204 means "nothing worth saying" — every line resolved, or the check was already
  // dismissed for this entry. There is no "you have everything" screen, so the caller shows nothing.
  checkStock: (recipeId: number, servings?: number, planEntryId?: number) => {
    const query = new URLSearchParams({ recipeId: String(recipeId) })
    if (servings != null) query.set('servings', String(servings))
    if (planEntryId != null) query.set('planEntryId', String(planEntryId))
    return request<StockCheckDto | undefined>(`/pantry/check?${query}`)
  },
  dismissStockCheck: (planEntryId: number) =>
    request<void>(
      `/pantry/check/${planEntryId}/dismiss`,
      { method: 'POST' },
    ),
  /** "We've got these — the panel's wrong": marks each item seen today, at least at what's needed. */
  correctStock: (input: CorrectStockInput) =>
    request<void>('/pantry/correct', { method: 'POST', ...json(input) }),

  // 9f. Already applied by the time this answers — the receipt is a record, not a prompt. A 204
  // means nothing was deductible, and the screen simply does not appear.
  deductForNight: (planEntryId: number) =>
    request<DeductionReceiptDto | undefined>(
      `/pantry/deduct?planEntryId=${planEntryId}`,
      { method: 'POST' },
    ),
  undoDeduction: (planEntryId: number) =>
    request<void>(
      `/pantry/deduct/${planEntryId}/undo`,
      { method: 'POST' },
    ),

  // ---- Grocery (9e) ----
  getGrocery: () => request<GroceryListDto>('/grocery'),
  addGroceryLine: (input: GroceryInput) =>
    request<GroceryLineDto>('/grocery', { method: 'POST', ...json(input) }),
  /** The batch behind 9b's primary action. Merges per §1, same as adding one at a time. */
  addGroceryLines: (lines: GroceryInput[]) =>
    request<GroceryListDto>('/grocery/batch', { method: 'POST', ...json({ lines }) }),
  updateGroceryLine: (id: number, input: GroceryInput, baseVersion?: number) =>
    request<GroceryLineDto>(`/grocery/${id}${baseVersion === undefined ? '' : `?baseVersion=${baseVersion}`}`, {
      method: 'PATCH',
      ...json(input),
    }),
  /** Ticking a line off **puts the stock back** — the return trip (DECISIONS P8). */
  checkGroceryLine: (id: number, checkedOff: boolean) =>
    request<GroceryLineDto>(
      `/grocery/${id}/check?checkedOff=${checkedOff}`,
      { method: 'POST' },
    ),
  deleteGroceryLine: (id: number) => request<void>(`/grocery/${id}`, { method: 'DELETE' }),
  clearCheckedGrocery: () => request<void>('/grocery/clear-checked', { method: 'POST' }),
  getMirrorStatus: () => request<MirrorStatusDto>('/grocery/mirror'),
  setMirror: (input: MirrorSettingsInput) =>
    request<MirrorStatusDto>('/grocery/mirror', { method: 'PUT', ...json(input) }),

  // ---- Order imports (9d) ----
  // Nothing is written to the pantry until `applyImport`. A bad import is twenty-four wrong rows.
  getPendingImports: () => request<OrderImportDto[]>('/pantry/imports?status=Pending'),
  getImport: (id: number) => request<OrderImportDto>(`/pantry/imports/${id}`),
  createImport: (input: OrderImportInput) =>
    request<OrderImportDto>('/pantry/imports', { method: 'POST', ...json(input) }),
  updateImportLine: (id: number, lineId: number, input: ImportLineInput) =>
    request<OrderImportDto>(`/pantry/imports/${id}/lines/${lineId}`, { method: 'PATCH', ...json(input) }),
  // A 409 carries the applied import, so the second person is told who got there first rather than
  // being shown a failure (DECISIONS PG7).
  applyImport: (id: number) =>
    request<OrderImportDto>(`/pantry/imports/${id}/apply`, { method: 'POST', ...json({}) }),
  undoImport: (id: number) =>
    request<void>(
      `/pantry/imports/${id}/undo`,
      { method: 'POST' },
    ),
  discardImport: (id: number) => request<void>(`/pantry/imports/${id}`, { method: 'DELETE' }),

  // ---- Units ----
  // Read-only: there is no "add a unit" screen because typing one nobody has used before *is*
  // adding it. The server normalises and adopts on save; this list is what the field suggests
  // while somebody types. See app/units.ts, which fetches it once for the whole session.
  getUnits: () => request<MeasurementUnitDto[]>('/units'),
}
