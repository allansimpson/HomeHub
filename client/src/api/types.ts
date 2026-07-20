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
  freezerWarnAboveCelsius: number
  humidityWarnAbovePercent: number
  activeProfileId: number | null
}

export interface VerifyPinResult {
  success: boolean
  /** Present when the profile is in a lockout cooldown. */
  lockedForSeconds?: number | null
}
