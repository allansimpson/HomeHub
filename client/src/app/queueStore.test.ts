import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearQueueStore, closeQueueStore, flushQueueStore, isQueueStoreOpen, openQueueStore,
  sealedQueueStore as store, sweepLegacyPlaintext,
} from './queueStore'
import type { QueueStorage } from './queueStore'
import { persistAhead } from './writeQueue'
import type { QueuedOp } from './writeQueue'

class MemoryStorage implements QueueStorage {
  readonly values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  get length() { return this.values.size }
}

const aKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])

/** A care write, which is what made sealing the queue necessary. */
const careOp = (id: string, owner = 2): QueuedOp => ({
  id,
  ownerProfileId: owner,
  domain: 'care',
  method: 'POST',
  path: '/care/children/1/entries',
  body: { type: 'Bottle', volumeMl: 120, note: 'took it all' },
  label: 'Bottle 120ml for Wren',
  createdAt: 10,
})

const groceryOp = (id: string, owner = 2, createdAt = 20): QueuedOp => ({
  id,
  ownerProfileId: owner,
  domain: 'grocery',
  method: 'POST',
  path: '/grocery',
  body: { name: 'Olive oil' },
  label: 'Add Olive oil',
  createdAt,
})

/**
 * What the device holds between sessions, now that the queue holds it too — HH-04.
 *
 * The care *log* was sealed and the queue carrying the same rows to the server was not, so a feed
 * volume, a nappy note and a child's name sat in `localStorage` in the clear after lock, after
 * sign-out, after a restart, and while another member used the same panel. Sealing one and not the
 * other was a front door beside an open window.
 */

beforeEach(() => {
  vi.stubGlobal('window', new EventTarget())
  closeQueueStore()
})

describe('sealing', () => {
  it('gives a reopened session its queued writes back', async () => {
    const storage = new MemoryStorage()
    const key = await aKey()

    await openQueueStore(2, key, storage)
    persistAhead(store, careOp('a'))
    await flushQueueStore()

    closeQueueStore()
    await openQueueStore(2, key, storage)

    expect(store.read().map((o) => o.id)).toEqual(['a'])
  })

  /* The whole point: what sits on the device between sessions must not read as a care record. */
  it('writes nothing legible to the store', async () => {
    const storage = new MemoryStorage()
    await openQueueStore(2, await aKey(), storage)

    persistAhead(store, careOp('a'))
    await flushQueueStore()

    const stored = storage.getItem('homehub.writequeue.sealed.v1.2')
    expect(stored).not.toBeNull()
    for (const legible of ['Bottle', 'Wren', '120', 'took it all', '/care/children/1/entries']) {
      expect(stored).not.toContain(legible)
    }
  })

  it('keeps a set-aside notice sealed too, because the notice carries the label', async () => {
    const storage = new MemoryStorage()
    await openQueueStore(2, await aKey(), storage)

    store.writeDropped([{
      id: 'a', label: 'Bottle 120ml for Wren', domain: 'care', ownerProfileId: 2,
      reason: 'rejected', at: 1,
    }])
    await flushQueueStore()

    expect(storage.getItem('homehub.writequeue.sealed.v1.2')).not.toContain('Wren')
  })

  it('does not open one profile\'s queue with another profile\'s key', async () => {
    const storage = new MemoryStorage()
    const mine = await aKey()
    await openQueueStore(2, mine, storage)
    persistAhead(store, careOp('a'))
    await flushQueueStore()
    const sealed = storage.getItem('homehub.writequeue.sealed.v1.2')

    /*
     * Somebody else's key against the same blob. Reads nothing — and, importantly, destroys nothing.
     *
     * The second claim is the one that had to be written down. "Cannot read it" was satisfied by
     * starting empty, and starting empty meant the very next write sealed an empty queue over the
     * rightful owner's unsent work. Writing under the wrong key is exercised here for that reason.
     */
    await openQueueStore(2, await aKey(), storage)
    expect(store.read()).toEqual([])
    persistAhead(store, careOp('intruder'))
    await flushQueueStore()
    expect(storage.getItem('homehub.writequeue.sealed.v1.2')).toBe(sealed)

    await openQueueStore(2, mine, storage)
    expect(store.read().map((o) => o.id)).toEqual(['a'])
  })

  it('partitions by profile, so a switch cannot read the other member\'s queue', async () => {
    const storage = new MemoryStorage()
    const theirs = await aKey()
    await openQueueStore(3, theirs, storage)
    persistAhead(store, careOp('theirs', 3))
    await flushQueueStore()

    await openQueueStore(2, await aKey(), storage)

    expect(store.read()).toEqual([])
  })
})

describe('a session that holds no key', () => {
  /*
   * A profile with a PIN that reached an unlocked panel without typing it. There is no key, so
   * nothing may be written down — writing it in the clear would undo the sealing for exactly the
   * member who asked for it.
   */
  it('works for the life of the page and persists nothing', async () => {
    const storage = new MemoryStorage()
    await openQueueStore(2, null, storage)

    persistAhead(store, careOp('a'))
    await flushQueueStore()

    expect(store.read().map((o) => o.id)).toEqual(['a'])
    expect(storage.getItem('homehub.writequeue.sealed.v1.2')).toBeNull()
  })

  it('leaves an ordinary plaintext write it cannot migrate exactly where it is', async () => {
    const storage = new MemoryStorage()
    storage.setItem('homehub.writequeue.v1', JSON.stringify([groceryOp('g')]))

    await openQueueStore(2, null, storage)

    // Reading it into memory and deleting it would destroy the very write it was migrating, and it
    // loses nothing by waiting for a session that can seal it.
    expect(storage.getItem('homehub.writequeue.v1')).toContain('Olive oil')
  })

  /*
   * RR-05. The private half cannot wait, and this is where the previous version was wrong.
   *
   * "Leave it for a session that can migrate safely" is not a plan when the wait has no bound: a panel
   * that is locked, restarted, or handed to another member never opens a key-bearing session for this
   * profile, and a previous build's care bodies, paths and labels stayed readable in `localStorage`
   * indefinitely — across exactly the transitions the release claims protect them.
   */
  it('takes private plaintext off the device even with no key to seal it under', async () => {
    const storage = new MemoryStorage()
    storage.setItem('homehub.writequeue.v1', JSON.stringify([careOp('c'), groceryOp('g')]))

    await openQueueStore(2, null, storage)

    const remaining = storage.getItem('homehub.writequeue.v1') ?? ''
    for (const legible of ['Bottle', 'Wren', '120', 'took it all', '/care/children/1/entries']) {
      expect(remaining).not.toContain(legible)
    }
    // And the ordinary write beside it is untouched.
    expect(remaining).toContain('Olive oil')
  })

  it('sweeps an unowned plaintext operation too, which is nobody\'s to keep', async () => {
    const storage = new MemoryStorage()
    const orphan = { ...groceryOp('o'), ownerProfileId: undefined } as unknown as QueuedOp
    storage.setItem('homehub.writequeue.v1', JSON.stringify([orphan]))

    await openQueueStore(2, null, storage)

    expect(storage.getItem('homehub.writequeue.v1')).toBeNull()
  })

  /*
   * The notice is stored in the clear, so it may carry nothing that reads as a record — otherwise it
   * would leave the private thing behind in the act of announcing its removal.
   */
  it('leaves a recovery notice that names no record', async () => {
    const storage = new MemoryStorage()
    storage.setItem('homehub.writequeue.v1', JSON.stringify([careOp('c')]))

    await openQueueStore(2, null, storage)

    const notices = storage.getItem('homehub.writequeue.dropped.v1') ?? ''
    expect(notices).toContain('could not be carried over')
    expect(notices).toContain('legacy-plaintext')
    expect(notices).not.toContain('Bottle')
    expect(notices).not.toContain('Wren')
  })

  /*
   * This test used to assert the opposite, and the assertion was the bug written down.
   *
   * "Leave another member's records for that member to deal with" reads as respect and is the reverse
   * of it: their care record sat legible in the same shared `localStorage`, and the session that could
   * have removed it declined on their behalf. On a wall panel that boots locked, or opens somebody
   * else, the member whose turn would clear it never comes.
   */
  it('sweeps another profile\'s private plaintext too, rather than deferring to a session that may never come', async () => {
    const storage = new MemoryStorage()
    storage.setItem('homehub.writequeue.v1', JSON.stringify([careOp('theirs', 3)]))

    await openQueueStore(2, null, storage)

    const remaining = storage.getItem('homehub.writequeue.v1') ?? ''
    expect(remaining).not.toContain('Bottle')
    expect(remaining).not.toContain('Wren')
  })

  it('still leaves another profile\'s ordinary write for a session that can seal it', async () => {
    const storage = new MemoryStorage()
    storage.setItem('homehub.writequeue.v1', JSON.stringify([groceryOp('theirs', 3)]))

    await openQueueStore(2, null, storage)

    // Nothing private about it, and adopting it into *this* profile's seal would attribute somebody
    // else's tap to whoever is signed in now.
    expect(storage.getItem('homehub.writequeue.v1')).toContain('theirs')
  })

  it('sweeps for a session whose key turned out to be the wrong one', async () => {
    const storage = new MemoryStorage()
    await openQueueStore(2, await aKey(), storage)
    persistAhead(store, groceryOp('sealed'))
    await flushQueueStore()
    closeQueueStore()
    storage.setItem('homehub.writequeue.v1', JSON.stringify([careOp('c')]))

    // A wrong key is a session with no key, and it must reach the same conclusion about plaintext.
    await openQueueStore(2, await aKey(), storage)

    expect(storage.getItem('homehub.writequeue.v1')).toBeNull()
  })
})

/**
 * The privacy sweep answers to nobody's session — the second-round RR-05 residuals.
 *
 * Three separate ways the first version could report a sweep it had not performed: it asked only
 * about the profile being opened, it ran only when a profile store was opened at all, and it rewrote
 * the store through a helper that swallows failure.
 */
describe('the boot sweep', () => {
  it('needs no profile and no key, which is what a locked panel has', () => {
    const storage = new MemoryStorage()
    storage.setItem('homehub.writequeue.v1', JSON.stringify([
      careOp('mine', 2), careOp('theirs', 3), groceryOp('ordinary', 2),
    ]))

    expect(sweepLegacyPlaintext(storage)).toBe(true)

    const remaining = storage.getItem('homehub.writequeue.v1') ?? ''
    expect(remaining).not.toContain('Bottle')
    expect(remaining).not.toContain('Wren')
    expect(remaining).toContain('Olive oil')
  })

  it('is idempotent, because a panel boots more than once', () => {
    const storage = new MemoryStorage()
    storage.setItem('homehub.writequeue.v1', JSON.stringify([careOp('c'), groceryOp('g')]))

    sweepLegacyPlaintext(storage)
    const after = storage.getItem('homehub.writequeue.v1')
    expect(sweepLegacyPlaintext(storage)).toBe(true)

    expect(storage.getItem('homehub.writequeue.v1')).toBe(after)
  })

  /*
   * The rewrite is read back rather than trusted. When it will not take, the whole key goes — the
   * ordinary write beside it is collateral, and that is the right way round: an unsent grocery item
   * can be tapped again and a legible care record cannot be un-read.
   */
  it('removes the whole key rather than reporting a sweep that did not happen', () => {
    const storage = new MemoryStorage()
    const legacy = JSON.stringify([careOp('c'), groceryOp('g')])
    storage.setItem('homehub.writequeue.v1', legacy)
    // A store that refuses to replace the value — quota, or a disabled store mid-session.
    storage.setItem = () => { throw new DOMException('quota', 'QuotaExceededError') }

    expect(sweepLegacyPlaintext(storage)).toBe(true)

    expect(storage.getItem('homehub.writequeue.v1')).toBeNull()
  })

  it('says so when the device will not let go of it at all', () => {
    const storage = new MemoryStorage()
    storage.setItem('homehub.writequeue.v1', JSON.stringify([careOp('c')]))
    storage.setItem = () => { throw new DOMException('quota', 'QuotaExceededError') }
    storage.removeItem = () => { throw new DOMException('denied', 'SecurityError') }

    // Reporting success here would be the function claiming a privacy guarantee it did not deliver.
    expect(sweepLegacyPlaintext(storage)).toBe(false)
  })

  /*
   * The fail-open paths. `readJson` answers `[]` for a store that throws, a value that is not JSON,
   * and a value that is JSON but not an array — and the sweep took that empty list as proof there was
   * nothing to remove. Every one of those is a state in which a care record may be sitting there
   * unexamined, and reporting success about it is the function claiming something it never checked.
   */
  it('does not read an unreadable store as an empty one', () => {
    const storage = new MemoryStorage()
    storage.setItem('homehub.writequeue.v1', JSON.stringify([careOp('c')]))
    storage.getItem = () => { throw new DOMException('denied', 'SecurityError') }

    expect(sweepLegacyPlaintext(storage)).toBe(false)
  })

  it('does not read malformed JSON as an empty store, and does not leave it there', () => {
    const storage = new MemoryStorage()
    // Half a write — a tab killed mid-`setItem`, and the tail of a care record still legible in it.
    storage.setItem('homehub.writequeue.v1',
      '[{"id":"c","domain":"care","label":"Bottle 120ml for Wren","body":{"volumeMl":1')

    expect(sweepLegacyPlaintext(storage)).toBe(true)

    expect(storage.getItem('homehub.writequeue.v1')).toBeNull()
  })

  it('does not read a non-array value as an empty store', () => {
    const storage = new MemoryStorage()
    storage.setItem('homehub.writequeue.v1', '{"label":"Bottle 120ml for Wren"}')

    expect(sweepLegacyPlaintext(storage)).toBe(true)

    expect(storage.getItem('homehub.writequeue.v1')).toBeNull()
  })

  it('treats a malformed entry among well-formed ones as sensitive', () => {
    const storage = new MemoryStorage()
    storage.setItem('homehub.writequeue.v1', JSON.stringify([null, groceryOp('g')]))

    expect(sweepLegacyPlaintext(storage)).toBe(true)

    // The one it could classify survives; the one it could not does not.
    const remaining = storage.getItem('homehub.writequeue.v1') ?? ''
    expect(remaining).toContain('Olive oil')
    expect(remaining).not.toContain('null')
  })

  it('reports failure when it cannot confirm the removal, rather than assuming it', () => {
    const storage = new MemoryStorage()
    storage.setItem('homehub.writequeue.v1', JSON.stringify([careOp('c')]))
    storage.setItem = () => { throw new DOMException('quota', 'QuotaExceededError') }
    storage.removeItem = () => undefined // silently does nothing, which is the case worth catching

    expect(sweepLegacyPlaintext(storage)).toBe(false)
  })

  /*
   * The notices were missed the first time, and the omission is the whole of it: a notice carries
   * `label`, which for a care write is the entry restated for a person to read. The records were
   * removed from one key and left legible in the one beside it.
   */
  it('sweeps a previous build\'s set-aside notices, which name the entries', () => {
    const storage = new MemoryStorage()
    storage.setItem('homehub.writequeue.dropped.v1', JSON.stringify([
      { id: 'c', label: 'Bottle 120ml for Wren', domain: 'care', ownerProfileId: 2, reason: 'rejected', at: 1 },
      { id: 'g', label: 'Add Olive oil', domain: 'grocery', ownerProfileId: 2, reason: 'rejected', at: 2 },
    ]))
    storage.setItem('homehub.writequeue.v1', JSON.stringify([careOp('c')]))

    expect(sweepLegacyPlaintext(storage)).toBe(true)

    const notices = storage.getItem('homehub.writequeue.dropped.v1') ?? ''
    expect(notices).not.toContain('Bottle')
    expect(notices).not.toContain('Wren')
    // The ordinary one is somebody's telling about their own shopping, and stays.
    expect(notices).toContain('Olive oil')
  })

  it('sweeps a legible notice even when the operation store is already clean', () => {
    const storage = new MemoryStorage()
    storage.setItem('homehub.writequeue.dropped.v1', JSON.stringify([
      { id: 'c', label: 'Bottle 120ml for Wren', domain: 'care', ownerProfileId: 2, reason: 'rejected', at: 1 },
    ]))

    expect(sweepLegacyPlaintext(storage)).toBe(true)

    expect(storage.getItem('homehub.writequeue.dropped.v1') ?? '').not.toContain('Wren')
  })

  /*
   * The notices this sweep writes are private-domain too, so a rule that swept by domain would delete
   * the household's own telling on the next boot. They are recognised by the exact sentence they carry.
   */
  it('does not sweep away its own redacted notices on the next boot', () => {
    const storage = new MemoryStorage()
    storage.setItem('homehub.writequeue.v1', JSON.stringify([careOp('c')]))

    sweepLegacyPlaintext(storage)
    const afterFirst = storage.getItem('homehub.writequeue.dropped.v1')
    expect(afterFirst).toContain('could not be carried over')

    expect(sweepLegacyPlaintext(storage)).toBe(true)

    expect(storage.getItem('homehub.writequeue.dropped.v1')).toBe(afterFirst)
  })

  /*
   * The same four answers the operation store had to tell apart, in the notice store — which is where
   * they were left collapsed after being fixed next door, in the same function, in the same commit.
   * `readJson` returns `[]` for a store that throws, for half-written JSON and for a value that is not
   * an array, and only one of those means there is nothing to sweep.
   */
  it('does not read an unreadable notice store as an empty one', () => {
    const storage = new MemoryStorage()
    storage.setItem('homehub.writequeue.dropped.v1', JSON.stringify([
      { id: 'c', label: 'Bottle 120ml for Wren', domain: 'care', ownerProfileId: 2, reason: 'rejected', at: 1 },
    ]))
    const real = storage.getItem.bind(storage)
    storage.getItem = (key) => {
      if (key === 'homehub.writequeue.dropped.v1') throw new DOMException('denied', 'SecurityError')
      return real(key)
    }

    expect(sweepLegacyPlaintext(storage)).toBe(false)
  })

  it('does not read malformed notices as an empty store, and does not leave them there', () => {
    const storage = new MemoryStorage()
    // A tab killed mid-write, with the tail of a care label still legible in it.
    storage.setItem('homehub.writequeue.dropped.v1',
      '[{"id":"c","label":"Bottle 120ml for Wren","domain":"car')

    expect(sweepLegacyPlaintext(storage)).toBe(true)

    expect(storage.getItem('homehub.writequeue.dropped.v1') ?? '').not.toContain('Wren')
  })

  it('does not read a non-array notice value as an empty store', () => {
    const storage = new MemoryStorage()
    storage.setItem('homehub.writequeue.dropped.v1', '{"label":"Bottle 120ml for Wren"}')

    expect(sweepLegacyPlaintext(storage)).toBe(true)

    expect(storage.getItem('homehub.writequeue.dropped.v1') ?? '').not.toContain('Wren')
  })

  it('still records its own notices after clearing a malformed store', () => {
    const storage = new MemoryStorage()
    storage.setItem('homehub.writequeue.v1', JSON.stringify([careOp('c')]))
    storage.setItem('homehub.writequeue.dropped.v1', 'not json at all')

    expect(sweepLegacyPlaintext(storage)).toBe(true)

    // The household still gets told, even though what was there before had to go wholesale.
    expect(storage.getItem('homehub.writequeue.dropped.v1') ?? '').toContain('could not be carried over')
  })

  it('reports failure when a legible notice cannot be removed', () => {
    const storage = new MemoryStorage()
    storage.setItem('homehub.writequeue.dropped.v1', JSON.stringify([
      { id: 'c', label: 'Bottle 120ml for Wren', domain: 'care', ownerProfileId: 2, reason: 'rejected', at: 1 },
    ]))
    storage.setItem = () => { throw new DOMException('quota', 'QuotaExceededError') }
    storage.removeItem = () => undefined

    // Claiming the sweep succeeded while the entry is still legible is the failure being closed.
    expect(sweepLegacyPlaintext(storage)).toBe(false)
  })

  it('leaves a store with nothing sensitive in it exactly as it found it', () => {
    const storage = new MemoryStorage()
    const legacy = JSON.stringify([groceryOp('g')])
    storage.setItem('homehub.writequeue.v1', legacy)

    expect(sweepLegacyPlaintext(storage)).toBe(true)

    expect(storage.getItem('homehub.writequeue.v1')).toBe(legacy)
    expect(storage.getItem('homehub.writequeue.dropped.v1')).toBeNull()
  })

  /*
   * The third residual: sealing succeeded, retiring the source did not, and the migration reported
   * itself complete with the plaintext still there. Deduplication stopped the replay and never
   * touched the disclosure.
   */
  /*
   * The sanitation answer has to reach the caller, and the store has to stop being durable.
   *
   * `commitLegacyMigration` swept after retiring the source and threw the result away, so a store that
   * had just proved it could not remove a plaintext care record still finished the open with a durable
   * key — and every private write after it sealed into the blob sitting beside the plaintext original.
   * Sealing more of the same rows next to a copy nothing can delete is a second copy, not a boundary.
   */
  it('reports a failed post-seal sanitation instead of opening as though it succeeded', async () => {
    const storage = new MemoryStorage()
    storage.setItem('homehub.writequeue.v1', JSON.stringify([careOp('c'), groceryOp('theirs', 3)]))
    const real = storage.setItem.bind(storage)
    // The seal lands; the plaintext source can be neither rewritten nor removed.
    storage.setItem = (k, v) => {
      if (k === 'homehub.writequeue.v1') throw new DOMException('quota', 'QuotaExceededError')
      real(k, v)
    }
    storage.removeItem = () => undefined

    const sanitised = await openQueueStore(2, await aKey(), storage)

    expect(sanitised).toBe(false)
    expect(storage.getItem('homehub.writequeue.v1')).toContain('Bottle')
  })

  it('writes nothing durable afterwards, having said it could not clean up', async () => {
    const storage = new MemoryStorage()
    storage.setItem('homehub.writequeue.v1', JSON.stringify([careOp('c'), groceryOp('theirs', 3)]))
    const real = storage.setItem.bind(storage)
    storage.setItem = (k, v) => {
      if (k === 'homehub.writequeue.v1') throw new DOMException('quota', 'QuotaExceededError')
      real(k, v)
    }
    storage.removeItem = () => undefined

    const key = await aKey()
    await openQueueStore(2, key, storage)
    const sealedAtOpen = storage.getItem('homehub.writequeue.sealed.v1.2')
    persistAhead(store, careOp('after'))
    await flushQueueStore()

    // In memory for the life of the page, and nowhere else: the durable key was revoked.
    expect(store.read().map((o) => o.id)).toContain('after')
    expect(storage.getItem('homehub.writequeue.sealed.v1.2')).toBe(sealedAtOpen)

    /*
     * The blob written by the migration itself stays, and that is right rather than an oversight. It
     * is ciphertext, so it discloses nothing — the disclosure is the plaintext original the device
     * refused to remove — and it holds the household's unsent work. What is withheld is anything
     * *further*, which is the claim: no more private rows are added to a device that has shown it
     * cannot clean up after itself.
     */
    closeQueueStore()
    await openQueueStore(2, key, storage)
    expect(store.read().map((o) => o.id)).not.toContain('after')
  })

  it('keeps the operations it already held when durability is revoked', async () => {
    const storage = new MemoryStorage()
    const key = await aKey()
    await openQueueStore(2, key, storage)
    persistAhead(store, groceryOp('earlier'))
    await flushQueueStore()
    closeQueueStore()

    storage.setItem('homehub.writequeue.v1', JSON.stringify([careOp('c'), groceryOp('theirs', 3)]))
    const real = storage.setItem.bind(storage)
    storage.setItem = (k, v) => {
      if (k === 'homehub.writequeue.v1') throw new DOMException('quota', 'QuotaExceededError')
      real(k, v)
    }
    storage.removeItem = () => undefined

    expect(await openQueueStore(2, key, storage)).toBe(false)

    // Revoking durability is not closing the store: unsent work read out of the seal is still here.
    expect(store.read().map((o) => o.id)).toContain('earlier')
  })

  it('reports success on an ordinary open, so the caller is not warned for nothing', async () => {
    const storage = new MemoryStorage()

    expect(await openQueueStore(2, await aKey(), storage)).toBe(true)
    expect(await openQueueStore(2, null, storage)).toBe(true)
  })

  it('catches a source that outlived a successful seal', async () => {
    const storage = new MemoryStorage()
    const key = await aKey()
    /*
     * Another profile's ordinary write is in the store on purpose. It is what makes retirement a
     * *rewrite* rather than a removal, which is the case that can half-succeed — and the case the
     * previous version returned from as though the migration were complete.
     */
    storage.setItem('homehub.writequeue.v1', JSON.stringify([careOp('c'), groceryOp('theirs', 3)]))
    const real = storage.setItem.bind(storage)
    // The seal lands; the legacy rewrite does not.
    storage.setItem = (k, v) => {
      if (k === 'homehub.writequeue.v1') return
      real(k, v)
    }

    await openQueueStore(2, key, storage)
    await flushQueueStore()

    expect(storage.getItem('homehub.writequeue.sealed.v1.2')).not.toBeNull()
    // The care record is gone, whole key and all. Another profile's grocery item goes with it, which
    // is the right way round — it can be tapped again and a legible care record cannot be un-read.
    expect(storage.getItem('homehub.writequeue.v1')).toBeNull()
  })
})

describe('a closed store', () => {
  it('answers empty and refuses writes, so a locked panel remembers nothing', () => {
    expect(isQueueStoreOpen()).toBe(false)
    persistAhead(store, careOp('a'))
    expect(store.read()).toEqual([])
  })

  it('leaves the sealed blob behind, because closing is not erasing', async () => {
    const storage = new MemoryStorage()
    const key = await aKey()
    await openQueueStore(2, key, storage)
    persistAhead(store, careOp('a'))
    await flushQueueStore()

    closeQueueStore()

    expect(store.read()).toEqual([])
    expect(storage.getItem('homehub.writequeue.sealed.v1.2')).not.toBeNull()
    await openQueueStore(2, key, storage)
    expect(store.read().map((o) => o.id)).toEqual(['a'])
  })

  it('erases every profile\'s blob on the act that means it', async () => {
    const storage = new MemoryStorage()
    await openQueueStore(2, await aKey(), storage)
    persistAhead(store, careOp('a'))
    await flushQueueStore()
    storage.setItem('unrelated', 'keep')

    clearQueueStore(storage)

    expect([...storage.values.keys()]).toEqual(['unrelated'])
  })
})

/**
 * The plaintext queue a previous build wrote, and what becomes of what is in it.
 *
 * Deliberately asymmetric. An ordinary write is somebody's unsent tap and was already legible on this
 * device, so carrying it into the seal loses nothing and saves work. A private one is refused: nothing
 * about a plaintext record establishes who wrote it or that it was not edited, and replaying one sends
 * a care row to the server under whichever session happens to be open now.
 */
describe('migration off the plaintext store', () => {
  it('adopts an ordinary write and seals it', async () => {
    const storage = new MemoryStorage()
    storage.setItem('homehub.writequeue.v1', JSON.stringify([groceryOp('g')]))

    await openQueueStore(2, await aKey(), storage)
    await flushQueueStore()

    expect(store.read().map((o) => o.id)).toEqual(['g'])
    expect(storage.getItem('homehub.writequeue.v1')).toBeNull()
    expect(storage.getItem('homehub.writequeue.sealed.v1.2')).not.toContain('Olive oil')
  })

  it('quarantines a private write instead of replaying it, and tells the household', async () => {
    const storage = new MemoryStorage()
    storage.setItem('homehub.writequeue.v1', JSON.stringify([careOp('c')]))

    await openQueueStore(2, await aKey(), storage)

    expect(store.read()).toEqual([])
    expect(store.readDropped()).toMatchObject([{ id: 'c', reason: 'legacy-plaintext' }])
    expect(storage.getItem('homehub.writequeue.v1')).toBeNull()
  })

  it('quarantines an operation with no owner, which is nobody\'s to replay', async () => {
    const storage = new MemoryStorage()
    const orphan = { ...groceryOp('o'), ownerProfileId: undefined } as unknown as QueuedOp
    storage.setItem('homehub.writequeue.v1', JSON.stringify([orphan]))

    await openQueueStore(2, await aKey(), storage)

    expect(store.read()).toEqual([])
    expect(store.readDropped()).toMatchObject([{ id: 'o', reason: 'legacy-orphaned' }])
  })

  it('leaves another profile\'s plaintext entries for that profile to deal with', async () => {
    const storage = new MemoryStorage()
    storage.setItem('homehub.writequeue.v1', JSON.stringify([groceryOp('theirs', 3)]))

    await openQueueStore(2, await aKey(), storage)

    expect(store.read()).toEqual([])
    expect(storage.getItem('homehub.writequeue.v1')).toContain('theirs')
  })

  it('keeps an adopted write in creation order against what was already sealed', async () => {
    const storage = new MemoryStorage()
    const key = await aKey()
    await openQueueStore(2, key, storage)
    persistAhead(store, groceryOp('late', 2, 30))
    await flushQueueStore()
    closeQueueStore()

    // Queued before the sealed one, so FIFO puts it first however it arrives.
    storage.setItem('homehub.writequeue.v1', JSON.stringify([groceryOp('early', 2, 5)]))
    await openQueueStore(2, key, storage)

    expect(store.read().map((o) => o.id)).toEqual(['early', 'late'])
  })

  it('decides the migration once, durably, rather than on every boot', async () => {
    const storage = new MemoryStorage()
    const key = await aKey()
    storage.setItem('homehub.writequeue.v1', JSON.stringify([careOp('c')]))

    await openQueueStore(2, key, storage)
    await flushQueueStore()
    closeQueueStore()
    await openQueueStore(2, key, storage)

    // Told once. A quarantine held only in memory would be re-decided, and re-announced, for ever.
    expect(store.readDropped()).toHaveLength(1)
  })
})

/**
 * The migration must not delete its source before the replacement is durable — RR-02.
 *
 * It used to: `adoptLegacy` removed the plaintext entries as it read them, and the sealed replacement
 * was written by a `persistNow()` nobody awaited. So a quota exhaustion during an upgrade destroyed
 * ordinary unsent operations *and* the only notices for the quarantined private ones, and wrote no
 * replacement at all. The migration tests below the success path could not see it, because they never
 * combined legacy source data with a store that refuses.
 */
describe('migration is not allowed to lose the data it is migrating', () => {
  /** A store that takes reads and legacy rewrites but refuses the sealed blob. */
  const refusingSeal = () => {
    const storage = new MemoryStorage()
    const real = storage.setItem.bind(storage)
    storage.setItem = (key, value) => {
      if (key.startsWith('homehub.writequeue.sealed.')) {
        throw new DOMException('quota', 'QuotaExceededError')
      }
      real(key, value)
    }
    return storage
  }

  it('leaves the plaintext source byte-identical when the sealed write fails', async () => {
    const storage = refusingSeal()
    const legacy = JSON.stringify([groceryOp('g'), careOp('c')])
    storage.setItem('homehub.writequeue.v1', legacy)

    await openQueueStore(2, await aKey(), storage)
    await flushQueueStore().catch(() => undefined)

    expect(storage.getItem('homehub.writequeue.v1')).toBe(legacy)
    expect(storage.getItem('homehub.writequeue.sealed.v1.2')).toBeNull()
  })

  it('does not present operations it could not make durable', async () => {
    const storage = refusingSeal()
    storage.setItem('homehub.writequeue.v1', JSON.stringify([groceryOp('g')]))

    await openQueueStore(2, await aKey(), storage)
    await flushQueueStore().catch(() => undefined)

    /*
     * Rolled back in memory too. Holding an adopted operation the seal never took would let a later
     * ordinary write seal it while the legacy store still holds it — the same record twice, once the
     * migration is retried.
     */
    expect(store.read()).toEqual([])
  })

  it('retries the whole migration on the next open, and lands it', async () => {
    const storage = refusingSeal()
    const key = await aKey()
    storage.setItem('homehub.writequeue.v1', JSON.stringify([groceryOp('g'), careOp('c')]))

    await openQueueStore(2, key, storage)
    await flushQueueStore().catch(() => undefined)
    closeQueueStore()

    // Space freed, or the browser in a better mood.
    const storage2 = new MemoryStorage()
    for (const k of [...storage.values.keys()]) storage2.setItem(k, storage.getItem(k)!)
    await openQueueStore(2, key, storage2)
    await flushQueueStore()

    expect(store.read().map((o) => o.id)).toEqual(['g'])
    expect(store.readDropped()).toMatchObject([{ id: 'c', reason: 'legacy-plaintext' }])
    expect(storage2.getItem('homehub.writequeue.v1')).toBeNull()
  })

  it('keeps the quarantine notice rather than losing it with the operation', async () => {
    const storage = refusingSeal()
    storage.setItem('homehub.writequeue.v1', JSON.stringify([careOp('c')]))

    await openQueueStore(2, await aKey(), storage)
    await flushQueueStore().catch(() => undefined)

    // The private operation is still in the plaintext store — undesirable, and strictly better than
    // gone with no notice. The next successful open quarantines it and tells the household.
    expect(storage.getItem('homehub.writequeue.v1')).toContain('Bottle')
    expect(storage.getItem('homehub.writequeue.dropped.v1')).toBeNull()
  })

  /*
   * The gap the ordering cannot close on its own. Retiring the plaintext source is best-effort — the
   * legacy store is on its way out either way — so a silent failure there would leave the same
   * operations in both places, and a second adoption would be a second feed on the care log.
   */
  it('adopts the same operation once even if the plaintext source outlives the seal', async () => {
    const storage = new MemoryStorage()
    const key = await aKey()
    const legacy = JSON.stringify([groceryOp('g')])
    storage.setItem('homehub.writequeue.v1', legacy)

    await openQueueStore(2, key, storage)
    await flushQueueStore()
    // The retirement failed silently and the source is still there.
    storage.setItem('homehub.writequeue.v1', legacy)
    closeQueueStore()
    await openQueueStore(2, key, storage)
    await flushQueueStore()

    expect(store.read().map((o) => o.id)).toEqual(['g'])
  })

  it('leaves another profile\'s entries in place through a failed migration', async () => {
    const storage = refusingSeal()
    const legacy = JSON.stringify([groceryOp('mine'), groceryOp('theirs', 3)])
    storage.setItem('homehub.writequeue.v1', legacy)

    await openQueueStore(2, await aKey(), storage)
    await flushQueueStore().catch(() => undefined)

    expect(storage.getItem('homehub.writequeue.v1')).toBe(legacy)
  })
})

describe('durability', () => {
  /*
   * The refusal used to be a synchronous throw out of `localStorage.setItem`, which is what let a
   * caller retain its source data — notably a completed care timer — and say so. Sealing is
   * asynchronous, so it is a rejected flush now, and it must still be exactly one caller's problem.
   */
  it('reports a store that will not take the write', async () => {
    const storage = new MemoryStorage()
    storage.setItem = () => { throw new DOMException('quota', 'QuotaExceededError') }
    await openQueueStore(2, await aKey(), storage)

    persistAhead(store, careOp('a'))

    await expect(flushQueueStore()).rejects.toThrow(/persist/i)
  })

  it('does not inherit a past failure, so the queue recovers when space does', async () => {
    const storage = new MemoryStorage()
    const real = storage.setItem.bind(storage)
    let failing = true
    storage.setItem = (k, v) => {
      if (failing) throw new DOMException('quota', 'QuotaExceededError')
      real(k, v)
    }
    await openQueueStore(2, await aKey(), storage)
    persistAhead(store, careOp('a'))
    await expect(flushQueueStore()).rejects.toThrow(/persist/i)

    failing = false
    persistAhead(store, careOp('b'))

    await expect(flushQueueStore()).resolves.toBeUndefined()
  })
})
