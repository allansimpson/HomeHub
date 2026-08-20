import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api, ApiError } from '../api/client'
import { useConnection } from './ConnectionProvider'
import {
  clearIdentity, clearUnlock, loadIdentity, mayAccessPrivateCache, saveIdentity, saveUnlock,
  shouldAskForPin,
} from './sessionTrust'
import type { ProfileDto, SettingsDto } from '../api/types'
import { clearCareOfflineData, setCareStorageUnlocked } from '../screens/care/careOffline'
import { setQueueIdentity } from './writeQueue'

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
  /** What the household calls the child; null falls back to the word "Baby". */
  setBabyName: (name: string | null) => Promise<void>
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

/*
 * `requiresPinWhenIdle` lived here and has moved into `sessionTrust.shouldAskForPin`.
 *
 * It answered "does this profile want re-locking", which used to be the whole decision. It is now
 * half of one — the other half being whether this device saw the person prove themselves inside the
 * trusted window — and the boot path and the idle timer both have to reach the same answer. Two
 * copies of that rule is two places for them to drift apart, and the symptom of drifting would be a
 * panel that locks in one situation and not the other for no reason anybody could see.
 */

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
  // Fail closed during the asynchronous boot check. No routed screen or care cache is readable
  // before the server session (or a still-trusted offline identity) establishes who is present.
  const [locked, setLocked] = useState(true)
  const [loading, setLoading] = useState(true)
  const [offline, setOffline] = useState(false)

  /*
   * The connection, read through a ref.
   *
   * `lockNow` is handed to `useIdleReset`, which re-subscribes its listeners whenever the callback
   * changes identity — so taking `online` as a dependency would tear down and rebuild the activity
   * listeners on every probe that flipped. The ref keeps the reading current without that, and the
   * value is only ever read at the instant the idle timer fires.
   */
  const { online } = useConnection()
  const onlineRef = useRef(online)
  onlineRef.current = online

  /*
   * The roster, readable from a callback that must not re-identify when it changes.
   *
   * `completeUnlock` is handed to the Lock screen and needs the roster to remember who this device
   * is — but taking `profiles` as a dependency would rebuild the callback on every read, and the
   * screen holds it across a PIN entry. Read at call time, which is the only time it is wanted.
   */
  const profilesRef = useRef<ProfileDto[]>([])
  profilesRef.current = profiles

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
      setQueueIdentity(locked ? null : session.profileId)
      setIsAdmin(session.isAdmin)
      setOffline(false)
      // Re-remembered on every good read, so a renamed profile or a changed avatar is what the
      // next offline launch draws.
      if (session.profileId != null) saveIdentity(session.profileId, nextProfiles)
    } catch (err) {
      // Unreachable API. The last known identity stays on screen — it was restored at boot and
      // nothing here has learned anything to replace it with.
      if (err instanceof ApiError) {
        setOffline(true)
      } else {
        throw err
      }
    } finally {
      setLoading(false)
    }
  }, [locked])

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
        /*
         * A boot is the idle case, not the sign-in one: the session may already be valid, and what
         * decides whether to demand the PIN again is whether this profile wants re-locking — and,
         * now, whether it proved itself recently enough on this device. Without the second half a
         * PIN was typed on every power cut and every reload, which on a phone is several times an
         * evening, for a profile that had already unlocked minutes earlier. See `sessionTrust.ts`;
         * the window is twelve hours and it is a note about this device, not a credential.
         */
        const nextLocked = !session.signedIn || shouldAskForPin(active)
        setQueueIdentity(nextLocked ? null : session.profileId)
        setCareStorageUnlocked(mayAccessPrivateCache(true, nextLocked))
        if (nextLocked) clearCareOfflineData()
        setLocked(nextLocked)
        setOffline(false)
        // Remembered while there is a server to confirm it, so the next launch without one comes up
        // as this person rather than anonymous.
        if (session.profileId != null) saveIdentity(session.profileId, nextProfiles)
      } catch (err) {
        if (!cancelled && err instanceof ApiError) {
          setOffline(true)
          /*
           * A cached roster may identify the last selected profile, but it cannot prove the current
           * server-authenticated identity. Keep the private cache and write queue closed until a
           * successful online session check or sign-in confirms that identity.
           */
          const held = loadIdentity()
          if (held) {
            setProfiles(held.profiles)
            setActiveProfileId(held.profileId)
          }
          setQueueIdentity(null)
          setCareStorageUnlocked(mayAccessPrivateCache(false, true))
          clearCareOfflineData()
          setLocked(true)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const completeUnlock = useCallback(async (id: number, pin?: string) => {
    // Close replay before sign-in can replace the cookie. It reopens only after the server confirms
    // the exact profile that now owns the session.
    setQueueIdentity(null)
    // `remember: true` — this is the shared wall panel, and a household that has to re-enter a PIN
    // after every power cut takes the PIN off. The cookie is HttpOnly and per-device, so staying
    // signed in costs nothing the panel's physical location does not already cost.
    const session = await api.signIn(id, pin, true)
    setQueueIdentity(session.profileId ?? id)
    setActiveProfileId(session.profileId)
    setIsAdmin(session.isAdmin)
    setCareStorageUnlocked(mayAccessPrivateCache(true, false))
    setLocked(false)
    setOffline(false)
    /*
     * The moment somebody proved who they were, noted for the next twelve hours.
     *
     * Written only here — on the far side of a *successful* server sign-in — so the note can never
     * mean anything the server did not already agree to. It records the time and the profile, and
     * that is all it records: see `sessionTrust.ts` on why it is not a credential.
     */
    saveUnlock({ profileId: id, atMs: Date.now() })
    /*
     * And who this device now is, for the next launch without a server.
     *
     * <b>This was missing, and it is the whole of why an offline launch came up anonymous.</b> The
     * identity was written in one place — the boot read — which only fires when the app starts
     * *already* signed in. The ordinary way anybody arrives at a signed-in panel is this function:
     * install, open, type the PIN. Boot had already run and saved nothing (there was no session
     * yet), signing in saved nothing, and so the first launch offline had nothing to restore.
     *
     * The roster comes from the ref rather than a fresh read: the Lock screen draws its picker from
     * it, so anybody who has just chosen a tile has proved it is populated.
     */
    saveIdentity(session.profileId ?? id, profilesRef.current)
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
      if (id !== activeProfileId) {
        setQueueIdentity(null)
        setCareStorageUnlocked(false)
        clearCareOfflineData()
      }
      // A profile with a PIN is not switched to, it is signed in to — so this only raises the Lock
      // screen and lets completeUnlock do the work. Setting activeProfileId optimistically here
      // would put someone else's name in the corner of a panel that is still locked.
      if (needsPinToSignIn(target)) {
        /*
         * Handing the panel to somebody else ends the trust immediately.
         *
         * The window exists so one person is not re-typing a PIN all evening; it must not become a
         * way past the gate that separates two members. Cleared here rather than in `completeUnlock`
         * because this is the moment the intent is expressed — the unlock that follows writes a
         * fresh note for whoever actually answers.
         */
        clearUnlock()
        setLocked(true)
        return
      }
      await completeUnlock(id)
    },
    [profiles, activeProfileId, completeUnlock],
  )

  /**
   * Lock on idle — but never into a state whose only exit needs a server.
   *
   * <b>Two conditions had to be added, and the second is a real defect being closed.</b> Locking is
   * client-side and instant; unlocking is a round trip to `signIn`, because the PIN is the server's
   * to check. Offline those two disagree: the idle timer would lock a phone that then could not be
   * unlocked at all, and the household would find the care log — the thing most worth having
   * offline — behind a keypad that rejects every correct PIN until the house is back in range.
   * Suspending the lock while unreachable is the version of this that cannot strand anybody, and it
   * concedes little: the PIN protects a shared panel from other people in the house, and a phone
   * already unlocked in somebody's hand is not that.
   *
   * Normal locking resumes on the next good probe. The trusted window is the other condition — a
   * profile that unlocked an hour ago is not asked again for a screen it was just using.
   */
  const lockNow = useCallback(() => {
    if (!onlineRef.current) return
    const active = profiles.find((p) => p.id === activeProfileId) ?? null
    if (shouldAskForPin(active)) {
      setQueueIdentity(null)
      setCareStorageUnlocked(false)
      clearCareOfflineData()
      setLocked(true)
    }
  }, [profiles, activeProfileId])

  const signOut = useCallback(async () => {
    setQueueIdentity(null)
    setCareStorageUnlocked(false)
    clearCareOfflineData()
    setActiveProfileId(null)
    setIsAdmin(false)
    setSettings((s) => (s ? { ...s, activeProfileId: null } : s))
    // Locked, not merely signed out: with no session every data call now 401s, so leaving the panel
    // on a dashboard it cannot populate would show a screen of empty states instead of the picker
    // that fixes it.
    setLocked(true)
    // Signing out is the one act that must mean it everywhere — the trusted window and the
    // remembered identity both go, so the next launch (with a server or without) starts at the
    // picker rather than back inside whoever just left.
    clearUnlock()
    clearIdentity()
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

  const setBabyName = useCallback(async (name: string | null) => {
    try {
      setSettings(await api.setBabyName(name))
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
      setBabyName,
      setLitterFullPercent,
    }),
    [profiles, settings, activeProfileId, activeProfile, isAdmin, locked, loading, offline, refresh, switchProfile, completeUnlock, lockNow, signOut, setCatName, setBabyName, setLitterFullPercent],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSession(): SessionState {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used within a SessionProvider')
  return ctx
}
