/**
 * Proving who you are with no server to ask.
 *
 * <b>The gap this closes.</b> A PIN is checked by `SessionController.SignIn`, and the hash lives on
 * the server — `ProfileDto` reports only `hasPin`. So a panel that could not reach the house could
 * not let anybody in, and the boot path met that by locking and purging the care cache. The result
 * was the one failure the offline work exists to prevent: the app opens at 3am, away from the
 * house, and there is no way past the keypad to the log somebody is standing there to write.
 *
 * <b>What is stored here, and what is not.</b> Not the PIN, and not a hash of it that could be
 * compared. What this device keeps is a random data key — the one the care cache is encrypted with
 * — wrapped under a key derived from the PIN. Typing the right four digits unwraps it; typing the
 * wrong four produces a key that fails AES-GCM's authentication tag, and the unwrap simply does not
 * come out. The verifier and the thing being protected are therefore the same object, which is what
 * keeps this from being a padlock bolted to a plaintext box.
 *
 * <b>What it does not buy.</b> A four-digit PIN is ten thousand candidates. Someone who takes the
 * device, reads `localStorage` and runs the KDF themselves will get through it — the iteration
 * count sets the price, not the outcome, and the attempt lockout below only binds an attacker who
 * comes through this module. The honest claim is narrower than "encrypted" and worth stating
 * plainly: the care cache is no longer sitting in plain text in a browser store, and casual
 * inspection of the device does not read it. That is a real improvement on purging it — which
 * protected the data by destroying the feature — and it is not a vault.
 *
 * Nothing here needs the server, and nothing here is a credential the server would recognise. The
 * HttpOnly cookie remains the only thing that authorises a request; this decides local access to
 * local data, and the queue stays shut until the server has confirmed the identity itself.
 */

const KEY = 'homehub.offlineunlock.v1'

/**
 * PBKDF2 rounds. 310,000 with SHA-256 is OWASP's current figure, and on the slowest thing this runs
 * on it costs a few hundred milliseconds once, at the moment somebody is already typing.
 */
const ITERATIONS = 310_000

/** Failures tolerated before the keypad is made to wait. */
const FREE_ATTEMPTS = 5

/** First cooldown, doubling per failure after it. */
const FIRST_COOLDOWN_MS = 30_000

/** Beyond this a longer wait deters nobody who is still trying and strands somebody who is not. */
const MAX_COOLDOWN_MS = 15 * 60_000

interface UnlockStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * What this device remembers about one profile's PIN.
 *
 * Per profile, because two members share a panel and the whole point of the PIN is the line between
 * them. Nothing in here identifies which PIN it is for beyond the profile id, and none of it is
 * usable without the four digits.
 */
interface Enrolment {
  v: 1
  /** Base64. Random per enrolment, so the same PIN on two devices derives two different keys. */
  salt: string
  iv: string
  /** Base64. The cache's data key, AES-GCM encrypted under the PIN-derived key. */
  wrapped: string
  iterations: number
  /** Consecutive failed offline attempts. Persisted, so a reload is not a way around the wait. */
  failed: number
  /** Epoch ms the keypad reopens, or null. */
  lockedUntilMs: number | null
  savedAtMs: number
}

type Enrolments = Record<string, Enrolment>

/** Why an offline unlock did not open. Each needs different words on the Lock screen. */
export type OfflineUnlockFailure =
  /** This device has never seen this profile sign in with its PIN, so there is nothing to check. */
  | { kind: 'not-enrolled' }
  /** The four digits did not unwrap the key. */
  | { kind: 'wrong-pin' }
  /** Too many wrong ones; the keypad is waiting. */
  | { kind: 'locked-out'; retryAfterSeconds: number }

export type OfflineUnlockResult =
  | { ok: true; key: CryptoKey }
  | ({ ok: false } & OfflineUnlockFailure)

/**
 * Thrown by the session's unlock when the device could not admit somebody either.
 *
 * <b>Deliberately not an `ApiError`.</b> The Lock screen reads a 401 as "those digits are wrong"
 * and anything else as "the server could not be reached", and neither sentence is true here — the
 * server was never asked. Carrying the failure as its own type is what lets that screen say the one
 * thing a person standing in front of it can act on, which for `not-enrolled` is that no amount of
 * retyping will help until the house is back in range.
 */
export class OfflineUnlockError extends Error {
  readonly failure: OfflineUnlockFailure

  constructor(failure: OfflineUnlockFailure) {
    super(`Offline unlock refused: ${failure.kind}`)
    this.name = 'OfflineUnlockError'
    this.failure = failure
  }
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto
  if (!c?.subtle) {
    // Secure-context-only API. A panel served over plain HTTP has no `subtle` at all, and the right
    // answer is to have no enrolment rather than a half-working one — see `isAvailable`.
    throw new Error('WebCrypto is unavailable; offline unlock cannot be used here.')
  }
  return c.subtle
}

/**
 * Whether this browser can do any of it.
 *
 * Callers use it to decide whether to *offer* an offline unlock, rather than discovering mid-typing
 * that the four digits can never be checked. `crypto.subtle` is secure-context-only, so a panel
 * reached over plain HTTP lands here.
 */
export function isOfflineUnlockAvailable(): boolean {
  return !!globalThis.crypto?.subtle
}

/** Whether this device could check this profile's PIN without a server. */
export function isEnrolled(profileId: number, storage: UnlockStorage = localStorage): boolean {
  return readAll(storage)[String(profileId)] != null
}

/**
 * Remember this profile's PIN well enough to check it later, and hand back the cache's data key.
 *
 * <b>Called only on the far side of a successful *online* sign-in</b>, which is the one moment the
 * device holds a PIN the server has just agreed to. Enrolling anywhere else would let this device
 * decide for itself what the right PIN is.
 *
 * Re-enrolling with the PIN already held changes nothing and returns the same key — see below for
 * why that matters. A PIN changed on another device does not open it, so the enrolment is replaced
 * and the records sealed under the old one are left behind. Until that sign-in happens the old PIN
 * still opens the local cache, which is the one soft edge in this design and is inherent to
 * checking a secret the server owns without asking the server.
 */
export async function enrol(
  profileId: number,
  pin: string,
  storage: UnlockStorage = localStorage,
  now: number = Date.now(),
): Promise<CryptoKey> {
  const all = readAll(storage)
  const held = all[String(profileId)]

  /*
   * The same PIN keeps the same data key, and this is load-bearing rather than an optimisation.
   *
   * Minting a fresh key on every sign-in would re-seal the vault under something the existing blob
   * was not written with — so every ordinary online unlock would silently discard the offline log,
   * including entries queued but not yet sent and a pump session still running. The key rotates
   * when, and only when, the PIN no longer opens it: that is a PIN changed on another device, and
   * discarding records the new PIN cannot open is then the correct outcome rather than a loss.
   *
   * The failure counter is deliberately not touched on the way past. This path is reached only
   * after the server has agreed to the PIN, so a mismatch here is a stale enrolment, not somebody
   * guessing — counting it would have the panel lock out the one person who is definitely right.
   */
  if (held) {
    const existing = await tryOpen(held, pin)
    if (existing) {
      if (held.failed !== 0 || held.lockedUntilMs != null) {
        all[String(profileId)] = { ...held, failed: 0, lockedUntilMs: null }
        writeAll(storage, all)
      }
      return existing
    }
  }

  const crypto = globalThis.crypto!
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))

  /*
   * A random data key, wrapped — rather than encrypting the cache under the PIN-derived key itself.
   *
   * It costs one extra step and buys the thing that matters on a PIN change: re-wrapping is a few
   * bytes, where re-deriving the cache's encryption would mean decrypting and re-encrypting every
   * record at exactly the moment somebody is standing at a keypad waiting to be let in.
   */
  const dataKey = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  const raw = await subtle().exportKey('raw', dataKey)
  const wrapping = await deriveWrappingKey(pin, salt, ITERATIONS)
  const wrapped = await subtle().encrypt({ name: 'AES-GCM', iv }, wrapping, raw)

  all[String(profileId)] = {
    v: 1,
    salt: toBase64(salt),
    iv: toBase64(iv),
    wrapped: toBase64(new Uint8Array(wrapped)),
    iterations: ITERATIONS,
    // A fresh enrolment clears the wait: the person who just proved themselves to the server is not
    // the person the lockout was counting.
    failed: 0,
    lockedUntilMs: null,
    savedAtMs: now,
  }
  writeAll(storage, all)

  return dataKey
}

/**
 * Check four digits against what this device remembers, and open the cache's key if they match.
 *
 * The failure cases are kept apart because the Lock screen has to say different things about them:
 * a wrong PIN is worth trying again, an unenrolled profile never will be until the house is back in
 * range, and a lockout is a reason to wait rather than to doubt the digits.
 */
export async function unlockOffline(
  profileId: number,
  pin: string,
  storage: UnlockStorage = localStorage,
  now: number = Date.now(),
): Promise<OfflineUnlockResult> {
  const all = readAll(storage)
  const held = all[String(profileId)]
  if (!held) return { ok: false, kind: 'not-enrolled' }

  if (held.lockedUntilMs != null && now < held.lockedUntilMs) {
    return { ok: false, kind: 'locked-out', retryAfterSeconds: Math.ceil((held.lockedUntilMs - now) / 1000) }
  }

  const key = await tryOpen(held, pin)
  if (!key) {
    /*
     * The authentication tag did not verify. That is the whole of the check — there is no stored
     * comparison value, so a wrong PIN cannot be told apart from a corrupt record here, and both
     * mean the same thing to the person typing: this did not open.
     */
    const failed = held.failed + 1
    const lockedUntilMs = cooldownUntil(failed, now)
    all[String(profileId)] = { ...held, failed, lockedUntilMs }
    writeAll(storage, all)
    if (lockedUntilMs != null) {
      return { ok: false, kind: 'locked-out', retryAfterSeconds: Math.ceil((lockedUntilMs - now) / 1000) }
    }
    return { ok: false, kind: 'wrong-pin' }
  }

  if (held.failed !== 0 || held.lockedUntilMs != null) {
    all[String(profileId)] = { ...held, failed: 0, lockedUntilMs: null }
    writeAll(storage, all)
  }

  return { ok: true, key }
}

/** Unwrap the data key, or null when these digits are not the ones it was wrapped under. */
async function tryOpen(held: Enrolment, pin: string): Promise<CryptoKey | null> {
  try {
    const wrapping = await deriveWrappingKey(pin, fromBase64(held.salt), held.iterations)
    const raw = await subtle().decrypt(
      { name: 'AES-GCM', iv: fromBase64(held.iv) }, wrapping, fromBase64(held.wrapped),
    )
    return await subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  } catch {
    return null
  }
}

/**
 * Forget this profile's enrolment, or every profile's.
 *
 * Signing out means it: the data key goes with the enrolment, so the encrypted cache left behind is
 * not openable by anyone, including whoever signs in next.
 */
export function clearEnrolment(profileId?: number, storage: UnlockStorage = localStorage): void {
  if (profileId == null) {
    try { storage.removeItem(KEY) } catch { /* best effort */ }
    return
  }
  const all = readAll(storage)
  delete all[String(profileId)]
  writeAll(storage, all)
}

/** Seconds until this profile's keypad reopens, or null when it is not waiting. */
export function lockoutSeconds(
  profileId: number, storage: UnlockStorage = localStorage, now: number = Date.now(),
): number | null {
  const held = readAll(storage)[String(profileId)]
  if (!held?.lockedUntilMs || now >= held.lockedUntilMs) return null
  return Math.ceil((held.lockedUntilMs - now) / 1000)
}

/**
 * How long to wait after this many failures.
 *
 * Five free attempts, because a PIN typed one-handed in the dark is mistyped and being made to wait
 * for that is its own kind of lock-out. After them it doubles, which reaches the cap in four more —
 * fast enough to matter against somebody working through ten thousand candidates by hand, and
 * capped because an unbounded wait strands the household rather than the attacker.
 */
function cooldownUntil(failed: number, now: number): number | null {
  if (failed < FREE_ATTEMPTS) return null
  const steps = failed - FREE_ATTEMPTS
  return now + Math.min(FIRST_COOLDOWN_MS * 2 ** steps, MAX_COOLDOWN_MS)
}

async function deriveWrappingKey(pin: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const material = await subtle().importKey(
    'raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey'],
  )
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

// ---- storage plumbing ----

function readAll(storage: UnlockStorage): Enrolments {
  try {
    const raw = storage.getItem(KEY)
    const parsed = raw ? (JSON.parse(raw) as Enrolments) : {}
    // An older or truncated shape is dropped rather than half-read: the cost of getting this wrong
    // is a PIN that cannot be checked, and failing to "not enrolled" is the safe direction.
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeAll(storage: UnlockStorage, all: Enrolments): void {
  try {
    storage.setItem(KEY, JSON.stringify(all))
  } catch {
    /* A full or disabled store costs this device its offline unlock and nothing else. */
  }
}

function toBase64(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}
