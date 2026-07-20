import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api, ApiError } from '../api/client'
import type { ProfileDto, SettingsDto } from '../api/types'

/**
 * Household session — the single source of truth for "who is active" and the lock state the
 * Lock screen and idle logic drive. Lock state is derived, not stored on the server: a profile
 * is `locked` when it opted into a PIN and the panel hasn't been unlocked for it this session.
 *
 * Backend calls degrade gracefully: if the API is unreachable (no DB / offline), the shell
 * still runs unlocked with an empty household rather than crashing (offline-first).
 */
interface SessionState {
  profiles: ProfileDto[]
  settings: SettingsDto | null
  activeProfileId: number | null
  activeProfile: ProfileDto | null
  /** True when the Lock/PIN screen must be shown before the panel can be used. */
  locked: boolean
  loading: boolean
  /** True when the last API round-trip failed (reconnecting state). */
  offline: boolean
  /** Reload profiles + settings from the API. */
  refresh: () => Promise<void>
  /** Switch active profile; locks if that profile requires a PIN, otherwise goes straight in. */
  switchProfile: (id: number) => Promise<void>
  /** Finish a successful PIN entry for a profile. */
  completeUnlock: (id: number) => Promise<void>
  /** Force the lock (idle timeout) if the active profile opted into a PIN. */
  lockNow: () => void
}

const SessionContext = createContext<SessionState | null>(null)

const requiresPin = (p: ProfileDto | null | undefined): boolean =>
  !!p && p.requirePinWhenIdle && p.hasPin

export function SessionProvider({ children }: { children: ReactNode }) {
  const [profiles, setProfiles] = useState<ProfileDto[]>([])
  const [settings, setSettings] = useState<SettingsDto | null>(null)
  const [activeProfileId, setActiveProfileId] = useState<number | null>(null)
  const [locked, setLocked] = useState(false)
  const [loading, setLoading] = useState(true)
  const [offline, setOffline] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [nextProfiles, nextSettings] = await Promise.all([api.listProfiles(), api.getSettings()])
      setProfiles(nextProfiles)
      setSettings(nextSettings)
      setActiveProfileId(nextSettings.activeProfileId)
      setOffline(false)
    } catch (err) {
      // Unreachable API (no DB configured / server down) — run the shell unlocked & empty.
      if (err instanceof ApiError) {
        setOffline(true)
      } else {
        throw err
      }
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial load. On boot, lock if the active profile opted into a PIN (a rebooted panel
  // should not come up already unlocked into a private profile).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [nextProfiles, nextSettings] = await Promise.all([api.listProfiles(), api.getSettings()])
        if (cancelled) return
        setProfiles(nextProfiles)
        setSettings(nextSettings)
        setActiveProfileId(nextSettings.activeProfileId)
        const active = nextProfiles.find((p) => p.id === nextSettings.activeProfileId) ?? null
        setLocked(requiresPin(active))
        setOffline(false)
      } catch (err) {
        if (!cancelled && err instanceof ApiError) setOffline(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const switchProfile = useCallback(
    async (id: number) => {
      const target = profiles.find((p) => p.id === id) ?? null
      setActiveProfileId(id)
      setLocked(requiresPin(target))
      try {
        await api.setActiveProfile(id)
        setOffline(false)
      } catch (err) {
        if (err instanceof ApiError) setOffline(true)
        else throw err
      }
    },
    [profiles],
  )

  const completeUnlock = useCallback(async (id: number) => {
    setActiveProfileId(id)
    setLocked(false)
    try {
      await api.setActiveProfile(id)
      setOffline(false)
    } catch (err) {
      if (err instanceof ApiError) setOffline(true)
      else throw err
    }
  }, [])

  const lockNow = useCallback(() => {
    const active = profiles.find((p) => p.id === activeProfileId) ?? null
    if (requiresPin(active)) setLocked(true)
  }, [profiles, activeProfileId])

  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === activeProfileId) ?? null,
    [profiles, activeProfileId],
  )

  const value = useMemo<SessionState>(
    () => ({
      profiles,
      settings,
      activeProfileId,
      activeProfile,
      locked,
      loading,
      offline,
      refresh,
      switchProfile,
      completeUnlock,
      lockNow,
    }),
    [profiles, settings, activeProfileId, activeProfile, locked, loading, offline, refresh, switchProfile, completeUnlock, lockNow],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSession(): SessionState {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used within a SessionProvider')
  return ctx
}
