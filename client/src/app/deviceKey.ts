/**
 * The key a profile with no PIN seals its private records under.
 *
 * <b>The gap this closes.</b> `offlineUnlock` wraps a data key behind four digits, which is the whole
 * story for a profile that has a PIN and no story at all for one that does not. The kiosk profile —
 * the one the household deliberately left open so anybody can tap it — had nothing to seal under, so
 * its care log was written to `localStorage` as it reads. "Nobody set a PIN" is a statement about who
 * may *use* the panel; it was being read as permission to leave a household's record legible to
 * anything that can open a browser store, which is not the same claim and was never made.
 *
 * <b>What this is, precisely.</b> A per-profile AES-GCM key generated with `extractable: false` and
 * kept in IndexedDB as a `CryptoKey` object rather than as bytes. The browser holds the material
 * itself; a structured clone of a non-extractable key is still non-extractable, so reading the
 * database back — from devtools, from another script, from a copy of the profile directory — yields a
 * handle and not a secret. `exportKey` on it throws. That is what makes it different in kind from
 * writing a base64 key beside the ciphertext it opens, which is the shape this was required not to be.
 *
 * <b>What it does not buy, stated as plainly as {@link ./offlineUnlock} states its own limit.</b>
 * Any script running on the panel's own origin can *use* the key, because that is what the key is for.
 * This defends the record at rest — a device picked up, a storage inspection, another profile's turn
 * on the shared panel — and it does not defend it against code already running as the panel. A PIN is
 * still the stronger boundary and is still what a member who wants one should set. Clearing site data
 * destroys the key and with it the sealed records, which is the honest cost of having no PIN to
 * re-derive it from and is why the queue and the vault both treat an unreadable blob as an empty one.
 *
 * <b>Fails to nothing, never to plaintext.</b> A browser without IndexedDB, a private-mode window that
 * refuses to open one, a panel served over plain HTTP with no `crypto.subtle` — all return null, and
 * every caller reads null as "this session remembers in memory only". There is no path from here that
 * ends in a private record being written out in the clear.
 */

/** One store, one database. Named for what it holds rather than for the screen that wants it. */
const DB_NAME = 'homehub-device-keys'
const STORE = 'profileKeys'
const DB_VERSION = 1

/**
 * Where the keys actually live, injected so the rules above can be tested without IndexedDB.
 *
 * The node test environment has WebCrypto and no IndexedDB, which is exactly the shape of the
 * degraded browser this has to survive — so the same seam serves both.
 */
export interface DeviceKeyBackend {
  get(profileId: number): Promise<CryptoKey | null>
  put(profileId: number, key: CryptoKey): Promise<void>
  /** One profile's key, or every profile's when the id is omitted. */
  remove(profileId?: number): Promise<void>
}

/** Whether this browser can hold a key at all. Callers use it to explain a memory-only session. */
export function isDeviceKeyAvailable(): boolean {
  return !!globalThis.crypto?.subtle && !!globalThis.indexedDB
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed.'))
  })
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = globalThis.indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB could not be opened.'))
    // A private-mode window can leave an open() request neither resolving nor erroring. Treated as
    // "no store here", which is the same answer as having no IndexedDB at all.
    req.onblocked = () => reject(new Error('IndexedDB is blocked.'))
  })
}

async function withStore<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  const db = await openDatabase()
  try {
    const tx = db.transaction(STORE, mode)
    const result = await work(tx.objectStore(STORE))
    // Writes are only durable once the transaction commits, and `put` resolving is not that.
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'))
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'))
    })
    return result
  } finally {
    db.close()
  }
}

const indexedDbBackend: DeviceKeyBackend = {
  get: (profileId) => withStore('readonly', async (store) => {
    const held = await request<unknown>(store.get(profileId))
    // A stored value that is not a CryptoKey is a shape from something else entirely. Ignored rather
    // than coerced: the next call mints a fresh key, and a wrong key opens nothing anyway.
    return held instanceof CryptoKey ? held : null
  }),
  put: (profileId, key) => withStore('readwrite', async (store) => {
    await request(store.put(key, profileId))
  }),
  remove: (profileId) => withStore('readwrite', async (store) => {
    await request(profileId == null ? store.clear() : store.delete(profileId))
  }),
}

/**
 * Serialised, because two callers asking at once must get the same key.
 *
 * The boot path and an unlock can both reach for a profile's key inside the same tick. Two
 * unserialised generates would each mint a key, the second would overwrite the first, and whichever
 * blob had been sealed under the loser would silently stop opening — an offline log that vanishes for
 * no reason anybody could reproduce.
 */
let pending: Promise<unknown> = Promise.resolve()

function serialised<T>(work: () => Promise<T>): Promise<T> {
  const run = pending.then(work, work)
  pending = run.then(() => undefined, () => undefined)
  return run
}

/**
 * This profile's device key, minting one the first time it is asked for.
 *
 * Null whenever the device cannot hold a key — see the fail-to-nothing note above. Callers must read
 * that as "seal nothing this session", never as "write it in the clear".
 */
export function deviceKeyFor(
  profileId: number,
  backend: DeviceKeyBackend = indexedDbBackend,
): Promise<CryptoKey | null> {
  if (!isDeviceKeyAvailable() && backend === indexedDbBackend) return Promise.resolve(null)
  return serialised(async () => {
    try {
      const held = await backend.get(profileId)
      if (held) return held
      const key = await globalThis.crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        // <b>The whole point of this module.</b> Non-extractable, so what IndexedDB holds is a handle
        // the browser will use and will not hand over — `exportKey` throws, and a copy of the profile
        // directory carries no key material with it.
        false,
        ['encrypt', 'decrypt'],
      )
      await backend.put(profileId, key)
      return key
    } catch {
      return null
    }
  })
}

/**
 * Forget this profile's key, or every profile's.
 *
 * Signing out means it here for the same reason it means it in {@link ./offlineUnlock}: the key and
 * the records it opens are two halves of one secret, and a device handed on should carry neither.
 */
export async function clearDeviceKeys(
  profileId?: number,
  backend: DeviceKeyBackend = indexedDbBackend,
): Promise<void> {
  if (!isDeviceKeyAvailable() && backend === indexedDbBackend) return
  await serialised(async () => {
    try { await backend.remove(profileId) } catch { /* best effort — a key nobody can read is inert */ }
  })
}

/** An in-memory backend, for tests and for reasoning about the degraded case. */
export function memoryDeviceKeyBackend(): DeviceKeyBackend {
  const held = new Map<number, CryptoKey>()
  return {
    get: (profileId) => Promise.resolve(held.get(profileId) ?? null),
    put: (profileId, key) => { held.set(profileId, key); return Promise.resolve() },
    remove: (profileId) => {
      if (profileId == null) held.clear()
      else held.delete(profileId)
      return Promise.resolve()
    },
  }
}
