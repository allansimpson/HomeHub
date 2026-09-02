import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearCareVault, closeCareVault, flushCareVault, isCareVaultOpen, openCareVault, readVault,
  writeVault,
} from './careVault'
import type { VaultStorage } from './careVault'

class MemoryStorage implements VaultStorage {
  readonly values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  get length() { return this.values.size }
}

const aKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])

const entry = (id: number) => ({ id, type: 'Bottle', atUtc: '2026-08-24T03:00:00Z' } as never)

/**
 * What the device holds between sessions.
 *
 * The old store answered this by holding nothing — it was purged on every lock — and that is what
 * made an offline morning start from an empty log. These cover the two things that replaced it: a
 * locked device gives up nothing readable, and the person who knows the PIN gets their records back
 * without a server being involved.
 */

beforeEach(() => {
  closeCareVault()
})

describe('sealing', () => {
  it('gives a reopened session its records back', async () => {
    const storage = new MemoryStorage()
    const key = await aKey()

    await openCareVault(1, { kind: 'sealed', key }, storage)
    writeVault((cur) => ({ ...cur, entries: { baby: [entry(7)] } }))
    await flushCareVault()

    closeCareVault()
    await openCareVault(1, { kind: 'sealed', key }, storage)

    expect(readVault().entries.baby).toHaveLength(1)
  })

  /* The whole point: what sits on the device between sessions must not read as a care log. */
  it('writes nothing legible to the store', async () => {
    const storage = new MemoryStorage()
    await openCareVault(1, { kind: 'sealed', key: await aKey() }, storage)

    writeVault((cur) => ({ ...cur, entries: { baby: [entry(7)] } }))
    await flushCareVault()

    const stored = storage.getItem('homehub.care.vault.v1.1')
    expect(stored).not.toBeNull()
    expect(stored).not.toContain('Bottle')
    expect(stored).not.toContain('baby')
  })

  /*
   * A locked device is not asked to *prove* it is unreadable — it simply is not opened. This is the
   * closer case: another key, which is what another member of the household has.
   */
  it('opens empty rather than wrongly for a different key', async () => {
    const storage = new MemoryStorage()
    await openCareVault(1, { kind: 'sealed', key: await aKey() }, storage)
    writeVault((cur) => ({ ...cur, entries: { baby: [entry(7)] } }))
    await flushCareVault()

    closeCareVault()
    await openCareVault(1, { kind: 'sealed', key: await aKey() }, storage)

    expect(readVault().entries).toEqual({})
  })

  /* Two members, one panel: neither profile's blob is the other's to open. */
  it('keeps each profile to itself', async () => {
    const storage = new MemoryStorage()
    const oneKey = await aKey()
    await openCareVault(1, { kind: 'sealed', key: oneKey }, storage)
    writeVault((cur) => ({ ...cur, entries: { baby: [entry(7)] } }))
    await flushCareVault()

    await openCareVault(2, { kind: 'sealed', key: await aKey() }, storage)
    expect(readVault().entries).toEqual({})

    await openCareVault(1, { kind: 'sealed', key: oneKey }, storage)
    expect(readVault().entries.baby).toHaveLength(1)
  })
})

describe('closing versus erasing', () => {
  /*
   * The distinction the offline work turns on. A lock means "not proven right now"; it does not
   * mean the household is finished with the record, and treating the two alike is what threw away a
   * night's log on every idle timeout.
   */
  it('leaves the sealed blob behind when the panel merely locks', async () => {
    const storage = new MemoryStorage()
    const key = await aKey()
    await openCareVault(1, { kind: 'sealed', key }, storage)
    writeVault((cur) => ({ ...cur, pending: [{ clientKey: 'k' }] as never }))
    await flushCareVault()

    closeCareVault()

    expect(isCareVaultOpen()).toBe(false)
    expect(readVault().pending).toEqual([])
    expect(storage.getItem('homehub.care.vault.v1.1')).not.toBeNull()

    await openCareVault(1, { kind: 'sealed', key }, storage)
    expect(readVault().pending).toHaveLength(1)
  })

  it('takes every profile with it when the household signs out', async () => {
    const storage = new MemoryStorage()
    await openCareVault(1, { kind: 'sealed', key: await aKey() }, storage)
    writeVault((cur) => ({ ...cur, entries: { baby: [entry(7)] } }))
    await flushCareVault()
    await openCareVault(2, { kind: 'sealed', key: await aKey() }, storage)
    writeVault((cur) => ({ ...cur, entries: { baby: [entry(8)] } }))
    await flushCareVault()

    clearCareVault(storage)

    expect([...storage.values.keys()]).toEqual([])
  })

  /* A closed vault remembers nothing, so no screen can read records out of a locked panel. */
  it('answers empty while closed and refuses writes', () => {
    expect(isCareVaultOpen()).toBe(false)
    writeVault((cur) => ({ ...cur, pending: [{ clientKey: 'k' }] as never }))
    expect(readVault().pending).toEqual([])
  })
})

describe('the seal that is not sealed', () => {
  /*
   * The case that is easy to get wrong: a profile that *has* a PIN reached an unlocked panel
   * without typing it. There is no key, so the records must not be written down at all — writing
   * them in the clear would undo the sealing for exactly the profile that asked for it.
   */
  it('writes nothing at all for a session holding no key', async () => {
    const storage = new MemoryStorage()
    await openCareVault(1, { kind: 'memory' }, storage)

    writeVault((cur) => ({ ...cur, entries: { baby: [entry(7)] } }))
    await flushCareVault()

    expect(readVault().entries.baby).toHaveLength(1)
    expect(storage.getItem('homehub.care.vault.v1.1')).toBeNull()
  })

  it('does not read a sealed blob back into a keyless session', async () => {
    const storage = new MemoryStorage()
    const key = await aKey()
    await openCareVault(1, { kind: 'sealed', key }, storage)
    writeVault((cur) => ({ ...cur, entries: { baby: [entry(7)] } }))
    await flushCareVault()

    await openCareVault(1, { kind: 'memory' }, storage)

    expect(readVault().entries).toEqual({})
    // And it is still there for the next session that does hold the key.
    await openCareVault(1, { kind: 'sealed', key }, storage)
    expect(readVault().entries.baby).toHaveLength(1)
  })
})

describe('damage', () => {
  it('starts empty on a blob it cannot parse rather than failing to render', async () => {
    const storage = new MemoryStorage()
    storage.setItem('homehub.care.vault.v1.1', 'not a vault at all')

    await openCareVault(1, { kind: 'sealed', key: await aKey() }, storage)

    expect(isCareVaultOpen()).toBe(true)
    expect(readVault().entries).toEqual({})
  })

  /* The plaintext keys of the build this replaces, removed rather than carried forward. */
  it('clears the old unencrypted store on the way in', async () => {
    const storage = new MemoryStorage()
    for (const key of [
      'homehub.care.cache.v1', 'homehub.care.cache.v1.summary',
      'homehub.care.pending.v1', 'homehub.care.timers.v1',
    ]) storage.setItem(key, 'private')
    storage.setItem('unrelated', 'keep')

    await openCareVault(1, { kind: 'sealed', key: await aKey() }, storage)

    expect([...storage.values.keys()]).toEqual(['unrelated'])
  })
})

/**
 * The no-PIN profile's blob, which a previous build wrote in the clear.
 *
 * Two things have to be true and the second is the one worth a test: the store must not hand a
 * plaintext record to a sealed session, and it must not leave it sitting there either. Re-sealing it
 * would be the tempting third option and is refused — see `openCareVault`.
 */
describe('the plaintext vault a previous build left behind', () => {
  const legible = JSON.stringify({
    entries: { baby: [entry(7)] }, summary: {}, pending: [], timers: [],
  })

  it('does not read it back, and does not leave it on the device', async () => {
    const storage = new MemoryStorage()
    storage.setItem('homehub.care.vault.v1.1', legible)

    await openCareVault(1, { kind: 'sealed', key: await aKey() }, storage)

    expect(readVault().entries).toEqual({})
    expect(storage.getItem('homehub.care.vault.v1.1')).toBeNull()
  })

  /*
   * The distinction the erasure turns on. A sealed blob that will not open is somebody's log waiting
   * for the right key — a PIN changed on another device, a key not yet loaded — and destroying it
   * would be the purge-on-lock behaviour this whole store exists to replace.
   */
  it('leaves a sealed blob it cannot open exactly where it is', async () => {
    const storage = new MemoryStorage()
    await openCareVault(1, { kind: 'sealed', key: await aKey() }, storage)
    writeVault((cur) => ({ ...cur, entries: { baby: [entry(7)] } }))
    await flushCareVault()
    const sealed = storage.getItem('homehub.care.vault.v1.1')

    await openCareVault(1, { kind: 'sealed', key: await aKey() }, storage)

    expect(readVault().entries).toEqual({})
    expect(storage.getItem('homehub.care.vault.v1.1')).toBe(sealed)
  })
})
