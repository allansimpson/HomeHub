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

export interface SettingsDto {
  idleTimeoutMinutes: number
  idleDimmingEnabled: boolean
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

export interface VerifyPinResult {
  success: boolean
  /** Present when the profile is in a lockout cooldown. */
  lockedForSeconds?: number | null
}
