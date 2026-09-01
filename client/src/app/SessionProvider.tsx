import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api, ApiError, SESSION_LOST_EVENT, armSessionLostNotice, setPrivateNetworkConfirmed } from '../api/client'
import { useConnection } from './ConnectionProvider'
import {
  clearIdentity, clearUnlock, loadIdentity, mayAccessPrivateCache, saveIdentity, saveUnlock,
  shouldAskForPin,
} from './sessionTrust'
import type { ProfileDto, SettingsDto } from '../api/types'
import { clearCareOfflineData, closeCareVault, flushCareVault, openCareVault } from '../screens/care/careOffline'
import type { VaultSeal } from '../screens/care/careVault'
import { closeQueueExecution, setQueueIdentity } from './writeQueue'
import { clearEnrolment, enrol, OfflineUnlockError, unlockOffline } from './offlineUnlock'

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
  /**
   * Signed in on this device's own say-so, with the server yet to agree.
   *
   * The panel is fully usable in this state — that is the point of it — but nothing has been sent
   * and nothing has been confirmed, so the surfaces that would mislead read it: the write queue
   * stays shut, and anything sourced from the server is last-known rather than current.
   */
  deviceOnly: boolean
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
 * The seal this session may hold the care records under.
 *
 * One place, because the alternative is each unlock path deciding for itself and one of them
 * eventually writing a PIN-holding profile's log to the device in the clear. A key in hand always
 * seals; without one it comes down to whether there is a secret to seal under at all.
 */
const sealFor = (profile: ProfileDto | null | undefined, key: CryptoKey | null): VaultSeal => {
  if (key) return { kind: 'sealed', key }
  return profile?.hasPin ? { kind: 'memory' } : { kind: 'plaintext' }
}

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
    // Status 0 covers both "no route to the server" and "the identity boundary is still shut" — the
    // device-only case, where the panel is unlocked against the device and nothing has confirmed who
    // this is. Neither is a reason to fail the whole session read: settings are household data the
    // panel can do without until the boundary opens, and treating their absence as fatal is what
    // left it sitting on the picker.
    if (err instanceof ApiError && err.status === 0) return null
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
   * Whether the identity on screen is one this device proved for itself.
   *
   * Tracked rather than inferred from `offline`, because the two come apart in both directions: a
   * device-proved session stays device-proved after the connection returns and until the server has
   * actually confirmed it, and an ordinary signed-in session that loses its connection is not
   * device-proved at all. The write queue's gate reads this, so guessing at it would either strand
   * writes or send them under an identity nobody checked.
   */
  const [deviceOnly, setDeviceOnly] = useState(false)

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

  // Cookie-changing actions are one-at-a-time. Without this, two quick profile choices can both
  // drain the old owner and then race their sign-ins, leaving UI identity and HttpOnly cookie split.
  const sessionTransition = useRef<Promise<void>>(Promise.resolve())
  const duringSessionTransition = useCallback(async <T,>(work: () => Promise<T>): Promise<T> => {
    const previous = sessionTransition.current
    let release!: () => void
    sessionTransition.current = new Promise<void>((resolve) => { release = resolve })
    await previous
    try { return await work() } finally { release() }
  }, [])

  /**
   * The request layer's identity boundary — opened and closed here, and nowhere else.
   *
   * <b>A function rather than a line, because "nowhere else" was the bug.</b> The boundary used to be
   * opened inside {@link refresh}, which reads as one place and is three: a cold boot and a sign-in
   * both establish identity without going through it, and neither opened anything. A panel that
   * rebooted with a valid cookie — the ordinary way this panel starts — refused every private call
   * before the fetch, and because that refusal is deliberately shaped as `ApiError(0)`, drew offline
   * states over a server that was answering. Nothing in the suites could see it; it took a browser.
   *
   * Both arguments are passed rather than read from state on purpose. `locked` is the reason the
   * boundary closes, and a callback closing over a stale copy of it is the other way this goes
   * wrong — quietly, and in the direction of opening.
   *
   * The condition itself is unchanged and is the point: the server has to have said who is signed
   * in. `deviceOnly` is an unlocked panel whose identity nothing has confirmed, and it must not
   * start private calls however plausible its stored profile looks.
   */
  const confirmIdentity = useCallback((isLocked: boolean, profileId: number | null) => {
    setPrivateNetworkConfirmed(!isLocked && profileId != null)
  }, [])

  const refresh = useCallback(async () => {
    try {
      /*
       * <b>Confirmation first, private data second, and never in one `Promise.all`.</b>
       *
       * These three used to be fetched together, which was fine while nothing gated any of them.
       * With the request layer refusing private calls until identity is confirmed it became a
       * deadlock: `/settings` is private, so the batch failed, so identity was never established, so
       * the boundary never opened and the panel sat on the picker saying `0 PROFILES`. It cost me a
       * browser run to see, because every unit test in the suite passed.
       *
       * The ordering is not a workaround for that — it is the requirement stated properly. Confirm
       * who is asking, open the boundary, then fetch the things that needed it open. A batch cannot
       * express that, because the whole point is that one depends on the other.
       */
      const [nextProfiles, session] = await Promise.all([
        api.listProfiles(),
        api.getSession(),
      ])
      setProfiles(nextProfiles)
      setActiveProfileId(session.profileId)
      setQueueIdentity(locked ? null : session.profileId)
      /*
       * The request layer's identity boundary, opened here and nowhere else.
       *
       * This is the only place the server has actually said who is signed in, which is the whole
       * condition: `deviceOnly` is an unlocked panel whose identity nothing has confirmed, and it
       * must not start private calls however plausible its stored profile looks. Locked closes it
       * for the obvious reason.
       *
       * Deliberately *not* also set in the `catch` below — an unreachable server tells us nothing
       * new about identity, and the boundary should stay wherever it was rather than flapping on
       * every failed poll.
       */
      confirmIdentity(locked, session.profileId)

      // Now that the boundary is open — or has stayed shut, in which case this returns null the same
      // way it does for a signed-out panel, and nothing private has been asked for.
      const nextSettings = await settingsOrNullWhenSignedOut()
      setSettings(nextSettings)
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
  }, [locked, confirmIdentity])

  /*
   * Closed the moment the panel locks, before anything else reacts to it.
   *
   * `refresh` above opens the boundary, but it only runs when a read succeeds — so a lock that
   * happens between polls would otherwise leave it open until the next one. Locking is a revocation
   * from the request layer's point of view, and revocations must not wait for a network round trip.
   */
  useEffect(() => {
    if (locked) confirmIdentity(true, null)
  }, [locked, confirmIdentity])

  /*
   * A data call came back 401: the cookie has expired under a panel that thinks it is signed in.
   *
   * <b>Lock, exactly as signing out does.</b> Every provider catches its own `ApiError` and keeps
   * what is on screen — right for a server that is briefly unreachable, wrong here, because nothing
   * is ever coming back. Left alone the panel renders a full shell with an empty pantry, no recipes
   * and no plan, and reads as working. The comment on `signOut` below says what this costs in as
   * many words; it just had no way to happen except by somebody pressing the button.
   *
   * The picker is the fix, so the picker is where this goes.
   */
  useEffect(() => {
    const onLost = () => {
      // Closed, not erased. An expired cookie is a reason to ask for the PIN again; it is not the
      // household saying they are finished with the record, and treating it as one is what used to
      // throw away a night's log because a session timed out. See `careVault.closeCareVault`.
      closeCareVault()
      setQueueIdentity(null)
      setDeviceOnly(false)
      setLocked(true)
    }
    window.addEventListener(SESSION_LOST_EVENT, onLost)
    return () => window.removeEventListener(SESSION_LOST_EVENT, onLost)
  }, [])

  // Initial load. On boot, lock if the active profile opted into a PIN (a rebooted panel
  // should not come up already unlocked into a private profile).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        /*
         * getSession is anonymous and never 401s, so a signed-out panel reaches this branch with
         * profileId null rather than falling into the catch — which is what lets the shell tell
         * "nobody is signed in" from "the server is not there". The roster is anonymous for the
         * same reason: the picker has to be drawable before anybody is on it.
         *
         * <b>Settings are not, and used to be fetched in this same batch.</b> They are private, the
         * boundary is shut until identity is confirmed, and confirming it needs this session — so
         * the settings read was refused on every boot and the panel came up on nulls. That is the
         * same ordering mistake {@link refresh} documents; it was fixed there and not here, which is
         * how a boot with a perfectly good cookie ended up as the broken path. Confirm who is
         * asking, open the boundary, then read the things that needed it open.
         */
        const [nextProfiles, session] = await Promise.all([
          api.listProfiles(),
          api.getSession(),
        ])
        if (cancelled) return
        setProfiles(nextProfiles)
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
        confirmIdentity(nextLocked, session.profileId)
        // Now that the boundary is open — or has stayed shut, in which case this returns null the
        // same way it does for a signed-out panel, and nothing private has been asked for.
        const nextSettings = await settingsOrNullWhenSignedOut()
        if (cancelled) return
        setSettings(nextSettings)
        setQueueIdentity(nextLocked ? null : session.profileId)
        setDeviceOnly(false)
        /*
         * A boot straight into an unlocked session has no PIN in hand — nobody typed one — so it
         * cannot open a sealed blob. `sealFor` names the three ways that can go; the one worth
         * knowing is that a PIN-holding profile which skipped the keypad gets a memory-only session
         * rather than having its records written back in the clear.
         */
        if (mayAccessPrivateCache('server-session', nextLocked) && session.profileId != null) {
          await openCareVault(session.profileId, sealFor(active, null))
        } else {
          closeCareVault()
        }
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
           * server-authenticated identity. The write queue therefore stays shut until a successful
           * session check or sign-in confirms who this is.
           *
           * <b>What is no longer done here is erase the care records.</b> This branch is reached by
           * every launch out of range of the house, and purging on it is what made the offline case
           * hopeless: the log was destroyed on the way to a keypad that could not be answered
           * without the server it had just failed to reach. The blob is sealed, so leaving it costs
           * nothing a locked device did not already concede, and the PIN opens it — see
           * `completeUnlock`, which now falls through to the device when the server is unreachable.
           */
          const held = loadIdentity()
          if (held) {
            setProfiles(held.profiles)
            setActiveProfileId(held.profileId)
          }
          setQueueIdentity(null)
          closeCareVault()
          setLocked(true)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [confirmIdentity])

  /*
   * Get the last care write sealed and stored before the page goes quiet.
   *
   * Sealing is asynchronous — WebCrypto has no other form — so there is a short window in which a
   * change is in memory and not yet on the device. `visibilitychange` is the one that earns this:
   * backgrounding a phone leaves the page alive long enough to finish, and that is the ordinary way
   * this app stops being looked at. `pagehide` is a best effort and frequently is not given the
   * time, which is why the durable half of a logged entry is the write-queue operation rather than
   * this — see `careVault`.
   */
  useEffect(() => {
    const flush = () => { void flushCareVault() }
    document.addEventListener('visibilitychange', flush)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', flush)
      window.removeEventListener('pagehide', flush)
    }
  }, [])

  const completeUnlock = useCallback(async (id: number, pin?: string) => duringSessionTransition(async () => {
    // Close replay before sign-in can replace the cookie. It reopens only after the server confirms
    // the exact profile that now owns the session.
    await closeQueueExecution()
    // `remember: true` — this is the shared wall panel, and a household that has to re-enter a PIN
    // after every power cut takes the PIN off. The cookie is HttpOnly and per-device, so staying
    // signed in costs nothing the panel's physical location does not already cost.
    let session: Awaited<ReturnType<typeof api.signIn>>
    try {
      session = await api.signIn(id, pin, true)
    } catch (err) {
      /*
       * <b>The server could not be asked, so ask the device.</b>
       *
       * Only status 0 — the request layer's word for "the fetch never completed" — comes here. A
       * 401 is a wrong PIN and a real answer from a server that was reached, and falling through to
       * a local check on one of those would let this device overrule a refusal it had just been
       * given.
       *
       * What follows is a full session in every respect the panel cares about, and in exactly one
       * respect it is not: nothing has been sent. `deviceOnly` says so, the write queue stays shut
       * behind it, and the effect below hands the identity to the server the moment there is one to
       * hand it to.
       */
      if (!(err instanceof ApiError) || err.status !== 0) throw err

      const target = profilesRef.current.find((p) => p.id === id) ?? null
      /*
       * A profile with no PIN is admitted with nothing to check, offline as on the panel.
       *
       * It looks like a hole and is not: its rows sign straight in when the server is there, so
       * there is no gate here for an offline path to get around, and no secret to seal its records
       * under either. Refusing it would strand the one profile that never asked to be protected.
       */
      if (!pin) {
        if (target?.hasPin !== false) throw err
        await openCareVault(id, { kind: 'plaintext' })
      } else {
        const opened = await unlockOffline(id, pin)
        if (!opened.ok) throw new OfflineUnlockError(opened)
        await openCareVault(id, { kind: 'sealed', key: opened.key })
      }

      setActiveProfileId(id)
      // Not restored, and not guessed at: `isAdmin` is an authorisation answer and the server is
      // the only thing that may give one. An offline session is an ordinary member's.
      setIsAdmin(false)
      setQueueIdentity(null)
      setDeviceOnly(true)
      setLocked(false)
      setOffline(true)
      saveUnlock({ profileId: id, atMs: Date.now() })
      return
    }

    setQueueIdentity(session.profileId ?? id)
    setActiveProfileId(session.profileId)
    setIsAdmin(session.isAdmin)
    setDeviceOnly(false)
    /*
     * The server has just said who this is, in the most direct way it ever does. Opening here is
     * what lets the two private calls at the end of this function land — `setActiveProfile` and
     * `getSettings` were both being refused, so signing in produced a panel that looked signed in
     * and could read nothing.
     *
     * Not in the offline branch above, and that is the distinction the whole boundary exists for:
     * that path admits somebody against this *device*, and nothing has confirmed them to the house.
     */
    confirmIdentity(false, session.profileId ?? id)
    /*
     * The one moment this device holds a PIN the server has just agreed to — so the one moment it
     * may learn to check that PIN for itself. Enrolling anywhere else would be this device deciding
     * what the right PIN is; enrolling here is it remembering what it was told.
     */
    const active = profilesRef.current.find((p) => p.id === (session.profileId ?? id)) ?? null
    const key = pin ? await enrol(session.profileId ?? id, pin) : null
    await openCareVault(session.profileId ?? id, sealFor(active, key))
    setLocked(false)
    setOffline(false)
    // The panel holds a session again, so the next expiry gets announced rather than swallowed.
    armSessionLostNotice()
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
  }), [duringSessionTransition, confirmIdentity])

  /*
   * Hand a device-proved session to the server the moment there is one to hand it to.
   *
   * <b>This is what finishes the offline round trip, and without it the queue never opens.</b>
   * Somebody unlocked with no connection, wrote three feeds, and the connection came back — the
   * write queue replays only for a profile the server has confirmed, and nothing else was going to
   * ask it. `getSession` is that ask, and it is honest in both directions: if the persistent cookie
   * is still this profile's the panel simply stops being device-only and the queue drains; if it is
   * gone or belongs to somebody else, the panel locks rather than replaying one member's entries
   * under another's session.
   *
   * The vault is left exactly as it is on success. It was opened with the real key when the PIN was
   * proved, so there is nothing here to re-open, and re-opening it would drop whatever has been
   * written since.
   */
  useEffect(() => {
    if (!online || !deviceOnly || locked || activeProfileId == null) return
    let cancelled = false
    ;(async () => {
      try {
        const session = await api.getSession()
        if (cancelled) return
        if (session.signedIn && session.profileId === activeProfileId) {
          setIsAdmin(session.isAdmin)
          setQueueIdentity(activeProfileId)
          setDeviceOnly(false)
          setOffline(false)
          armSessionLostNotice()
          void refresh()
          return
        }
        // The cookie expired while the panel was away, or it belongs to somebody else now. The
        // records stay sealed on the device and the PIN reopens them; what cannot happen is this
        // session's queued writes going out under a session nobody checked.
        closeCareVault()
        setDeviceOnly(false)
        setQueueIdentity(null)
        setLocked(true)
      } catch (err) {
        // Still unreachable — the probe was optimistic, and being wrong about it changes nothing.
        if (!(err instanceof ApiError)) throw err
      }
    })()
    return () => { cancelled = true }
  }, [online, deviceOnly, locked, activeProfileId, refresh])

  const switchProfile = useCallback(
    async (id: number) => {
      const target = profiles.find((p) => p.id === id) ?? null
      if (id !== activeProfileId) {
        // Closed rather than erased, and the vault is per profile — so the member being switched
        // away from keeps their sealed log, and the one being switched to cannot read it.
        closeCareVault()
        setDeviceOnly(false)
        await closeQueueExecution()
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
      closeCareVault()
      setDeviceOnly(false)
      setLocked(true)
    }
  }, [profiles, activeProfileId])

  const signOut = useCallback(async () => duringSessionTransition(async () => {
    await closeQueueExecution()
    /*
     * The one act that erases rather than closes.
     *
     * Both halves go: the sealed records, and the enrolment holding the key that opens them. Either
     * alone would be enough to make the log unreadable, and doing both means a device handed on or
     * put away is not carrying a household's care log in any form — which is the promise the old
     * blanket purge was making everywhere, correctly here and nowhere else.
     */
    clearCareOfflineData()
    clearEnrolment()
    setDeviceOnly(false)
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
  }), [duringSessionTransition])

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
      deviceOnly,
      refresh,
      switchProfile,
      completeUnlock,
      lockNow,
      signOut,
      setCatName,
      setBabyName,
      setLitterFullPercent,
    }),
    [profiles, settings, activeProfileId, activeProfile, isAdmin, locked, loading, offline, deviceOnly, refresh, switchProfile, completeUnlock, lockNow, signOut, setCatName, setBabyName, setLitterFullPercent],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSession(): SessionState {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used within a SessionProvider')
  return ctx
}
