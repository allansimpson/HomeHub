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
  TaskItemDto,
  TaskCreateInput,
  ClimateZoneDto,
  ClimateModeName,
} from './types'

/**
 * Thin typed wrapper over the HomeHub API. Same-origin in prod; the Vite proxy forwards
 * `/api` to Kestrel in dev. Non-2xx responses throw {@link ApiError} so callers can show the
 * calm reconnecting state rather than crashing (offline-first — hardened further in Stage 9).
 */
export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
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
    throw new ApiError(res.status, text || res.statusText)
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
  updateSettings: (patch: { idleTimeoutMinutes: number; idleDimmingEnabled: boolean }) =>
    request<SettingsDto>('/settings', { method: 'PUT', ...json(patch) }),
  setActiveProfile: (profileId: number | null) =>
    request<SettingsDto>('/settings/active-profile', { method: 'PUT', ...json({ profileId }) }),

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

  // ---- Calendar ----
  getEvents: (fromIso: string, toIso: string) =>
    request<CalendarEventDto[]>(`/calendar/events?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`),
  getUpcoming: (days = 7) => request<CalendarEventDto[]>(`/calendar/upcoming?days=${days}`),
  getEvent: (id: number) => request<CalendarEventDto>(`/calendar/events/${id}`),
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
  deleteTask: (id: number) => request<void>(`/tasks/${id}`, { method: 'DELETE' }),

  // ---- Climate ----
  getClimateZones: () => request<ClimateZoneDto[]>('/climate/zones'),
  setClimateSetPoint: (id: number, setPointF: number) =>
    request<ClimateZoneDto>(`/climate/zones/${id}/setpoint`, { method: 'PUT', ...json({ setPointF }) }),
  setClimateMode: (id: number, mode: ClimateModeName) =>
    request<ClimateZoneDto>(`/climate/zones/${id}/mode`, { method: 'PUT', ...json({ mode }) }),
  applyClimateScene: (scene: 'evening' | 'all-off') =>
    request<void>('/climate/scene', { method: 'POST', ...json({ scene }) }),
}
