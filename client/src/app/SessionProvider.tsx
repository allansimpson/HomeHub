import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api, ApiError } from '../api/client'
import type { ProfileDto, SettingsDto } from '../api/types'

/**
 * Household session — who this *device* is signed in as, and the lock state the Lock screen and
 * idle logic drive.
 *
 * **This used to read `settings.activeProfileId`** — one value on the server, shared by every
 * device, settable by anyone (AUDIT A1). It answered a display question and was then trusted as
 * the answer to an authorisation one, which it could never be. It is now a per-device session
 * cookie the server mints from a real PIN check, so the panel in the kitchen and the phone in
 * someone's pocket can be different people without overwriting each other.
 *
 * Backend calls still degrade gracefully: if the API is unreachable (no DB / offline), the shell
 * runs with an empty household rather than crashing (offline-first). Signed-out and unreachable
 * are deliberately distinct — one shows the Lock screen, the other shows Reconnecting.
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
  /** True when this member holds the admin role — used to hide controls, never to enforce. */
  isAdmin: boolean
  /** Switch active profile; locks if that profile requires a PIN, otherwise goes straight in. */
  switchProfile: (id: number) => Promise<void>
  /**
   * Sign in as a profile, with its PIN when it has one. Throws an {@link ApiError} with status 401
   * on a wrong PIN — the Lock screen reads `retryAfterSeconds` off the body to show the cooldown.
   */
  completeUnlock: (id: number, pin?: string) => Promise<void>
  /** Force the lock (idle timeout) if the active profile opted into a PIN. */
  lockNow: () => void
  /**
   * Clear the session entirely — the panel drops to the shared/guest state (CONFIG_SCREEN.md §3).
   * Unlike lockNow this always applies, PIN or not; switching profiles happens afterwards.
   */
  signOut: () => Promise<void>
  /**
   * Set (or clear, with null) the household's name for the cat.
   *
   * Lives here rather than in {@link LitterProvider} because it is panel-local: it is the one Litter
   * setting that writes nowhere near Home Assistant and needs no robot round-trip, so it takes effect
   * the instant it is saved rather than when the robot reports it back.
   */
  setCatName: (name: string | null) => Promise<void>
  /** Drawer fullness (%) at which the panel asks for a litter change. Clamped 10–100 server-side. */
  setLitterFullPercent: (percent: number) => Promise<void>
}

const SessionContext = createContext<SessionState | null>(null)

/**
 * Whether signing in as this profile needs a PIN — mirrors what the server enforces.
 *
 * `SessionController.SignIn` requires the PIN of any profile that *has* one, so `hasPin` is the
 * whole condition. It used to read `requirePinWhenIdle && hasPin` here, which quietly meant a
 * profile with a PIN and idle-locking off was signed in with no PIN at all: the client sent none,
 * the server refused, and the panel reported "that PIN is not right" about a PIN it had never
 * asked for.
 */
const needsPinToSignIn = (p: ProfileDto | null | undefined): boolean => !!p && p.hasPin

/**
 * Whether *idling* should drop this profile back to the lock screen — a different question, and the
 * one `requirePinWhenIdle` actually answers. A profile can want its PIN on the way in without
 * wanting the panel to lock itself every few minutes on the kitchen wall.
 */
const requiresPinWhenIdle = (p: ProfileDto | null | undefined): boolean =>
  !!p && p.requirePinWhenIdle && p.hasPin

/**
 * Household settings, or null when this device holds no session yet.
 *
 * AUDIT A1 made `/api/settings` require one, and boot reads it before anybody has signed in — so it
 * answers 401 on every cold start. Inside the `Promise.all` below that rejected the whole batch,
 * taking the *anonymous* calls down with it: `profiles` stayed empty and `locked` was never set, so
 * the panel showed "Reconnecting" over a picker with nobody in it. There was no way forward on the
 * screen, because the only thing that would have fixed it was signing in.
 *
 * Only 401 is swallowed. A 500 (no database) or an unreachable server still rejects, because those
 * really are the reconnecting state and the shell should say so.
 */
const settingsOrNullWhenSignedOut = async (): Promise<SettingsDto | null> => {
  try {
    return await api.getSettings()
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null
    throw err
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [profiles, setProfiles] = useState<ProfileDto[]>([])
  const [settings, setSettings] = useState<SettingsDto | null>(null)
  const [activeProfileId, setActiveProfileId] = useState<number | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [locked, setLocked] = useState(false)
  const [loading, setLoading] = useState(true)
  const [offline, setOffline] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [nextProfiles, nextSettings, session] = await Promise.all([
        api.listProfiles(),
        settingsOrNullWhenSignedOut(),
        api.getSession(),
      ])
      setProfiles(nextProfiles)
      setSettings(nextSettings)
      setActiveProfileId(session.profileId)
      setIsAdmin(session.isAdmin)
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
        // getSession is anonymous and never 401s, so a signed-out panel reaches this branch with
        // profileId null rather than falling into the catch — which is what lets the shell tell
        // "nobody is signed in" from "the server is not there". The roster is anonymous for the
        // same reason: the picker has to be drawable before anybody is on it. Settings are not,
        // hence the wrapper — see it for what a bare getSettings() did here.
        const [nextProfiles, nextSettings, session] = await Promise.all([
          api.listProfiles(),
          settingsOrNullWhenSignedOut(),
          api.getSession(),
        ])
        if (cancelled) return
        setProfiles(nextProfiles)
        setSettings(nextSettings)
        setActiveProfileId(session.profileId)
        setIsAdmin(session.isAdmin)
        // Locked whenever nobody holds a session: a rebooted panel must land on the picker rather
        // than inside whoever used it last. The persistent cookie is what stops that being every
        // reboot — see the `remember` flag on sign-in.
        const active = nextProfiles.find((p) => p.id === session.profileId) ?? null
        // A boot is the idle case, not the sign-in one: the session may already be valid, and what
        // decides whether to demand the PIN again is whether this profile wants re-locking.
        setLocked(!session.signedIn || requiresPinWhenIdle(active))
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

  const completeUnlock = useCallback(async (id: number, pin?: string) => {
    // `remember: true` — this is the shared wall panel, and a household that has to re-enter a PIN
    // after every power cut takes the PIN off. The cookie is HttpOnly and per-device, so staying
    // signed in costs nothing the panel's physical location does not already cost.
    const session = await api.signIn(id, pin, true)
    setActiveProfileId(session.profileId)
    setIsAdmin(session.isAdmin)
    setLocked(false)
    setOffline(false)
    // Best-effort, and after the session already exists: this is the household's shared
    // "whose panel is this" display value, not the thing that authorises anything.
    try {
      await api.setActiveProfile(id)
      // Read, not patched. A panel that booted signed-out has no settings at all — they are not
      // anonymous — and this is the first moment it may have them, so the old
      // `s ? {...s} : s` patch did nothing on the one path that most needed it and left the whole
      // session running on nulls (no daylight boost, no cat name, a Settings screen with nothing
      // in it). Coming after setActiveProfile, what arrives already carries the right one.
      setSettings(await api.getSettings())
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
    }
  }, [])

  const switchProfile = useCallback(
    async (id: number) => {
      const target = profiles.find((p) => p.id === id) ?? null
      // A profile with a PIN is not switched to, it is signed in to — so this only raises the Lock
      // screen and lets completeUnlock do the work. Setting activeProfileId optimistically here
      // would put someone else's name in the corner of a panel that is still locked.
      if (needsPinToSignIn(target)) {
        setLocked(true)
        return
      }
      await completeUnlock(id)
    },
    [profiles, completeUnlock],
  )

  const lockNow = useCallback(() => {
    const active = profiles.find((p) => p.id === activeProfileId) ?? null
    if (requiresPinWhenIdle(active)) setLocked(true)
  }, [profiles, activeProfileId])

  const signOut = useCallback(async () => {
    setActiveProfileId(null)
    setIsAdmin(false)
    setSettings((s) => (s ? { ...s, activeProfileId: null } : s))
    // Locked, not merely signed out: with no session every data call now 401s, so leaving the panel
    // on a dashboard it cannot populate would show a screen of empty states instead of the picker
    // that fixes it.
    setLocked(true)
    try {
      await api.signOutSession()
      await api.setActiveProfile(null)
      setOffline(false)
    } catch (err) {
      if (err instanceof ApiError) setOffline(true)
      else throw err
    }
  }, [])

  const setCatName = useCallback(async (name: string | null) => {
    try {
      setSettings(await api.setCatName(name))
      setOffline(false)
    } catch (err) {
      if (err instanceof ApiError) setOffline(true)
      else throw err
    }
  }, [])

  const setLitterFullPercent = useCallback(async (percent: number) => {
    try {
      setSettings(await api.setLitterFullPercent(percent))
      setOffline(false)
    } catch (err) {
      if (err instanceof ApiError) setOffline(true)
      else throw err
    }
  }, [])

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
      isAdmin,
      locked,
      loading,
      offline,
      refresh,
      switchProfile,
      completeUnlock,
      lockNow,
      signOut,
      setCatName,
      setLitterFullPercent,
    }),
    [profiles, settings, activeProfileId, activeProfile, isAdmin, locked, loading, offline, refresh, switchProfile, completeUnlock, lockNow, signOut, setCatName, setLitterFullPercent],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSession(): SessionState {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used within a SessionProvider')
  return ctx
}
