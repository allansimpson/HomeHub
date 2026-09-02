import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api, ApiError, SESSION_LOST_EVENT, armSessionLostNotice, setPrivateNetworkConfirmed } from '../api/client'
import { closeAndDrainPrivateNetwork } from '../api/privateNetwork'
import { useConnection } from './ConnectionProvider'
import {
  clearIdentity, clearUnlock, loadIdentity, locksWhenIdle, mayAccessPrivateCache, saveIdentity,
  saveUnlock, shouldAskForPin,
} from './sessionTrust'
import type { ProfileDto, SettingsDto } from '../api/types'
import { clearCareOfflineData, flushCareVault, openCareVault } from '../screens/care/careOffline'
import { closeQueueExecution, setQueueIdentity } from './writeQueue'
import { createSessionBoundary } from './sessionBoundary'
import { clearQueueStore, flushQueueStore, openQueueStore, sweepLegacyPlaintext } from './queueStore'
import { closePrivateStores, endSessionAuthority } from './sessionAuthority'
import { clearDeviceKeys, deviceKeyFor } from './deviceKey'
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
   * This device could not remove a previous build's plaintext care records, so nothing private is
   * being written to it durably this session.
   *
   * <b>Surfaced rather than handled silently.</b> The household loses offline durability — the care
   * log works for the life of the page and starts empty after a reload — and that is a visible change
   * they are owed an explanation for. The cause is a browser store that refused a write, a removal
   * and a read-back: a full disk, a locked-down profile, private browsing in some browsers.
   */
  storageUntrusted: boolean
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
 * The key this session may seal its private records under, or null for a session that writes none.
 *
 * One place, because the alternative is each unlock path deciding for itself and one of them
 * eventually writing a PIN-holding profile's log to the device in the clear — which is exactly what
 * happened, in the one branch nobody looked at twice.
 *
 * Three answers, in the order they are asked:
 *
 * <b>A PIN was proved</b>, so its unwrapped data key is in hand and everything is sealed under it.
 * That is the strong case and nothing here weakens it.
 *
 * <b>The profile has a PIN and this session did not type it</b> — a cold boot into a live cookie with
 * `requirePinWhenIdle` off. No key, and the device key must not be substituted: it would seal a
 * member's records under something their PIN is not needed to open, which is the PIN boundary being
 * quietly moved rather than honoured. The session remembers in memory and writes nothing down.
 *
 * <b>The profile has no PIN.</b> This used to be the plaintext case, on the reasoning that there was
 * no secret to seal under. The reasoning was wrong: `./deviceKey` mints a non-extractable key this
 * device can use and cannot export, and "nobody set a PIN" was a decision about who may *use* the
 * panel, never about whether the household's care record may be read out of a browser store by
 * whoever picks the device up. Null only when the browser cannot hold a key at all, and then the
 * session is memory-only — never plaintext.
 */
const keyFor = async (
  profile: ProfileDto | null | undefined,
  profileId: number,
  provenKey: CryptoKey | null,
): Promise<CryptoKey | null> => {
  if (provenKey) return provenKey
  if (profile?.hasPin) return null
  return deviceKeyFor(profileId)
}

/**
 * Open both durable private stores for this profile, under one key.
 *
 * <b>One key and one call, because two protection levels is a hole with extra steps.</b> The care
 * vault and the write queue hold the same rows — the log the household reads, and the operations
 * carrying those rows to the server — so sealing one and not the other protects nothing. They were
 * separate for exactly as long as it took for the queue to be the one left in the clear.
 */
const openPrivateStores = async (profileId: number, key: CryptoKey | null): Promise<void> => {
  await openCareVault(profileId, key ? { kind: 'sealed', key } : { kind: 'memory' })
  await openQueueStore(profileId, key)
}

/**
 * The key this session may use, given what the device has proved it can do.
 *
 * <b>A device that cannot delete plaintext does not get durable private storage.</b> If the boot
 * sweep could not remove a previous build's care records — the store refused a write and a removal,
 * or would not read back — then this panel has demonstrated that what it is given, it keeps. Handing
 * it more private data to seal would be adding to a pile nothing can clear, on the strength of an
 * encryption promise made by the same storage layer that just failed.
 *
 * Memory-only rather than refusing the session outright: the household still gets their care log for
 * the life of the page, which is the thing the offline work exists to protect, and they lose only
 * durability. The panel says so — `storageUntrusted` on the session — rather than degrading silently.
 */
const durableKeyFor = (key: CryptoKey | null, sweptClean: boolean): CryptoKey | null =>
  sweptClean ? key : null

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
   * Whether this device could actually remove a previous build's plaintext care records.
   *
   * Starts true because the boot sweep has not run yet and a panel with nothing to sweep is the
   * ordinary case; the sweep sets it, synchronously, before anything else in boot happens. False is a
   * device that has told us it cannot delete — a disabled or full store, a `SecurityError` — and the
   * only honest response to that is to stop adding to what it cannot clean.
   */
  const [plaintextSwept, setPlaintextSwept] = useState(true)
  // Read from callbacks that must not re-identify when it changes, and read at the only moment it
  // matters — the instant a store is about to be opened. Same reason `profilesRef` exists.
  const plaintextSweptRef = useRef(true)
  plaintextSweptRef.current = plaintextSwept

  /*
   * The connection.
   *
   * <b>Read through a ref until recently, and no longer.</b> The ref existed so `lockNow` could
   * consult connectivity without taking it as a dependency — `useIdleReset` re-subscribes its
   * activity listeners whenever that callback changes identity, so a value that flips on every probe
   * would have rebuilt them constantly. `lockNow` does not consult it any more (see the note there on
   * why an offline panel must still lock), so the ref has nothing left to keep current.
   */
  const { online } = useConnection()

  /*
   * The roster, readable from a callback that must not re-identify when it changes.
   *
   * `completeUnlock` is handed to the Lock screen and needs the roster to remember who this device
   * is — but taking `profiles` as a dependency would rebuild the callback on every read, and the
   * screen holds it across a PIN entry. Read at call time, which is the only time it is wanted.
   */
  const profilesRef = useRef<ProfileDto[]>([])
  profilesRef.current = profiles

  /*
   * Which identity boundary the panel is on. The rule, and why it is a counter, is in
   * `sessionBoundary.ts`; what is here is the wiring.
   *
   * A ref rather than state, and deliberately: this has to be readable and writable inside a callback
   * that must not re-identify, and it has to change *now* rather than at the next render.
   */
  const boundary = useRef(createSessionBoundary())
  const beginTransition = useCallback((): number => boundary.current.begin(), [])
  /** Whether the flow that started in this generation may still act. */
  const stillCurrent = useCallback((began: number): boolean => boundary.current.holds(began), [])

  /*
   * A transition on the way out.
   *
   * Unmounting is the one boundary change with no successor to supersede a stale completion, so it
   * takes a number of its own. Without it, a session read still in flight when the provider goes away
   * resumes into `setState` calls on a dead tree — and, worse, into a `confirmIdentity` that would
   * reopen the request layer's boundary with nothing left to close it again.
   */
  const closing = useRef(boundary.current)
  useEffect(() => () => { closing.current.begin() }, [])

  // Cookie-changing actions are one-at-a-time. Without this, two quick profile choices can both
  // drain the old owner and then race their sign-ins, leaving UI identity and HttpOnly cookie split.
  const sessionTransition = useRef<Promise<void>>(Promise.resolve())
  const duringSessionTransition = useCallback(async <T,>(work: () => Promise<T>): Promise<T> => {
    // Numbered before anything is awaited. A refresh that is mid-flight right now is already stale by
    // the time this function's first `await` yields, which is the whole point of doing it here.
    beginTransition()
    const previous = sessionTransition.current
    let release!: () => void
    sessionTransition.current = new Promise<void>((resolve) => { release = resolve })
    await previous
    /*
     * Shut the boundary and drain what is in flight before the transition touches the cookie.
     *
     * Every session transition passes through here — sign-in, sign-out, unlock, profile switch — so
     * this is the one place that can promise no authenticated request is still running when the
     * identity changes underneath it. Closing first stops anything new starting; aborting deals with
     * what is already out; awaiting is the part that matters, because `abort()` returns before the
     * request's own unwinding has happened, and a transition that proceeds into that gap is racing
     * the teardown it just asked for.
     *
     * Sign-in still works with the boundary shut: `POST /session` is one of the four operations that
     * may precede confirmation, which is what makes it able to re-open it.
     */
    await closeAndDrainPrivateNetwork()
    try { return await work() } finally { release() }
  }, [beginTransition])

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
    // The profile is passed through so the boundary knows *who* it is open for, not merely that it
    // is open. A request captures that subject and its epoch when it starts and is checked against
    // them when it finishes, so a reply that outlived its identity is discarded rather than rendered.
    setPrivateNetworkConfirmed(!isLocked && profileId != null, profileId)
  }, [])

  const refresh = useCallback(async () => {
    /*
     * The boundary this read belongs to, taken before the first request goes out.
     *
     * Every `setState` and every `confirmIdentity` below is guarded on it still holding. `locked` is
     * captured in the same breath and is *not* enough on its own: it is a value from the render this
     * callback was built in, so a lock that happens while the reads are in flight leaves it saying
     * `false` — which is precisely how a revoked session was reopened by a refresh that started
     * before the revocation.
     */
    const began = boundary.current.current()
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
      const [pickerProfiles, session] = await Promise.all([
        api.listProfilePicker(),
        api.getSession(),
      ])
      /*
       * The boundary moved while this read was in flight, so this read has nothing to say about it.
       *
       * Abandoned entirely rather than partially applied: the roster looks harmless and is not, because
       * `saveIdentity` below would then record whoever this read found as the device's remembered
       * member — which is the identity the next offline launch comes up as.
       */
      if (!stillCurrent(began)) return
      setProfiles(pickerProfiles)
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

      /*
       * Now that the boundary is open — or has stayed shut, in which case these return null and
       * nothing private has been asked for.
       *
       * The roster is read twice on purpose, and the two reads are different endpoints rather than
       * the same one twice. The picker's version is anonymous and carries four fields; the full shape
       * carries the household's security policy — who is an administrator, who locks when idle — and
       * is authenticated. Before confirmation the panel is entitled to the first and not the second,
       * so it takes the first, confirms, and then upgrades.
       */
      const [nextSettings, fullProfiles] = await Promise.all([
        settingsOrNullWhenSignedOut(),
        api.listProfiles().catch(() => null),
      ])
      // Checked again: these two are private reads, so the window they open is a second one.
      if (!stillCurrent(began)) return
      setSettings(nextSettings)
      // Only on success: a refusal must not blank a roster the picker is drawing from.
      // Same reason as the boot path: truthiness is not a shape check.
      if (Array.isArray(fullProfiles)) setProfiles(fullProfiles)
      setIsAdmin(session.isAdmin)
      setOffline(false)
      // Re-remembered on every good read, so a renamed profile or a changed avatar is what the
      // next offline launch draws.
      if (session.profileId != null) saveIdentity(session.profileId, pickerProfiles)
    } catch (err) {
      // Unreachable API. The last known identity stays on screen — it was restored at boot and
      // nothing here has learned anything to replace it with.
      if (!stillCurrent(began)) return
      if (err instanceof ApiError) {
        setOffline(true)
      } else {
        throw err
      }
    } finally {
      // Not guarded: this only ever takes the boot spinner down, and a superseded read leaving the
      // panel on it for ever would be a worse failure than the one the guard is for.
      setLoading(false)
    }
  }, [locked, confirmIdentity, stillCurrent])

  /*
   * Closed the moment the panel locks, before anything else reacts to it.
   *
   * `refresh` above opens the boundary, but it only runs when a read succeeds — so a lock that
   * happens between polls would otherwise leave it open until the next one. Locking is a revocation
   * from the request layer's point of view, and revocations must not wait for a network round trip.
   */
  useEffect(() => {
    /*
     * A backstop now rather than the mechanism.
     *
     * `lockNow` and the session-loss handler used to rely on this effect to close the request layer,
     * which meant authority outlived the transition by however long React took to commit. They close
     * it themselves now (`endSessionAuthority`). What is left here covers the paths that set `locked`
     * without going through either — the boot read deciding a PIN is owed, and a profile switch
     * raising the Lock screen — where nothing is in flight to outlive anything, and closing twice is
     * free because the epoch only ever advances.
     */
    if (locked) void closeAndDrainPrivateNetwork()
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
      // A revocation, so it takes a number before it touches anything: a session read already in
      // flight must not finish and re-confirm the identity the server has just refused.
      beginTransition()
      /*
       * The same order as `lockNow`, and for the same reason: a lost session is a revocation, so
       * admission shuts and everything in flight is aborted here rather than whenever React next
       * commits. Closed, not erased — an expired cookie is a reason to ask for the PIN again; it is
       * not the household saying they are finished with the record, and treating it as one is what
       * used to throw away a night's log because a session timed out. See `careVault.closeCareVault`.
       */
      void endSessionAuthority()
      setDeviceOnly(false)
      setLocked(true)
    }
    window.addEventListener(SESSION_LOST_EVENT, onLost)
    return () => window.removeEventListener(SESSION_LOST_EVENT, onLost)
  }, [beginTransition])

  // Initial load. On boot, lock if the active profile opted into a PIN (a rebooted panel
  // should not come up already unlocked into a private profile).
  useEffect(() => {
    let cancelled = false
    /*
     * Before anything else, and before anybody is asked for a PIN.
     *
     * A previous build's plaintext queue can hold any member's care record, and the sweep used to run
     * only when that member's own store was opened — so a panel that boots locked, or opens somebody
     * else, left it readable in shared `localStorage` for as long as that lasted, which on a wall
     * panel is indefinitely. It has nothing to do with who is signing in, so it does not wait to find
     * out. Synchronous, unconditional, and idempotent.
     *
     * <b>And its answer is acted on.</b> The first version called this and dropped the result on the
     * floor, which made the return value decoration: the function could report honestly that it had
     * failed to delete a care record and the panel would carry on as though privacy held. When it says
     * false the device has demonstrated it cannot let go of plaintext, so this session is not given
     * durable private storage — see `sealsAreTrustworthy` below.
     */
    const sweptClean = sweepLegacyPlaintext()
    // The ref first and synchronously: everything below this line runs before React re-renders, and
    // the store opens in this same flow read the ref rather than the state.
    plaintextSweptRef.current = sweptClean
    setPlaintextSwept(sweptClean)
    // The boot read is an asynchronous flow like any other, so it is bound the same way. `cancelled`
    // covers unmount; this covers a lock, a sign-in or a revocation landing while it is still reading.
    const began = boundary.current.current()
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
          // The anonymous four-field shape. The full roster is authenticated and arrives below.
          api.listProfilePicker(),
          api.getSession(),
        ])
        if (cancelled || !stillCurrent(began)) return
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
        const [nextSettings, fullProfiles] = await Promise.all([
          settingsOrNullWhenSignedOut(),
          // Upgrades the picker's four fields to the full roster now that the boundary is open. A
          // refusal leaves the picker's version standing rather than blanking it.
          api.listProfiles().catch(() => null),
        ])
        if (cancelled || !stillCurrent(began)) return
        setSettings(nextSettings)
        // `Array.isArray`, not truthiness: `catch(() => null)` guards a refusal, but a malformed or
        // unexpected body is truthy and would replace the roster with something that has no `.find`,
        // which white-screens the panel. The picker's list stays standing instead.
        if (Array.isArray(fullProfiles)) setProfiles(fullProfiles)
        setQueueIdentity(nextLocked ? null : session.profileId)
        setDeviceOnly(false)
        /*
         * A boot straight into an unlocked session has no PIN in hand — nobody typed one — so it
         * cannot open a blob sealed under one. `keyFor` names the three ways that can go; the one
         * worth knowing is that a PIN-holding profile which skipped the keypad gets a memory-only
         * session rather than having its records written back in the clear.
         */
        if (mayAccessPrivateCache('server-session', nextLocked) && session.profileId != null) {
          const key = await keyFor(active, session.profileId, null)
          // Opening a store is handing this session the household's records, so the boundary is
          // re-checked on the far side of the key lookup — which touches IndexedDB and can await.
          if (cancelled || !stillCurrent(began)) return
          await openPrivateStores(session.profileId, durableKeyFor(key, plaintextSweptRef.current))
        } else {
          closePrivateStores()
        }
        setLocked(nextLocked)
        setOffline(false)
        // Remembered while there is a server to confirm it, so the next launch without one comes up
        // as this person rather than anonymous.
        if (session.profileId != null) saveIdentity(session.profileId, nextProfiles)
      } catch (err) {
        if (!cancelled && stillCurrent(began) && err instanceof ApiError) {
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
          closePrivateStores()
          setLocked(true)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [confirmIdentity, stillCurrent])

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
    // Both stores, because both are sealed now and both have the same window between a change being
    // in memory and being on the device. The queue is the more important of the two: it is what
    // actually reaches the server, and `careVault` names it as the durable half of a logged entry.
    const flush = () => { void flushCareVault(); void flushQueueStore().catch(() => undefined) }
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
       * there is no gate here for an offline path to get around. What it no longer implies is that
       * there is nothing to seal the records under — this used to open the vault in the clear on that
       * reasoning, and `keyFor` says at length why the device key is the right answer instead.
       * Refusing the profile outright would strand the one member who never asked to be protected.
       */
      if (!pin) {
        if (target?.hasPin !== false) throw err
        await openPrivateStores(id, durableKeyFor(await keyFor(target, id, null), plaintextSweptRef.current))
      } else {
        const opened = await unlockOffline(id, pin)
        if (!opened.ok) throw new OfflineUnlockError(opened)
        await openPrivateStores(id, durableKeyFor(opened.key, plaintextSweptRef.current))
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
    const signedInAs = session.profileId ?? id
    const active = profilesRef.current.find((p) => p.id === signedInAs) ?? null
    const proven = pin ? await enrol(signedInAs, pin) : null
    await openPrivateStores(
      signedInAs, durableKeyFor(await keyFor(active, signedInAs, proven), plaintextSweptRef.current))
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
    /*
     * Bound like every other asynchronous flow, and this one is the sharpest case for it.
     *
     * What it does on success is promote a device-proved session to a server-confirmed one, which
     * opens the write queue and the request boundary. A lock or a sign-out landing while the probe is
     * in flight must not be undone by the probe's answer arriving afterwards — that is precisely a
     * closed boundary being reopened from obsolete state.
     */
    const began = boundary.current.current()
    ;(async () => {
      try {
        const session = await api.getSession()
        if (cancelled || !stillCurrent(began)) return
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
        beginTransition()
        // A revocation like any other, so it ends authority the same way — synchronously, and with
        // the stores closed only once what was in flight has settled.
        await endSessionAuthority()
        setDeviceOnly(false)
        setLocked(true)
      } catch (err) {
        // Still unreachable — the probe was optimistic, and being wrong about it changes nothing.
        if (!(err instanceof ApiError)) throw err
      }
    })()
    return () => { cancelled = true }
  }, [online, deviceOnly, locked, activeProfileId, refresh, stillCurrent, beginTransition])

  const switchProfile = useCallback(
    async (id: number) => {
      const target = profiles.find((p) => p.id === id) ?? null
      if (id !== activeProfileId) {
        // Closed rather than erased, and both stores are per profile — so the member being switched
        // away from keeps their sealed log and their queued writes, and the one being switched to
        // can read neither.
        beginTransition()
        // Awaited here, unlike the lock: a switch has somewhere to go next, and the member being
        // switched to must not arrive while the previous one's operations are still settling.
        await endSessionAuthority()
        setDeviceOnly(false)
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
    [profiles, activeProfileId, completeUnlock, beginTransition],
  )

  /**
   * Lock on idle. <b>Whether or not there is a server.</b>
   *
   * <b>This used to return without locking whenever the panel was offline, and that was the
   * defect.</b> The reasoning was sound when it was written and had been overtaken: locking is
   * client-side and instant, unlocking was a round trip to `signIn` because the PIN is the server's to
   * check, so an idle timeout with no connection would strand somebody behind a keypad that rejects
   * every correct PIN. Suspending the lock was the version that could not strand anybody.
   *
   * What it also was, once `requirePinWhenIdle` is read as the privacy control it is: a way to switch
   * the lock off from outside. Pull the router, wait, and a shared wall panel sits indefinitely on a
   * decrypted care log — the household's own setting quietly not in force at the moment the panel is
   * least attended. Connectivity is not consent.
   *
   * The premise is gone in any case. `offlineUnlock` teaches this device to check the PIN for itself
   * on the far side of one successful online sign-in, and `completeUnlock` falls through to it when
   * the server cannot be reached — so an offline lock is answerable by the person who knows the four
   * digits, which is exactly who it is meant to be answerable by.
   *
   * <b>What is fail-closed here, stated rather than implied.</b> A profile that has never signed in
   * with its PIN on this device is not enrolled, so an offline lock cannot be opened until the house
   * is back in range. That is the correct direction — the alternative is a lock that this device may
   * decide for itself to skip — and the Lock screen says so in those words rather than reporting a
   * wrong PIN (see `OfflineUnlockFailure.not-enrolled`).
   *
   * The trusted window is the remaining condition: a profile that unlocked an hour ago is not asked
   * again for a screen it was just using.
   */
  const lockNow = useCallback(() => {
    const active = profiles.find((p) => p.id === activeProfileId) ?? null
    // Through `locksWhenIdle` rather than `shouldAskForPin` directly: it takes the connection reading
    // and ignores it on purpose, so the condition removed from here is a stated non-condition with a
    // test on it rather than an absence nothing can hold on to.
    if (locksWhenIdle(active, online)) {
      // A lock is a revocation, so it takes a number before it does anything else — a session read in
      // flight must not complete afterwards and reopen what this just shut.
      beginTransition()
      // Authority ends on this line, not at the next render. `endSessionAuthority` shuts admission and
      // aborts synchronously; the promise is the drain, and the stores close on the far side of it.
      void endSessionAuthority()
      setDeviceOnly(false)
      setLocked(true)
    }
  }, [profiles, activeProfileId, online, beginTransition])

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
    clearQueueStore()
    clearEnrolment()
    // The third half of the same secret. A no-PIN profile's records are sealed under the device key
    // rather than an enrolment, so leaving it behind would be leaving the only thing that opens them.
    void clearDeviceKeys()
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
      storageUntrusted: !plaintextSwept,
      refresh,
      switchProfile,
      completeUnlock,
      lockNow,
      signOut,
      setCatName,
      setBabyName,
      setLitterFullPercent,
    }),
    [profiles, settings, activeProfileId, activeProfile, isAdmin, locked, loading, offline, deviceOnly, plaintextSwept, refresh, switchProfile, completeUnlock, lockNow, signOut, setCatName, setBabyName, setLitterFullPercent],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSession(): SessionState {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used within a SessionProvider')
  return ctx
}
