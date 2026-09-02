import type { ProfileDto } from '../api/types'

/**
 * How long an unlock is trusted for, and who this device believes it is.
 *
 * <b>Two questions the panel could only answer by asking the server, which is why it asked so
 * often.</b> A PIN was demanded on every boot and after every five idle minutes, and both demands
 * were satisfiable only by a round trip — so a phone away from the house could be locked out of the
 * care log it was carrying, and a phone at home was typing four digits several times an evening for
 * a record nobody else was going to read.
 *
 * PIN recency lives only in this JavaScript lifetime. Browser persistence is caller-controlled and
 * therefore cannot be allowed to suppress a PIN or open an encrypted vault after reload. The
 * HttpOnly cookie remains the only request credential and the server still decides the identity.
 *
 * Pure and apart from the provider so the rules can be tested directly. They decide when a
 * household member is asked for a PIN, and getting them wrong is either a lock-out or a panel that
 * never locks.
 */

const TRUST_KEY = 'homehub.unlock.v1'
const IDENTITY_KEY = 'homehub.identity.v1'
// PIN recency is deliberately tab-memory only. Persisted browser storage is caller-controlled and
// cannot be allowed to decide whether encrypted profile data opens after a reload.
let unlockNote: UnlockNote | null = null

/**
 * Twelve hours, chosen against a night rather than a working day.
 *
 * Long enough that the person doing the 2am feed is not typing a PIN one-handed in the dark having
 * already done so at 8pm, and short enough that the trust does not quietly become permanent — a
 * phone found the next afternoon is asking again. It spans a night and the morning after it, which
 * is the shift this app is actually used across.
 */
export const TRUST_WINDOW_MS = 12 * 60 * 60_000

/**
 * What is entitled to open the private cache right now.
 *
 * <b>`device-pin` is new, and it is the whole of the offline fix.</b> The rule used to be "a
 * currently confirmed server session, or nothing", which was the right rule while the cache was
 * plain text in `localStorage` — anything weaker would have been a check the device could talk
 * itself out of. It is no longer plain text: the records are sealed under a key that only the PIN
 * unwraps (see `offlineUnlock.ts`), so proving the PIN *is* the access. There is nothing left for a
 * server round trip to add to that, and demanding one anyway is what locked the household out of
 * their own log whenever the house was out of range.
 *
 * `server-session` still means what it always did, and remains the only thing that opens the write
 * queue — local access to local data and permission to send are different questions.
 */
export type CacheAuthority = 'server-session' | 'device-pin' | 'none'

/** Private persisted data is readable behind a proved identity and an unlocked screen. */
export function mayAccessPrivateCache(authority: CacheAuthority, locked: boolean): boolean {
  return authority !== 'none' && !locked
}

/** When this tab last saw somebody prove who they were, and which profile it was. */
export interface UnlockNote {
  profileId: number
  /** Epoch ms of the successful unlock. */
  atMs: number
}

export function loadUnlock(): UnlockNote | null {
  return unlockNote
}

export function saveUnlock(note: UnlockNote): void {
  unlockNote = note
  // Remove notes written by older builds so they cannot regain authority after an upgrade.
  remove(TRUST_KEY)
}

/**
 * Forget the unlock. Signing out and switching profile both mean it, and mean it immediately.
 *
 * The one thing the window must never survive is somebody deliberately handing the panel over. That
 * is the whole of the privacy promise `requirePinWhenIdle` makes, and a trusted window that
 * outlived a profile switch would break it in the one situation the household would notice.
 */
export function clearUnlock(): void {
  unlockNote = null
  remove(TRUST_KEY)
}

/**
 * Whether this profile proved itself recently enough to be let straight in.
 *
 * <b>Keyed to the profile, not just the clock.</b> An unlock is a statement about one person; using
 * it to admit a different profile would let a PIN typed by one member open another member's, which
 * is exactly backwards from what the setting is for.
 */
export function withinTrustWindow(
  profileId: number | null | undefined,
  note: UnlockNote | null = loadUnlock(),
  now: number = Date.now(),
): boolean {
  if (profileId == null || !note || note.profileId !== profileId) return false
  const age = now - note.atMs
  // A note from the future is a clock that has been changed — on a device that crosses time zones,
  // or one whose clock was wrong until NTP corrected it. Treated as untrustworthy rather than as
  // infinitely fresh, because the failure mode of the alternative is a window that never closes.
  if (age < 0) return false
  return age < TRUST_WINDOW_MS
}

/**
 * Whether to demand a PIN for this profile right now.
 *
 * The single rule, in one place, so the boot path and the idle timer cannot disagree about it —
 * they did not before, because only one of them existed.
 */
export function shouldAskForPin(
  profile: ProfileDto | null | undefined,
  now: number = Date.now(),
): boolean {
  // A profile with no PIN, or one that never opted into re-locking, is never asked. Unchanged.
  if (!profile || !profile.requirePinWhenIdle || !profile.hasPin) return false
  return !withinTrustWindow(profile.id, loadUnlock(), now)
}

/**
 * Whether an idle timeout locks the panel. <b>Connectivity is deliberately not a term.</b>
 *
 * The `online` argument is taken and ignored, and that is the whole reason this function exists
 * rather than the call site simply asking {@link shouldAskForPin}. `SessionProvider.lockNow` used to
 * begin `if (!onlineRef.current) return`, and an absence is not something a test can hold on to — so
 * the removed condition is written here as an explicit non-condition, where a future edit that
 * reintroduces it fails rather than passes.
 *
 * <b>Why it was there, and why it is wrong.</b> Locking is client-side and instant; unlocking was a
 * round trip to `signIn`, because the PIN is the server's to check. Offline those two disagreed, and
 * the idle timer would lock a panel that could not then be unlocked at all. Suspending the lock was
 * the version of that which could not strand anybody.
 *
 * What it also was: a way to switch the household's own privacy setting off from outside. Pull the
 * router, wait, and a shared wall panel sits indefinitely on a decrypted care log — at the moment it
 * is least attended. Connectivity is not consent, and a lock a passer-by can suspend is not a lock.
 *
 * The premise is gone in any case. `offlineUnlock` teaches this device to check the PIN for itself on
 * the far side of one successful online sign-in, and `completeUnlock` falls through to it when the
 * server cannot be reached, so an offline lock is answerable by the person who knows the four digits.
 * A profile never enrolled on this device cannot open it until the house is back in range, which is
 * the fail-closed direction and is what the Lock screen's `unavailable` state says out loud.
 */
export function locksWhenIdle(
  profile: ProfileDto | null | undefined,
  // Underscored so the compiler accepts a parameter that is deliberately unread. The name is kept in
  // the signature because the argument the caller passes is the point.
  _online: boolean,
  now: number = Date.now(),
): boolean {
  return shouldAskForPin(profile, now)
}

// ---- who this device is, when there is no server to ask ----

/**
 * The last identity the server confirmed, kept so an offline launch is not anonymous.
 *
 * <b>Identity, deliberately not privilege.</b> `isAdmin` is not here and is not restored: it is an
 * authorisation answer, and the one place that may give it is the server. An offline panel comes up
 * as the right person with the ordinary set of screens; the administrative ones need a connection,
 * which is honest, since everything behind them is server data anyway.
 */
export interface DeviceIdentity {
  profileId: number
  /** The roster as last seen, so the picker and the name in the corner are drawable with no server. */
  profiles: ProfileDto[]
  savedAtMs: number
}

export function loadIdentity(): DeviceIdentity | null {
  const held = readJson<DeviceIdentity>(IDENTITY_KEY)
  // A stored shape from an older build, or a truncated write. Nothing here is worth half-reading.
  if (!held || typeof held.profileId !== 'number' || !Array.isArray(held.profiles)) return null
  return held
}

export function saveIdentity(profileId: number, profiles: ProfileDto[]): void {
  writeJson(IDENTITY_KEY, { profileId, profiles, savedAtMs: Date.now() } satisfies DeviceIdentity)
}

export function clearIdentity(): void {
  remove(IDENTITY_KEY)
}

// ---- storage plumbing ----

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    // A disabled or corrupt store costs the household a PIN prompt, which is the safe direction to
    // fail in: it asks more often, never less.
    return null
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* best effort — see above */
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    /* best effort */
  }
}
