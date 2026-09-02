import type { CareEntryDto } from '../../api/types'
import type { LocalTimer, PendingEntry } from './careOffline'

/**
 * Where the care log's offline memory actually lives.
 *
 * <b>Split out of `careOffline` because it answers a different question.</b> That module owns the
 * rules — when two rows are one feed, what a queued entry looks like, how long a local session has
 * run — and those are pure and worth testing on their own. This owns the far less interesting and
 * far more dangerous question of what is written to the device and who can read it back.
 *
 * <b>What changed and why.</b> The cache used to be plain JSON in `localStorage`, guarded by
 * purging it whenever the panel locked or booted without a server. That guard worked, in the sense
 * that a locked device held nothing — and it is exactly why an offline cold start came up to an
 * empty log behind a keypad that could not be opened. Protecting the data by destroying it is not a
 * trade this screen can make: the log at 4am is the entire point of the tab.
 *
 * So the store is now sealed rather than emptied. One blob per profile, encrypted under the data
 * key that {@link ../../app/offlineUnlock} wraps behind the PIN, written whole on every change and
 * opened once at unlock. A locked device holds a blob nobody can read; the person who knows the
 * four digits opens it with or without a server.
 *
 * <b>Sync reads, async writes, and why it is arranged that way.</b> WebCrypto has no synchronous
 * form, and the log's readers cannot become async — `useCareLog` seeds its state from these on
 * first render, and a care screen that starts empty and fills in a frame later is a screen that
 * says `NO RECORD` to somebody at 4am and then contradicts itself. So the whole vault is decrypted
 * once into memory at unlock, reads are memory reads, and only the write back is asynchronous. The
 * cost is a window of about one AES-GCM call between a change and its being durable, which is worth
 * naming: an entry logged and then killed inside that window loses its *row*, not the entry itself
 * — the write-queue operation carrying it is persisted synchronously and separately, and is what
 * actually reaches the server.
 */

/** Bump when the sealed shape changes — an old blob is dropped rather than half-read. */
const VAULT_PREFIX = 'homehub.care.vault.v1.'

/**
 * The plaintext keys this replaces.
 *
 * Removed on every open rather than migrated. They belong to a build that purged them on lock, so
 * anything still there is at most one session old, and importing unencrypted records into a store
 * whose whole purpose is that they are not is the wrong direction to carry data.
 */
const LEGACY_KEYS = [
  'homehub.care.cache.v1',
  'homehub.care.cache.v1.summary',
  'homehub.care.pending.v1',
  'homehub.care.timers.v1',
]

export interface VaultStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  /** Enumerated so a sign-out can find every profile's blob without knowing who has one. */
  key?(index: number): string | null
  readonly length?: number
}

/** Everything the care log remembers for one profile while there is no server. */
export interface CareVault {
  entries: Record<string, CareEntryDto[]>
  summary: Record<string, CareEntryDto[]>
  pending: PendingEntry[]
  timers: LocalTimer[]
}

const EMPTY: CareVault = { entries: {}, summary: {}, pending: [], timers: [] }

/**
 * How this session may hold the records — two answers, and there is deliberately no third.
 *
 * <b>There used to be a third, and it was the finding.</b> A profile with no PIN was given a
 * `plaintext` seal on the reasoning that there was no secret to seal under, so the kiosk profile's
 * care log sat in `localStorage` as it reads. The premise was wrong rather than the conclusion: a
 * device can hold a key nobody typed — see `../../app/deviceKey` — and "this member chose not to set
 * a PIN" was never a statement about whether their record may be read off the device by whoever picks
 * it up next. The seal is now `sealed` for every profile that can hold a key at all.
 *
 * The remaining case is the one that is easy to miss and easy to get wrong. A profile with a PIN can
 * reach an unlocked panel without typing it: `requirePinWhenIdle` off means a cold boot with a live
 * cookie goes straight in. There is then no key in hand, and the two obvious moves are both wrong —
 * writing the cache in the clear undoes the sealing, and opening the blob sealed under the PIN is
 * impossible. So that session remembers things in memory and writes none of it down. The log works
 * (the server is evidently reachable, or the session would not have been confirmed); what it costs is
 * that a reload starts from the last blob somebody actually typed a PIN for. Reaching for the device
 * key there would be the same mistake in a new place — it would seal a PIN-holding member's records
 * under something the PIN is not needed to open.
 */
export type VaultSeal =
  /**
   * A key is in hand: records are sealed under it.
   *
   * Two different keys arrive as this one shape, and keeping them one shape is deliberate. A PIN
   * profile's key is unwrapped from four digits by `../../app/offlineUnlock`; a profile with no PIN
   * gets the non-extractable device key from `../../app/deviceKey`. They protect against different
   * things and are worth different amounts — the modules that mint them say so at length — but what
   * this store does with either is identical, and a store that knew the difference would eventually
   * act on it.
   */
  | { kind: 'sealed'; key: CryptoKey }
  /** No key available. Nothing is written to the device this session. */
  | { kind: 'memory' }

/*
 * Cold boot starts closed, and stays closed until somebody has proved who they are — to the server,
 * or to this device with the PIN. A locked render cannot recover care records by importing this
 * module, which is the same promise the old `storageUnlocked` flag made and is why it is still a
 * single gate rather than a check spread across ten functions.
 */
let vault: CareVault | null = null
let openProfileId: number | null = null
let openSeal: VaultSeal = { kind: 'memory' }
let openStorage: VaultStorage | null = null

/** Writes are serialised through this so two quick saves cannot land out of order. */
let persisting: Promise<void> = Promise.resolve()

/**
 * Open this profile's vault under the seal this session is entitled to.
 *
 * A `memory` seal reads nothing back: there is no key, so the stored blob stays shut, and the
 * session starts from an empty log that the server is about to fill.
 *
 * A blob that will not open — wrong key, truncated write, a shape from an older build — starts the
 * profile empty rather than throwing. The next successful read from the server refills it, and a
 * care screen that opens blank is recoverable in a way one that fails to render is not.
 */
export async function openCareVault(
  profileId: number,
  seal: VaultSeal,
  storage: VaultStorage = localStorage,
): Promise<void> {
  await persisting
  openProfileId = profileId
  openSeal = seal
  openStorage = storage
  for (const legacy of LEGACY_KEYS) remove(storage, legacy)

  const raw = seal.kind === 'sealed' ? read(storage, vaultKey(profileId)) : null
  if (seal.kind !== 'sealed' || !raw) {
    vault = { entries: {}, summary: {}, pending: [], timers: [] }
    return
  }

  /*
   * A blob the previous build wrote in the clear, discarded rather than adopted.
   *
   * The no-PIN profile's vault used to be stored as JSON under this exact key, so an upgraded panel
   * finds one there. Re-sealing it would be the tempting move and is the wrong one: the records have
   * already been legible on the device for as long as that build ran, sealing them now proves nothing
   * about who wrote them, and the migration this needs is one that leaves nothing readable behind.
   * Removed on sight, and the profile starts from what the server sends back.
   */
  if (!isSealed(raw)) {
    remove(storage, vaultKey(profileId))
    vault = { entries: {}, summary: {}, pending: [], timers: [] }
    return
  }

  try {
    vault = normalise(JSON.parse(await decrypt(seal.key, raw)) as Partial<CareVault>)
  } catch {
    /*
     * <b>A blob this key does not open makes the session memory-only, and the blob is not touched.</b>
     *
     * Starting empty is only half an answer, and the missing half is the dangerous one. This session
     * kept the wrong key and a writable store, so the first thing that changed the vault — a server
     * refill, a pending entry, a pump timer ticking — sealed an empty log under that wrong key and
     * replaced the rightful owner's blob. Whoever holds the wrong key must be able to read nothing
     * *and* destroy nothing, and those are two claims; only the first was being made.
     *
     * The same rule as `../../app/queueStore`, which is where it was got right first and where the
     * reasoning was written down. It should have been carried back here at the time: the two stores
     * hold the same rows and are opened under the same key, so a hazard in one is a hazard in both.
     *
     * The cost is the one `../../app/offlineUnlock.enrol` already names — a PIN changed on another
     * device strands what was sealed under the old key until a sign-out clears it. Stranded is
     * recoverable by the household; overwritten is not.
     */
    openSeal = { kind: 'memory' }
    vault = { entries: {}, summary: {}, pending: [], timers: [] }
  }
}

/**
 * Close the vault, leaving the sealed blob where it is.
 *
 * <b>Closing is not erasing, and that distinction is the feature.</b> A lock, an idle timeout or an
 * expired cookie all mean "this person is not proven right now" — none of them mean the household
 * has finished with the record. Erasing on those was what made an offline morning start from
 * nothing. What is left behind is unreadable without the PIN, so the privacy answer is the same one
 * the purge gave, and the log is still there afterwards.
 */
export function closeCareVault(): void {
  vault = null
  openProfileId = null
  openSeal = { kind: 'memory' }
}

/** Whether the vault is open for reading and writing. */
export function isCareVaultOpen(): boolean {
  return vault != null
}

/**
 * Erase every profile's care records from the device.
 *
 * Signing out means it, and means it for everyone: the blob goes here and the data key goes with
 * the enrolment, so neither half survives. Kept separate from {@link closeCareVault} precisely
 * because most of what used to call the purge only meant "close".
 */
export function clearCareVault(storage: VaultStorage = localStorage): void {
  closeCareVault()
  for (const legacy of LEGACY_KEYS) remove(storage, legacy)
  for (const key of vaultKeys(storage)) remove(storage, key)
  openStorage = null
}

/** Read the open vault. Empty when it is closed — a locked panel remembers nothing. */
export function readVault(): CareVault {
  return vault ?? EMPTY
}

/**
 * Change the vault and start writing it back.
 *
 * The mutation is applied to memory synchronously, so the caller's next read sees it, and the seal
 * and store follow on the microtask queue. Failures are swallowed for the same reason the old store
 * swallowed them: a full or disabled `localStorage` costs the panel its offline memory, and it must
 * not cost it the screen.
 */
export function writeVault(update: (current: CareVault) => CareVault): void {
  if (!vault) return
  vault = update(vault)
  const snapshot = vault
  const profileId = openProfileId
  const seal = openSeal
  const storage = openStorage
  // A memory seal has nowhere to put it, and saying so here rather than at each call site is what
  // keeps the four `save*` functions identical whichever way the session was opened.
  if (profileId == null || !storage || seal.kind === 'memory') return

  persisting = persisting.then(async () => {
    try {
      write(storage, vaultKey(profileId), await encrypt(seal.key, JSON.stringify(snapshot)))
    } catch {
      /* best effort — see above */
    }
  })
}

/** Wait for the last change to be durable. For tests, and for a page on its way out. */
export function flushCareVault(): Promise<void> {
  return persisting
}

// ---- sealing ----

/**
 * `iv.payload`, both base64.
 *
 * A fresh IV per write, which AES-GCM requires absolutely — reusing one across two writes under the
 * same key is the failure that hands an attacker the plaintext difference. Carried with the blob
 * rather than derived, because the whole vault is rewritten on every change.
 */
async function encrypt(key: CryptoKey, json: string): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const sealed = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(json),
  )
  return `${toBase64(iv)}.${toBase64(new Uint8Array(sealed))}`
}

/**
 * Whether a stored value has the shape this module writes.
 *
 * Told apart from a plaintext blob by the alphabet rather than by trying to decrypt and seeing what
 * happens: JSON opens with `{`, which is not a base64 character, so a record written in the clear can
 * never be mistaken for a sealed one that failed to open — and the two need different answers. A
 * failed decrypt starts the profile empty and leaves the blob alone, because the right key may arrive
 * later. A plaintext blob is erased.
 */
function isSealed(raw: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}\.[A-Za-z0-9+/]+={0,2}$/.test(raw)
}

async function decrypt(key: CryptoKey, raw: string): Promise<string> {
  const [iv, payload] = raw.split('.')
  if (!iv || !payload) throw new Error('not a sealed vault')
  const opened = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv) }, key, fromBase64(payload),
  )
  return new TextDecoder().decode(opened)
}

// ---- storage plumbing ----

function vaultKey(profileId: number): string {
  return `${VAULT_PREFIX}${profileId}`
}

/**
 * Every profile's blob key.
 *
 * `Storage` is enumerable and the injected test double may not be, so a store without `key`/`length`
 * yields nothing rather than throwing — a sign-out on such a store still clears the open profile's
 * records through the legacy sweep and the close above.
 */
function vaultKeys(storage: VaultStorage): string[] {
  const total = storage.length
  if (typeof total !== 'number' || typeof storage.key !== 'function') return []
  const keys: string[] = []
  for (let i = 0; i < total; i += 1) {
    const key = storage.key(i)
    if (key?.startsWith(VAULT_PREFIX)) keys.push(key)
  }
  return keys
}

/** A stored shape from an older build is filled out rather than trusted whole. */
function normalise(held: Partial<CareVault>): CareVault {
  return {
    entries: held.entries && typeof held.entries === 'object' ? held.entries : {},
    summary: held.summary && typeof held.summary === 'object' ? held.summary : {},
    pending: Array.isArray(held.pending) ? held.pending : [],
    timers: Array.isArray(held.timers) ? held.timers : [],
  }
}

function read(storage: VaultStorage, key: string): string | null {
  try { return storage.getItem(key) } catch { return null }
}

function write(storage: VaultStorage, key: string, value: string): void {
  try { storage.setItem(key, value) } catch { /* best effort */ }
}

function remove(storage: VaultStorage, key: string): void {
  try { storage.removeItem(key) } catch { /* best effort */ }
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
