import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearQueueStore, closeQueueStore, flushQueueStore, isQueueStoreOpen, openQueueStore,
  sealedQueueStore as store,
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

  it('leaves a plaintext store it cannot migrate exactly where it is', async () => {
    const storage = new MemoryStorage()
    storage.setItem('homehub.writequeue.v1', JSON.stringify([groceryOp('g')]))

    await openQueueStore(2, null, storage)

    // Reading it into memory and deleting it would destroy the very writes it was migrating.
    expect(storage.getItem('homehub.writequeue.v1')).not.toBeNull()
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
