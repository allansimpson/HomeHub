import type {
  ProfileDto,
  SettingsDto,
  VerifyPinResult,
  ZoneReadingDto,
  ZoneHistoryDto,
  ActiveAlertDto,
  ThresholdDto,
  WeatherSnapshotDto,
  CalendarEventDto,
  CalendarEventInput,
  SyncCalendarDto,
  TaskItemDto,
  TaskCreateInput,
  SyncListDto,
  ClimateZoneDto,
  ClimateModeName,
  AssistantChatRequest,
  AssistantChatResponse,
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

export const api = {
  // ---- Profiles ----
  listProfiles: () => request<ProfileDto[]>('/profiles'),
  createProfile: (name: string, initial: string) =>
    request<ProfileDto>('/profiles', { method: 'POST', ...json({ name, initial }) }),
  updateProfile: (id: number, patch: Omit<ProfileDto, 'id' | 'hasPin'>) =>
    request<ProfileDto>(`/profiles/${id}`, { method: 'PUT', ...json(patch) }),
  deleteProfile: (id: number) => request<void>(`/profiles/${id}`, { method: 'DELETE' }),
  setPin: (id: number, pin: string) =>
    request<void>(`/profiles/${id}/pin`, { method: 'PUT', ...json({ pin }) }),
  clearPin: (id: number) => request<void>(`/profiles/${id}/pin`, { method: 'DELETE' }),
  verifyPin: (id: number, pin: string) =>
    request<VerifyPinResult>(`/profiles/${id}/verify-pin`, { method: 'POST', ...json({ pin }) }),

  // ---- Settings ----
  getSettings: () => request<SettingsDto>('/settings'),
  updateSettings: (patch: { idleTimeoutMinutes: number; idleDimmingEnabled: boolean; daylightBoost: string }) =>
    request<SettingsDto>('/settings', { method: 'PUT', ...json(patch) }),
  setActiveProfile: (profileId: number | null) =>
    request<SettingsDto>('/settings/active-profile', { method: 'PUT', ...json({ profileId }) }),
  /** Its own route so Litter Settings can save the name without echoing back settings it never showed. */
  setCatName: (name: string | null) =>
    request<SettingsDto>('/settings/cat-name', { method: 'PUT', ...json({ name }) }),
  /** Same reasoning as setCatName — edited from Litter Settings, which holds none of the rest. */
  setLitterFullPercent: (percent: number) =>
    request<SettingsDto>('/settings/litter-full-percent', { method: 'PUT', ...json({ percent }) }),

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

  // ---- Calendar (per active profile) ----
  getEvents: (fromIso: string, toIso: string, profileId?: number) =>
    request<CalendarEventDto[]>(
      `/calendar/events?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}${profileId != null ? `&profileId=${profileId}` : ''}`,
    ),
  getUpcoming: (days = 7, profileId?: number) =>
    request<CalendarEventDto[]>(`/calendar/upcoming?days=${days}${profileId != null ? `&profileId=${profileId}` : ''}`),
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
  getTasks: (profileId?: number) =>
    request<TaskItemDto[]>(`/tasks${profileId != null ? `?profileId=${profileId}` : ''}`),
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
  getClimateZones: () => request<ClimateZoneDto[]>('/climate/zones'),
  setClimateSetPoint: (id: number, setPointF: number) =>
    request<ClimateZoneDto>(`/climate/zones/${id}/setpoint`, { method: 'PUT', ...json({ setPointF }) }),
  setClimateMode: (id: number, mode: ClimateModeName) =>
    request<ClimateZoneDto>(`/climate/zones/${id}/mode`, { method: 'PUT', ...json({ mode }) }),
  applyClimateScene: (scene: 'evening' | 'all-off') =>
    request<void>('/climate/scene', { method: 'POST', ...json({ scene }) }),

  // ---- Assistant ----
  askAssistant: (body: AssistantChatRequest) =>
    request<AssistantChatResponse>('/assistant/chat', { method: 'POST', ...json(body) }),

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
  undoPantryEvent: (eventId: number, profileId?: number | null) =>
    request<PantryItemDto>(
      `/pantry/events/${eventId}/undo${profileId != null ? `?profileId=${profileId}` : ''}`,
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
  dismissStockCheck: (planEntryId: number, profileId?: number | null) =>
    request<void>(
      `/pantry/check/${planEntryId}/dismiss${profileId != null ? `?profileId=${profileId}` : ''}`,
      { method: 'POST' },
    ),
  /** "We've got these — the panel's wrong": marks each item seen today, at least at what's needed. */
  correctStock: (input: CorrectStockInput) =>
    request<void>('/pantry/correct', { method: 'POST', ...json(input) }),

  // 9f. Already applied by the time this answers — the receipt is a record, not a prompt. A 204
  // means nothing was deductible, and the screen simply does not appear.
  deductForNight: (planEntryId: number, profileId?: number | null) =>
    request<DeductionReceiptDto | undefined>(
      `/pantry/deduct?planEntryId=${planEntryId}${profileId != null ? `&profileId=${profileId}` : ''}`,
      { method: 'POST' },
    ),
  undoDeduction: (planEntryId: number, profileId?: number | null) =>
    request<void>(
      `/pantry/deduct/${planEntryId}/undo${profileId != null ? `?profileId=${profileId}` : ''}`,
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
  checkGroceryLine: (id: number, checkedOff: boolean, profileId?: number | null) =>
    request<GroceryLineDto>(
      `/grocery/${id}/check?checkedOff=${checkedOff}${profileId != null ? `&profileId=${profileId}` : ''}`,
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
  applyImport: (id: number, profileId?: number | null) =>
    request<OrderImportDto>(`/pantry/imports/${id}/apply`, { method: 'POST', ...json({ profileId }) }),
  undoImport: (id: number, profileId?: number | null) =>
    request<void>(
      `/pantry/imports/${id}/undo${profileId != null ? `?profileId=${profileId}` : ''}`,
      { method: 'POST' },
    ),
  discardImport: (id: number) => request<void>(`/pantry/imports/${id}`, { method: 'DELETE' }),
}
