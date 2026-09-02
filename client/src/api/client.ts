import {
  armSessionLostNotice as armNotice,
  authorizedFetch,
  SESSION_LOST_EVENT as SessionLostEvent,
  setPrivateNetworkConfirmed as setConfirmed,
} from './privateNetwork'

/**
 * Re-exported from `privateNetwork`, where the session-lost machinery now lives.
 *
 * It moved because it is part of the identity boundary rather than of the JSON helper: three of the
 * four authenticated transports were not announcing a lost session, and centralising the announcement
 * at the transport is what fixed that.
 */
export const SESSION_LOST_EVENT = SessionLostEvent
export const armSessionLostNotice = armNotice

/**
 * Re-exported so `SessionProvider` keeps one import for the session's effects on the API layer.
 * The policy itself lives in `privateNetwork.ts`.
 */
export const setPrivateNetworkConfirmed = setConfirmed

import type {
  ProfileDto,
  ProfilePickerDto,
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
  ReadPhotoRequest,
  ReadPhotoResponse,
  CareEntryDto,
  CareEntryInput,
  CareEntryTypeName,
  CareSummaryDto,
  CareTimerDto,
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
  RecipeConversationInput,
  RecipeConversationReadingDto,
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
  ReadKitchenPhotoRequest,
  RecipeReadingDto,
  PurchaseReadingDto,
  DueRecipeDto,
  AisleOrderDto,
  MatchingCoverageDto,
  MealPlanTemplateDto,
  ApplyTemplateResultDto,
  CookabilityDto,
  ItemClaimDto,
  BarcodeLookupDto,
  ItemUsageDto,
  ShelfLifeDto,
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

/**
 * Fired the first time a data call comes back 401 — the session is gone and the panel does not
 * know it yet.
 *
 * <b>The request layer is the only place that sees this.</b> Every provider catches its own
 * `ApiError` and keeps what is on screen, which is right when the server is briefly unreachable and
 * wrong when the cookie has expired: nothing is coming back, ever, and each provider independently
 * decides to show its empty state. The panel then looks like it is working and reports an empty
 * pantry and no recipes — which is exactly what a household saw, and what the comment on `signOut`
 * already warned would happen with no session.
 *
 * An event rather than a direct call because `api` must not import a React provider; `SessionProvider`
 * listens and locks, which lands on the picker that fixes it.
 */
/**
 * How long a call may go unanswered before it is treated as unreachable.
 *
 * <b>There was no deadline here at all, and a request that never answers is not a slow one.</b> A
 * `fetch` to a host with no route does not fail promptly — it sits on an open socket until the OS
 * gives up, which is tens of seconds on a phone and unbounded on a page the OS freezes mid-request.
 * Every caller in the app treats an in-flight write as a reason to disable its controls, so a
 * request with no end is a screen with no end: the pump panel came back from a locked phone with
 * SWITCH NOW, PAUSE, FINISH and CANCEL all dimmed and no way to reach the session at all, because
 * `useCareLog`'s `writing` was set by a `pause` that was never going to resolve or reject.
 *
 * Ten seconds is the panel's own definition of unreachable — `ConnectionProvider` gives a probe four
 * — and the point is not the exact figure but that it exists: past it the request becomes the same
 * `ApiError(0, …)` a refused connection already raised, which every caller here already knows how to
 * answer. That is what puts the care log back on its offline path rather than leaving it waiting.
 */
const DEADLINE_MS = 10_000

/**
 * Long enough for a call the server answers by asking a model or a machine.
 *
 * Reading a photo, importing a recipe from a link and cycling the litter robot are not slow because
 * anything is wrong; they are slow because of what they do. They would fail the ordinary deadline
 * on a good day, so they say so at their call site rather than being special-cased in here.
 */
export const SLOW_CALL_MS = 90_000

/**
 * @param deadlineMs How long to wait before treating silence as unreachable. See {@link SLOW_CALL_MS}
 *   for the calls that legitimately need longer than the default.
 */
async function request<T>(path: string, init?: RequestInit, deadlineMs = DEADLINE_MS): Promise<T> {

  /* The caller's own `signal`, if it passed one through `init`, is still honoured: the spread below
     puts it in place and this only replaces it when there is none. Nothing in this file passes one
     today — the assist stream takes its signal as an argument and runs its own watchdog — but a
     deadline that silently ate a Stop would be a worse bug than the one it fixes. */
  const watchdog = new AbortController()
  let expired = false
  const deadline = setTimeout(() => { expired = true; watchdog.abort() }, deadlineMs)
  // Told apart from a refusal so the message says which happened. Both are status 0: to every
  // caller, "the server is not there" and "the server never answered" are the same fact.
  const unreachable = (cause: unknown) => new ApiError(
    0,
    expired
      ? 'The server did not answer in time.'
      : cause instanceof Error ? cause.message : 'Network error',
  )

  try {
    let res: Response
    try {
      res = await authorizedFetch(path, {
        headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
        signal: watchdog.signal,
        ...init,
      })
    } catch (cause) {
      /*
       * Network failure, or a refusal at the identity boundary — both surface as a 0-status
       * `ApiError`, and deliberately as the same one.
       *
       * Every caller in this app already handles `ApiError(0, …)`: it is what a refused connection
       * and a timed-out one both raise. So an unconfirmed panel degrades exactly as an unreachable
       * one does, rather than needing eleven providers to learn a new failure mode — and the
       * device-only Care log, which is built for a server it cannot reach, needs no changes at all.
       */
      throw unreachable(cause)
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
    /* The deadline covers the body too, and deliberately. Headers arriving is not the server having
       answered — a connection that dies between the two leaves `res.text()` hanging exactly as the
       fetch itself did, which is the same never-ending wait one gate further along. */
    let text: string
    try { text = await res.text() } catch (cause) { throw unreachable(cause) }
    return (text ? JSON.parse(text) : undefined) as T
  } finally {
    clearTimeout(deadline)
  }
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
  /*
   * The deadline, and what it is a deadline on.
   *
   * <b>Silence, not duration.</b> A turn is allowed to take as long as it takes — an agent that
   * spends four minutes on a tool run is working, and a ceiling on the whole turn would kill exactly
   * the long answers the streaming path exists for. What is never healthy is hearing *nothing*: the
   * server writes a keepalive comment every fifteen seconds for the whole turn (`KeepAliveEvery`),
   * so three missed beats means the other end is gone whatever the connection still claims.
   *
   * There was no deadline of any kind here, and a request that neither resolved nor rejected left
   * the turn on "Sending" for ever, took the rest of that chat's queue down with it, and offered
   * nobody a way out short of reloading the panel. A wait that cannot end is not a slow answer, it
   * is a lie about one.
   */
  const SILENCE_MS = 45_000

  // Linked by hand rather than through `AbortSignal.any`, which is too new to rely on for the phones
  // and panels this runs on. The caller's signal still means what it meant — Stop — and this one is
  // only ever the deadline, so the catch below can tell the two apart and say the right thing.
  const watchdog = new AbortController()
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const heard = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => { expired = true; watchdog.abort() }, SILENCE_MS)
  }
  const stopWatching = () => { if (timer !== undefined) clearTimeout(timer) }

  if (signal?.aborted) watchdog.abort()
  else signal?.addEventListener('abort', () => watchdog.abort(), { once: true })

  heard()

  let res: Response
  try {
    res = await authorizedFetch('/assist/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: watchdog.signal,
    })
    heard()
  } catch (cause) {
    stopWatching()
    if (signal?.aborted) return
    if (expired) throw new ApiError(0, 'The assistant did not answer.')
    throw new ApiError(0, cause instanceof Error ? cause.message : 'Network error')
  }

  if (!res.ok) {
    stopWatching()
    const text = await res.text().catch(() => '')
    throw new ApiError(res.status, text || res.statusText)
  }
  if (!res.body) {
    stopWatching()
    throw new ApiError(0, 'The assistant stream returned no body.')
  }

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
      // Anything at all counts, including the keepalive comment `dispatch` throws away. The question
      // this answers is whether the other end is still there, and a colon on its own says yes.
      heard()
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
    // The deadline, said as what happened rather than as a broken pipe. The caller decides what to
    // do about it — a turn that got as far as being named is asked about rather than mourned, see
    // `assistTurns.execute` — but either way it ends, which is the whole point of this.
    if (expired) throw new ApiError(0, 'The assistant stopped sending mid-answer.')
    throw cause instanceof ApiError ? cause : new ApiError(0, 'The assistant stream ended unexpectedly.')
  } finally {
    stopWatching()
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
  /**
   * The picker's roster — anonymous, and deliberately four fields.
   *
   * The only profile read that may precede confirmation. `listProfiles` below is the full shape and
   * is authenticated; asking for it before sign-in now fails, which is the point.
   */
  listProfilePicker: () => request<ProfilePickerDto[]>('/profiles/picker'),
  listProfiles: () => request<ProfileDto[]>('/profiles'),
  createProfile: (name: string, initial: string) =>
    request<ProfileDto>('/profiles', { method: 'POST', ...json({ name, initial }) }),
  /**
   * `role` is optional and means *leave as it is* when absent — the server reads it the same
   * way. Everything else is a full replace, so omitting a name still blanks it; only the field
   * that governs what a member may do is protected from being changed by silence.
   */
  /**
   * How your own profile locks when the panel goes idle. **Yours only** — the server refuses it for
   * anybody else's id, because turning off somebody's idle lock is the same act as unlocking them.
   */
  setLockPreference: (id: number, requirePinWhenIdle: boolean, stayLoggedIn: boolean) =>
    request<ProfileDto>(`/profiles/${id}/lock`, {
      method: 'PUT',
      ...json({ requirePinWhenIdle, stayLoggedIn }),
    }),
  updateProfile: (
    id: number,
    patch: Omit<ProfileDto, 'id' | 'hasPin' | 'role'> & Partial<Pick<ProfileDto, 'role'>>,
  ) => request<ProfileDto>(`/profiles/${id}`, { method: 'PUT', ...json(patch) }),
  deleteProfile: (id: number) => request<void>(`/profiles/${id}`, { method: 'DELETE' }),
  /**
   * Set or change a PIN. `currentPin` is the one being replaced.
   *
   * Required whenever somebody is changing their *own* PIN, and refused with a 401 without it —
   * being signed in is not proof, because the wall panel stays signed in. Omitted on the two
   * occasions there is nothing to prove: a profile that has no PIN yet, and an administrator
   * resetting another member's forgotten one.
   */
  setPin: (id: number, pin: string, currentPin?: string) =>
    request<void>(`/profiles/${id}/pin`, { method: 'PUT', ...json({ pin, currentPin }) }),
  /**
   * Remove a PIN, on the same rule — a member removing their own is asked for it first, or clearing
   * then re-setting would be a change of PIN with no PIN typed.
   *
   * The body on a DELETE is deliberate: a query string is the one place a PIN ends up in a log.
   */
  clearPin: (id: number, currentPin?: string) =>
    request<void>(`/profiles/${id}/pin`, { method: 'DELETE', ...json({ currentPin }) }),

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
  /** Same reasoning as setCatName — edited from Baby Settings, which holds none of the rest. */
  setBabyName: (name: string | null) =>
    request<SettingsDto>('/settings/baby-name', { method: 'PUT', ...json({ name }) }),
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
  /**
   * Whether a photograph read into an engagement is kept with it.
   *
   * New engagements only — this never reaches back and deletes flyers already kept. Its own route
   * rather than a field on the conversation policy: the same kind of decision about two different
   * subjects, and one switch for both would mean giving up chat history to stop keeping photographs.
   */
  setEventPhotoPolicy: (keepEventPhotos: boolean) =>
    request<SettingsDto>('/settings/event-photo-policy', { method: 'PUT', ...json({ keepEventPhotos }) }),

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
  /**
   * Read a photograph for engagements. Returns drafts; writes nothing, and stores nothing.
   *
   * The photograph reaches the calendar through a decision, never through a reading — so the bytes
   * are sent again with the write if somebody presses ADD TO CALENDAR, and are forgotten here if
   * nobody does. `available: false` means this panel has no reader configured, which is a different
   * fact from an empty result and is not the photograph's fault.
   */
  readPhoto: (input: ReadPhotoRequest) =>
    request<ReadPhotoResponse>('/calendar/read-photo', { method: 'POST', ...json(input) }, SLOW_CALL_MS),
  /** Where a kept photograph is served from. Not a data URL — the browser fetches it with the session. */
  eventPhotoUrl: (id: number) => `/api/calendar/events/${id}/photo`,

  // ---- Care logging (the panel's own log) ----
  //
  // Ten types where that integration offers four, a real timestamp where its writes have none, and
  // entries that can be corrected. This is the whole of the panel's baby data now — the
  // Huckleberry integration that used to sit beside it was retired on 2026-08-30.
  getCareSummary: (childKey: string) =>
    request<CareSummaryDto>(`/care/${childKey}/summary`),
  getCareEntries: (childKey: string, fromIso?: string, toIso?: string) =>
    request<CareEntryDto[]>(
      `/care/${childKey}/entries`
      + (fromIso && toIso ? `?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}` : ''),
    ),
  addCareEntry: (childKey: string, input: CareEntryInput) =>
    request<CareEntryDto>(`/care/${childKey}/entries`, { method: 'POST', ...json(input) }),
  updateCareEntry: (id: number, input: CareEntryInput) =>
    request<CareEntryDto>(`/care/entries/${id}`, { method: 'PUT', ...json(input) }),
  deleteCareEntry: (id: number) =>
    request<void>(`/care/entries/${id}`, { method: 'DELETE' }),

  /**
   * Start, pause, resume, cancel — and complete, which is deliberately not the same act as cancel.
   *
   * `finish` is the pump's third stop and is none of the other two: it measures the session and
   * holds it, so the panel can ask how much was expressed before anything is written.
   */
  careTimer: (
    childKey: string,
    type: CareEntryTypeName,
    action: 'start' | 'pause' | 'resume' | 'cancel' | 'finish',
    query = '',
  ) => request<CareTimerDto | void>(`/care/${childKey}/timer/${type}/${action}${query}`, { method: 'POST' }),
  careTimerSide: (childKey: string, type: CareEntryTypeName, side: string) =>
    request<CareTimerDto>(`/care/${childKey}/timer/${type}/side/${side}`, { method: 'POST' }),
  carePumpPhase: (childKey: string) =>
    request<CareTimerDto>(`/care/${childKey}/timer/pump/phase`, { method: 'POST' }),
  /**
   * Ends the session and writes it, back-dated to when it started.
   *
   * `atUtc` overrides that reckoning, and only the pump's finish step sends one — a timer left
   * running while the pump was packed away measures more than the session ran.
   */
  careTimerComplete: (
    childKey: string, type: CareEntryTypeName, amount?: number | null, unit?: string, atUtc?: string,
  ) => {
    const params = new URLSearchParams()
    if (amount != null) {
      params.set('amount', String(amount))
      params.set('unit', unit ?? 'oz')
    }
    if (atUtc) params.set('atUtc', atUtc)
    const query = params.toString()
    return request<CareEntryDto>(
      `/care/${childKey}/timer/${type}/complete${query ? `?${query}` : ''}`,
      { method: 'POST' },
    )
  },


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
    authorizedFetch(`/assist/chat/turns/${encodeURIComponent(turnId)}/cancel`, { method: 'POST' })
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
  // The robot has to physically run; the server answers when it has, not when it was asked.
  startLitterCycle: (slug: string) =>
    request<CycleResultDto>(`/cats/${slug}/cycle`, { method: 'POST' }, SLOW_CALL_MS),
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
    request<RecipeImportResponse>('/recipes/import', { method: 'POST', ...json(input) }, SLOW_CALL_MS),
  // The paste path, for publishers that refuse the fetcher — every People Inc. property answers 402
  // to any client. Nothing is fetched here: the household read the page in their own browser, and
  // the server parses the text it was handed. Same response shape as the link importer, so the
  // screen renders one set of outcomes.
  /**
   * Read a recipe off a photograph. Returns what it says; saves nothing.
   *
   * The save is `importRecipeText` with whatever the household left in the fields — so a
   * photographed recipe goes through the same ingredient parser as every other one and therefore
   * scales the same way.
   */
  readRecipePhoto: (input: ReadKitchenPhotoRequest) =>
    request<RecipeReadingDto>('/recipes/read-photo', { method: 'POST', ...json(input) }, SLOW_CALL_MS),
  importRecipeText: (input: RecipePasteInput) =>
    request<RecipeImportResponse>('/recipes/import/text', { method: 'POST', ...json(input) }, SLOW_CALL_MS),
  /**
   * Read a recipe out of a chat. Returns what is there; saves nothing.
   *
   * Newest message first. The save is `importRecipeText` with the message the reading names, so a
   * recipe out of a conversation goes through the same parser as a paste, a photograph and a page —
   * and therefore scales, matches the pantry and merges the same way.
   */
  readConversationRecipe: (input: RecipeConversationInput) =>
    request<RecipeConversationReadingDto>(
      '/recipes/read-conversation', { method: 'POST', ...json(input) }, SLOW_CALL_MS),
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
  /**
   * One item, with the two facts only the sheet asks for — `inPlaceSinceUtc` and the kept-here
   * count. The sheet used to pick its item out of `getPantry()`, which was fine while everything it
   * showed was already on the row; those two are ledger questions and are not worth answering for
   * forty rows to render one.
   */
  getPantryItem: (id: number) => request<PantryItemDto>(`/pantry/${id}`),
  /**
   * Shelf phrases this household already uses in a location — suggestions, never a vocabulary.
   * Scoped so a freezer offers freezer places; anything may still be typed.
   */
  getPantryShelves: (location?: string) =>
    request<string[]>(`/pantry/shelves${location ? `?location=${encodeURIComponent(location)}` : ''}`),
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
  /**
   * What is this barcode? Identification only — writes nothing.
   *
   * The add form's viewfinder path. `scanIntoPantry` is the phone's tally and moves stock, which is
   * exactly wrong for a form: a camera decodes the same pack many times a second.
   */
  lookupBarcode: (barcode: string, format?: string | null) =>
    request<BarcodeLookupDto>(
      `/pantry/catalogue/${encodeURIComponent(barcode)}${format ? `?format=${encodeURIComponent(format)}` : ''}`),

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
  /**
   * Read one screenshot of an order, or a photograph of a till receipt. Writes nothing.
   *
   * Separate from `createImport` on purpose: one shot rarely covers a big order, so the panel reads
   * several and posts the collected lines once. That is also what lets somebody add another shot
   * after seeing what the first one caught.
   */
  readPurchasePhoto: (input: ReadKitchenPhotoRequest) =>
    request<PurchaseReadingDto>('/pantry/imports/read-photo', { method: 'POST', ...json(input) }, SLOW_CALL_MS),
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

  // ---- The Kitchen loop (KITCHEN_LOOP_ADDENDUM) ----

  /**
   * What to cook first, ranked by what is already open (§4).
   *
   * Feeds the home page's `USE IT OR LOSE IT` band. Empty is a perfectly good answer — a household
   * with nothing open gets no band rather than a screen telling it off.
   */
  getDueRecipes: (take = 5) => request<DueRecipeDto[]>(`/pantry/due?take=${take}`),

  /** `MARK OPENED` / `MARK FINISHED`. One tap, and it never changes a quantity (§4). */
  setOpened: (itemId: number, finished = false) =>
    request<PantryItemDto>(
      `/pantry/${itemId}/opened${finished ? '?finished=true' : ''}`,
      { method: 'POST' },
    ),

  /**
   * Say how much is in one pack, and get back whatever that was blocking (§2).
   *
   * `recipeId` is optional and worth passing whenever the mapping was asked for from a check: the
   * answer comes back re-run, so the panel does not have to ask again to find out if it helped.
   */
  setPackSize: (
    itemId: number,
    input: { packSize: number | null; packUnit: string | null; profileId?: number },
    recipeId?: number,
  ) =>
    request<{ item: PantryItemDto; recheck: StockCheckDto | null }>(
      `/pantry/${itemId}/pack-size${recipeId == null ? '' : `?recipeId=${recipeId}`}`,
      { method: 'POST', ...json(input) },
    ),

  /** The leftovers card — `FRIDGE`, `FREEZER` or `NONE LEFT`. A 204 means nothing was created (§5). */
  decideLeftovers: (
    planEntryId: number,
    decision: 'Fridge' | 'Freezer' | 'None',
    portions?: number,
  ) =>
    request<PantryItemDto | undefined>(
      `/pantry/deduct/${planEntryId}/produced`,
      { method: 'POST', ...json({ decision, portions }) },
    ),

  // ---- The order a shop is walked (SETTINGS_AND_IMPORT §2) ----

  getAisleOrder: (store: string) =>
    request<AisleOrderDto>(`/pantry/aisles?store=${encodeURIComponent(store)}`),

  /** Dragging always wins: this replaces the shop's order outright. */
  setAisleOrder: (store: string, aisles: string[]) =>
    request<AisleOrderDto>(
      `/pantry/aisles?store=${encodeURIComponent(store)}`,
      { method: 'PUT', ...json({ aisles }) },
    ),

  // ---- Knowing what matches what (MATCHING_AND_ALIASES) ----

  /** Where every recipe stands against the shelves — one request for the whole folder. */
  getCookable: () => request<CookabilityDto[]>('/pantry/cookable'),

  /** Which nights have spoken for one item, soonest first. Past nights are excluded. */
  getItemClaims: (itemId: number) => request<ItemClaimDto[]>(`/pantry/${itemId}/claims`),

  /** Which recipes cook one item, and how much each asks for. Spoken-for nights lead. */
  getItemUsage: (itemId: number) => request<ItemUsageDto[]>(`/pantry/${itemId}/used-by`),

  // ---- How long things last (SETTINGS_AND_IMPORT §1) ----

  getShelfLife: () => request<ShelfLifeDto[]>('/pantry/shelf-life'),

  setShelfLife: (id: number, days: number) =>
    request<ShelfLifeDto>(`/pantry/shelf-life/${id}`, { method: 'PATCH', ...json({ days }) }),

  /** `PUT THEM BACK` — restores every assumption to the shipped default. */
  resetShelfLife: () => request<ShelfLifeDto[]>('/pantry/shelf-life/reset', { method: 'POST' }),

  getMatching: () => request<MatchingCoverageDto>('/pantry/matching'),

  /** Ranked candidates for one unmatched line. No free-text field anywhere — M2 picks from these. */
  getMatchCandidates: (ingredient: string, take = 3) =>
    request<PantryItemDto[]>(
      `/pantry/matching/candidates?ingredient=${encodeURIComponent(ingredient)}&take=${take}`,
    ),

  /** `YES · REMEMBER IT`. Household-wide, and it clears any earlier refusal of the same pair. */
  teachMatch: (ingredient: string, pantryItemId: number) =>
    request<MatchingCoverageDto>(
      '/pantry/matching/teach',
      { method: 'POST', ...json({ ingredient, pantryItemId }) },
    ),

  /** `NONE OF THESE`. Suppresses that pair for good; the ingredient stays matchable elsewhere. */
  refuseMatch: (ingredient: string, pantryItemId: number) =>
    request<MatchingCoverageDto>(
      '/pantry/matching/refuse',
      { method: 'POST', ...json({ ingredient, pantryItemId }) },
    ),

  // ---- Saved weeks (KITCHEN_LOOP_ADDENDUM §6) ----

  getSavedWeeks: () => request<MealPlanTemplateDto[]>('/meals/templates'),

  /** `SAVE THIS WEEK` — keeps the shape, never anything about stock. */
  saveWeek: (name: string, start: string) =>
    request<MealPlanTemplateDto>('/meals/templates', { method: 'POST', ...json({ name, start }) }),

  /** Writes plan entries and re-settles claims. Touches no stock. */
  applySavedWeek: (id: number, start: string) =>
    request<ApplyTemplateResultDto>(
      `/meals/templates/${id}/apply?start=${start}`,
      { method: 'POST' },
    ),
}
