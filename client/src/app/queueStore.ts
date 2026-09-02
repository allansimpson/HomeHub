import type { DroppedOp, QueueStore, QueuedOp } from './writeQueue'
import { isPrivateDomain } from './writeQueue'

/**
 * Where the write queue actually lives, and who can read it back.
 *
 * <b>Split out of `writeQueue` for the reason `careVault` is split out of `careOffline`.</b> That
 * module owns the rules — write ahead, replay in order, retain on refusal, quarantine what has no
 * owner — and they are pure and worth testing on their own. This owns the far less interesting and
 * far more dangerous question of what is written to the device.
 *
 * <b>What changed and why.</b> The queue was `JSON.stringify` straight into `localStorage`. That is
 * defensible for a pantry item and indefensible for what actually goes through it: a care operation
 * carries the household's record in its body — feed volumes, nappy contents, times, the child's
 * name — and it sat there in the clear after lock, after sign-out, after a restart, and while another
 * member used the same panel. The care *log* had already been sealed; the queue carrying the same rows
 * to the server had not, so the sealing was a front door beside an open window.
 *
 * <b>Sealed whole, under the session's own key.</b> One blob per profile, encrypted with the key that
 * {@link ./SessionProvider} hands both this and the care vault — unwrapped from a PIN by
 * `./offlineUnlock`, or the non-extractable device key from `./deviceKey` for a profile that has none.
 * Not a per-field seal: `path` names a child's care route and `label` is written to be read by a
 * person, so the routing metadata is no less identifying than the body it routes.
 *
 * <b>Sync reads, async writes, and why the durability claim survives it.</b> The rules in
 * `writeQueue` read the store synchronously and must keep doing so — they re-read on every turn of a
 * replay precisely so a concurrent enqueue is never overwritten, and a rule that had to await could
 * not. So the queue is decrypted once into memory when the session opens, reads are memory reads, and
 * the seal is written back behind {@link flushQueueStore}. The write-ahead invariant is unchanged and
 * is now explicit: `executeDurably` awaits the flush before its fetch begins, so an operation is
 * sealed on the device before anything is sent, exactly as it was before.
 *
 * <b>A session with no key writes nothing down.</b> A profile with a PIN that reached an unlocked
 * panel without typing it holds no key — see `careVault`'s note on the same case — so its queue is
 * memory-only for the session. That costs a write made in the minutes after the connection drops and
 * before the page is reloaded; it is the same trade the care log already makes, and the alternative is
 * the plaintext this exists to remove.
 */

/** Bump when the sealed shape changes — an old blob is dropped rather than half-read. */
const SEALED_PREFIX = 'homehub.writequeue.sealed.v1.'

/**
 * The plaintext keys this replaces, and what becomes of what is in them.
 *
 * Not simply deleted, because a queued write is somebody's unsent work rather than a cache. The
 * migration is stated in {@link adoptLegacy} and is deliberately asymmetric: an ordinary write is
 * carried across into the seal, a private one is set aside so the household is *told* rather than
 * having it replayed out of a store whose contents nothing can vouch for.
 */
const LEGACY_KEY = 'homehub.writequeue.v1'
const LEGACY_DROPPED_KEY = 'homehub.writequeue.dropped.v1'

/** Beyond this a set-aside notice is a wall of text nobody reads. Oldest fall off first. */
const MAX_DROPPED = 20

/**
 * Announced whenever the queue is opened, closed or emptied.
 *
 * `WriteQueueProvider` mirrors the store into React state and had nothing to re-read on: the store
 * used to be readable at every moment of the app's life, and now it is shut until a session opens it.
 * An event rather than a prop, because the provider that opens it (`SessionProvider`) sits above the
 * one that mirrors it and passing a token down through both would make every screen re-render on it.
 */
export const QUEUE_STORE_EVENT = 'homehub:queue-store'

export interface QueueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  /** Enumerated so a sign-out can find every profile's blob without knowing who has one. */
  key?(index: number): string | null
  readonly length?: number
}

/** What one profile's sealed blob holds. */
interface SealedQueue {
  ops: QueuedOp[]
  dropped: DroppedOp[]
}

/*
 * Shut until a session opens it, which is the same promise `careVault` makes and for the same
 * reason: a locked render must not be able to recover queued private writes by importing a module.
 */
let held: SealedQueue | null = null
let openProfileId: number | null = null
let openKey: CryptoKey | null = null
let openStorage: QueueStorage | null = null

/** Writes are serialised through this so two quick saves cannot land out of order. */
let persisting: Promise<void> = Promise.resolve()

function announce(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(QUEUE_STORE_EVENT))
}

/**
 * Open this profile's queue under the key this session holds.
 *
 * A null key is a session that may not write anything down: the queue works for the life of the page
 * and is not persisted. A blob that will not open — wrong key, truncated write, a shape from an older
 * build — starts empty rather than throwing, for the same reason the care vault does: a panel that
 * fails to render has lost more than a panel that starts with an empty queue.
 */
export async function openQueueStore(
  profileId: number,
  key: CryptoKey | null,
  storage: QueueStorage = localStorage,
): Promise<void> {
  // Swallowed here and only here: a store that refused the *previous* session's last write is a fact
  // its caller was already told, and re-throwing it at whoever opens next would fail an unlock over it.
  await persisting.catch(() => undefined)
  openProfileId = profileId
  openKey = key
  openStorage = storage

  let opened: SealedQueue = { ops: [], dropped: [] }
  const raw = key ? read(storage, sealedKey(profileId)) : null
  if (raw && key) {
    try {
      const parsed = JSON.parse(await decrypt(key, raw)) as Partial<SealedQueue>
      opened = {
        ops: Array.isArray(parsed.ops) ? parsed.ops : [],
        dropped: Array.isArray(parsed.dropped) ? parsed.dropped : [],
      }
    } catch {
      /*
       * <b>A blob this key does not open makes the session memory-only, and the blob is not touched.</b>
       *
       * The obvious reading is "start empty", and taken alone it is a data-loss bug rather than a
       * recovery: the very next write would seal an empty queue over somebody else's unsent work.
       * Whoever holds the wrong key here — a switched profile, a device key against a PIN-sealed
       * blob — must be able to read nothing *and* destroy nothing, and those are two claims.
       *
       * So the key is dropped for this session. Writes work for the life of the page and persist
       * nowhere, which is the same answer given to a session that never had a key at all. The cost is
       * the one `offlineUnlock.enrol` already names for the care vault: a PIN changed on another
       * device strands what was sealed under the old one until a sign-out clears it.
       */
      openKey = null
    }
  }

  /*
   * A session with no key still has to deal with private plaintext. It just cannot adopt anything.
   *
   * This used to return early and leave the whole legacy store alone, on the reasoning that reading
   * it into memory and deleting it would destroy the writes it was migrating. True of the *ordinary*
   * writes and false of the private ones, and that distinction is the finding: a panel that never
   * opens a key-bearing session — locked, restarted, another member's turn — left a previous build's
   * care bodies, paths and labels readable in `localStorage` indefinitely. Waiting for a session that
   * can migrate safely is not a plan when the wait has no bound.
   *
   * So the private half is dealt with now, destructively, and the ordinary half is left for a session
   * that can seal it. See {@link sweepPrivateLegacy}.
   */
  if (!openKey) {
    sweepPrivateLegacy(profileId, storage)
    held = opened
    announce()
    return
  }

  /*
   * The migration is planned, sealed, and only then allowed to touch its source.
   *
   * <b>It used to delete first.</b> `adoptLegacy` removed the plaintext entries as it read them and
   * the sealed replacement was written by a `persistNow()` nobody awaited — so a quota exhaustion or
   * any other storage failure during an upgrade destroyed ordinary unsent operations and the only
   * notices for the quarantined private ones, with no replacement written. That is not "decided once,
   * durably"; it is decided once and possibly not recorded at all.
   *
   * Planning is pure, so on failure the legacy keys are byte-identical and the migration is simply
   * retried on the next open. The in-memory queue rolls back with them — presenting adopted
   * operations that are not durable would let a later ordinary write seal them while the legacy store
   * still holds them, which is the same records twice.
   */
  const plan = planLegacyMigration(opened, profileId, storage)
  held = plan.migrated
  announce()
  if (!plan.changed) return

  persistNow()
  try {
    await flushQueueStore()
  } catch {
    held = opened
    announce()
    return
  }
  commitLegacyMigration(plan, storage)
}

/**
 * Take a previous build's private plaintext off the device when there is no key to seal it under.
 *
 * <b>Destructive, deliberately, and in this order.</b> The private operation is removed from the
 * legacy store first and the notice is written afterwards: removing is the privacy-critical act and
 * it frees the space the notice needs, so a store too full to hold the telling still stops holding
 * the record. That is the opposite ordering to {@link planLegacyMigration}, and for the opposite
 * reason — there the replacement must survive, here the original must not.
 *
 * <b>The notice is generic, because it is stored in the clear.</b> A sealed quarantine notice carries
 * the operation's label so the household knows which entry to re-enter; this one cannot, or it would
 * leave the private thing behind in the process of announcing its removal. What is left is enough to
 * act on — something was set aside, whose, and roughly what — and nothing that reads as a record.
 *
 * Ordinary writes are untouched. They were already legible, they lose nothing by waiting, and a
 * session that can seal them is what they are waiting for.
 */
function sweepPrivateLegacy(profileId: number, storage: QueueStorage): void {
  const legacy = readJson<QueuedOp>(storage, LEGACY_KEY)
  if (legacy.length === 0) return

  const mine = (owner: number | null | undefined) => owner == null || owner === profileId
  const kept: QueuedOp[] = []
  const swept: QueuedOp[] = []
  for (const op of legacy) {
    if (mine(op.ownerProfileId) && (op.ownerProfileId == null || isPrivateDomain(op.domain))) swept.push(op)
    else kept.push(op)
  }
  if (swept.length === 0) return

  write(storage, LEGACY_KEY, kept)
  const notices = swept.map((op) => redactedNotice(
    op, op.ownerProfileId == null ? 'legacy-orphaned' : 'legacy-plaintext'))
  write(storage, LEGACY_DROPPED_KEY,
    [...readJson<DroppedOp>(storage, LEGACY_DROPPED_KEY), ...notices].slice(-MAX_DROPPED))
}

/**
 * Carry a previous build's plaintext queue across, and refuse to carry the private half of it.
 *
 * <b>An ordinary write is adopted.</b> A queued grocery add is somebody's unsent tap, it was already
 * legible on this device, and dropping it on upgrade would lose work to no benefit. It moves into the
 * seal and the plaintext entry goes.
 *
 * <b>A private write is quarantined, never replayed.</b> Nothing about a plaintext record establishes
 * who wrote it or that it was not edited, and replaying one sends a care row to the server under
 * whichever session is open now. So it becomes a set-aside notice — the household sees that an entry
 * did not make it and can enter it again — and the operation itself is discarded. The notice carries
 * the label because a notice nobody can identify is not a telling.
 *
 * <b>An operation with no owner at all is quarantined too</b>, which is the rule `replayQueue` already
 * applied to them; it is applied here now because the plaintext store is the only place they exist.
 */
interface LegacyMigration {
  /** What the sealed store becomes. Nothing is written until this is durable. */
  migrated: SealedQueue
  /** What the plaintext operation store becomes once it is. */
  left: QueuedOp[]
  /** What the plaintext notice store becomes once it is. */
  noticesLeft: DroppedOp[]
  changed: boolean
}

/** Work out the migration without touching a single stored byte. */
function planLegacyMigration(
  opened: SealedQueue, profileId: number, storage: QueueStorage,
): LegacyMigration {
  const legacy = readJson<QueuedOp>(storage, LEGACY_KEY)
  const legacyDropped = readJson<DroppedOp>(storage, LEGACY_DROPPED_KEY)
  if (legacy.length === 0 && legacyDropped.length === 0) {
    return { migrated: opened, left: [], noticesLeft: [], changed: false }
  }

  const mine = (owner: number | null | undefined) => owner == null || owner === profileId
  const adopted: QueuedOp[] = []
  const quarantined: DroppedOp[] = []
  const left: QueuedOp[] = []

  for (const op of legacy) {
    if (!mine(op.ownerProfileId)) { left.push(op); continue }
    if (op.ownerProfileId == null) {
      quarantined.push(notice(op, 'legacy-orphaned'))
    } else if (isPrivateDomain(op.domain)) {
      quarantined.push(notice(op, 'legacy-plaintext'))
    } else {
      adopted.push(op)
    }
  }

  return {
    migrated: {
      // Ordered by creation rather than appended, so an adopted write keeps its place against anything
      // already sealed. FIFO is the whole contract of a replay queue.
      ops: byId([...opened.ops, ...adopted]).sort((a, b) => a.createdAt - b.createdAt),
      dropped: byId([
        ...opened.dropped,
        ...legacyDropped.filter((d) => mine(d.ownerProfileId)),
        ...quarantined,
      ]).slice(-MAX_DROPPED),
    },
    left,
    noticesLeft: legacyDropped.filter((d) => !mine(d.ownerProfileId)),
    changed: true,
  }
}

/**
 * First occurrence of each id wins, which makes the migration idempotent.
 *
 * <b>Not belt and braces — it closes the one gap the ordering above cannot.</b> The sealed
 * replacement is written before the plaintext source is retired, so if retiring it silently fails
 * (`write` is best-effort by design, because the legacy store is on its way out either way) the next
 * open would find the same operations in both places and adopt them a second time. A duplicate
 * queued write is not a cosmetic problem: for the care domain it is a second feed on the log.
 *
 * Already-sealed entries come first in every merge above, so an operation the household has since
 * amended keeps the amendment rather than being reverted to the plaintext copy of itself.
 */
function byId<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  return items.filter((item) => !seen.has(item.id) && seen.add(item.id))
}

/** Retire the plaintext source. Called only once its sealed replacement is on the device. */
function commitLegacyMigration(plan: LegacyMigration, storage: QueueStorage): void {
  write(storage, LEGACY_KEY, plan.left)
  write(storage, LEGACY_DROPPED_KEY, plan.noticesLeft)
}

/** A notice that will be sealed, so it may carry the label the household needs to identify it. */
function notice(op: QueuedOp, reason: DroppedOp['reason']): DroppedOp {
  return {
    id: op.id,
    label: op.label,
    domain: op.domain,
    ownerProfileId: op.ownerProfileId,
    reason,
    at: op.createdAt,
  }
}

/**
 * A notice that will be stored in the clear, so it may carry nothing that reads as a record.
 *
 * The label is the private half of a queued operation after its body — "Bottle 120ml for Wren" is the
 * entry, restated for a person to read — so a plaintext notice keeps the domain and the owner and
 * replaces the label with a sentence the household can act on without it naming anything.
 */
function redactedNotice(op: QueuedOp, reason: DroppedOp['reason']): DroppedOp {
  return {
    id: op.id,
    label: 'An offline entry from an older version could not be carried over. Please re-enter it.',
    domain: op.domain,
    ownerProfileId: op.ownerProfileId,
    reason,
    at: op.createdAt,
  }
}

/**
 * Close the queue, leaving the sealed blob where it is.
 *
 * Closing is not erasing, exactly as in `careVault`: a lock or an expired cookie means "this person
 * is not proven right now", not "the household has finished with these writes". What is left behind
 * is unreadable without the key, and the writes are still there to replay on the next unlock.
 */
export function closeQueueStore(): void {
  held = null
  openProfileId = null
  openKey = null
  announce()
}

/** Erase every profile's queued writes from the device. For sign-out, which means it. */
export function clearQueueStore(storage: QueueStorage = localStorage): void {
  const target = openStorage ?? storage
  closeQueueStore()
  remove(target, LEGACY_KEY)
  remove(target, LEGACY_DROPPED_KEY)
  for (const key of sealedKeys(target)) remove(target, key)
  openStorage = null
  announce()
}

/** Whether the queue is open for reading and writing. */
export function isQueueStoreOpen(): boolean {
  return held != null
}

/**
 * The store the rules in `writeQueue` operate over.
 *
 * Reads are memory reads and writes apply to memory synchronously, so every rule keeps the shape it
 * had. Durability is {@link flushQueueStore}, awaited by the one caller whose contract depends on it.
 */
export const sealedQueueStore: QueueStore = {
  read: () => held?.ops ?? [],
  write: (ops) => {
    if (!held) return
    held = { ...held, ops }
    persistNow()
  },
  readDropped: () => held?.dropped ?? [],
  writeDropped: (dropped) => {
    if (!held) return
    held = { ...held, dropped: dropped.slice(-MAX_DROPPED) }
    persistNow()
  },
  flush: () => persisting,
}

/**
 * Resolves when everything written so far is on the device, and rejects when it could not be.
 *
 * <b>The rejection is the durability contract, and it is load-bearing.</b> A write-ahead queue that
 * silently ignores persistence failure is not durable — the caller has to be able to retain its source
 * data (notably a completed care timer) and say so. It used to be a synchronous throw out of
 * `localStorage.setItem`; sealing is asynchronous, so it is a rejected promise now, and the callers
 * that relied on the throw await this instead.
 */
export function flushQueueStore(): Promise<void> {
  return persisting
}

function persistNow(): void {
  const snapshot = held
  const profileId = openProfileId
  const key = openKey
  const storage = openStorage
  // No key is a session that may not write anything down. Said here rather than at each call site,
  // which is what keeps every rule in `writeQueue` identical whichever way the session was opened.
  if (!snapshot || profileId == null || !key || !storage) return

  /*
   * The chain absorbs the previous write's failure and reports its own.
   *
   * `persisting.catch(…).then(…)` rather than `persisting.then(…)`: a rejected link left in the chain
   * would be inherited by every write after it, so one full `localStorage` would make the queue
   * permanently undurable even once space was free. The rejection still reaches whoever is awaiting
   * *this* flush, which is the caller that has source data to retain.
   */
  persisting = persisting.catch(() => undefined).then(async () => {
    const sealed = await encrypt(key, JSON.stringify(snapshot))
    try {
      storage.setItem(sealedKey(profileId), sealed)
    } catch (cause) {
      throw new Error('The offline write could not be persisted.', { cause })
    }
  })
  // Nobody may be awaiting this one. An unobserved rejection is still a real failure and is reported
  // to the caller that asked for it; it must not also be an unhandled rejection on the page.
  void persisting.catch(() => undefined)
}

// ---- sealing ----

/** `iv.payload`, both base64, with a fresh IV per write. Same construction as `careVault`. */
async function encrypt(key: CryptoKey, json: string): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const sealed = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(json),
  )
  return `${toBase64(iv)}.${toBase64(new Uint8Array(sealed))}`
}

async function decrypt(key: CryptoKey, raw: string): Promise<string> {
  const [iv, payload] = raw.split('.')
  if (!iv || !payload) throw new Error('not a sealed queue')
  const opened = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv) }, key, fromBase64(payload),
  )
  return new TextDecoder().decode(opened)
}

// ---- storage plumbing ----

function sealedKey(profileId: number): string {
  return `${SEALED_PREFIX}${profileId}`
}

function sealedKeys(storage: QueueStorage): string[] {
  const total = storage.length
  if (typeof total !== 'number' || typeof storage.key !== 'function') return []
  const keys: string[] = []
  for (let i = 0; i < total; i += 1) {
    const key = storage.key(i)
    if (key?.startsWith(SEALED_PREFIX)) keys.push(key)
  }
  return keys
}

function readJson<T>(storage: QueueStorage, key: string): T[] {
  try {
    const raw = storage.getItem(key)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function read(storage: QueueStorage, key: string): string | null {
  try { return storage.getItem(key) } catch { return null }
}

function write(storage: QueueStorage, key: string, value: unknown[]): void {
  try {
    if (value.length === 0) storage.removeItem(key)
    else storage.setItem(key, JSON.stringify(value))
  } catch { /* best effort — the legacy store is on its way out either way */ }
}

function remove(storage: QueueStorage, key: string): void {
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
