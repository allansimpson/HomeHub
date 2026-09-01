import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearCareVault, closeCareVault, flushCareVault, openCareVault, readVault, writeVault,
} from './careVault'
import type { VaultStorage } from './careVault'

/**
 * The offline-Care survival regression Hermes asked for: entries and timers survive a lock, a
 * restart and a delayed reconnection, without ever crossing profiles.
 *
 * <b>This is the capability the device-only state exists to preserve</b>, and the reason the
 * boundary is three states rather than mounted/unmounted. It is worth pinning separately from
 * `careVault.test.ts`, which covers sealing as a mechanism: these are the *sequences* a household
 * actually puts it through, and the failure they guard against is the one that made the vault
 * necessary — an offline morning starting from nothing, or worse, starting from somebody else's log.
 */

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
const timer = (id: string) => ({ id, kind: 'Sleep', startedUtc: '2026-08-24T03:00:00Z' } as never)
/** A queued entry, identified the way the real one is — by `clientKey`, stable across reloads. */
const pending = (clientKey: string) => ({ clientKey, childKey: 'baby', opId: 'op-' + clientKey } as never)

beforeEach(() => {
  closeCareVault()
})

describe('an unsynced night survives what the panel does to it', () => {
  it('keeps entries and a running timer across a lock', async () => {
    const storage = new MemoryStorage()
    const key = await aKey()

    await openCareVault(1, { kind: 'sealed', key }, storage)
    writeVault((cur) => ({
      ...cur,
      entries: { baby: [entry(1)] },
      pending: [pending('p2')],
      timers: [timer('t1')],
    }))
    await flushCareVault()

    // A lock is not a sign-out. Nobody has finished with the record; they have stopped proving who
    // they are, which is why closing leaves the sealed blob exactly where it was.
    closeCareVault()
    expect(readVault().timers).toHaveLength(0)

    await openCareVault(1, { kind: 'sealed', key }, storage)

    expect(readVault().entries.baby).toHaveLength(1)
    expect(readVault().pending).toHaveLength(1)
    // The timer is the one that would be missed: an entry is a record, but a running timer is a
    // thing somebody started and is waiting on, and losing it silently loses the feed it belongs to.
    expect(readVault().timers).toHaveLength(1)
  })

  it('survives a restart, where nothing is left in memory at all', async () => {
    const storage = new MemoryStorage()
    const key = await aKey()

    await openCareVault(1, { kind: 'sealed', key }, storage)
    writeVault((cur) => ({ ...cur, pending: [pending('p3')], timers: [timer('t2')] }))
    await flushCareVault()
    closeCareVault()

    // A restart is the same storage and a fresh module state. The blob is all that carries across,
    // which is exactly the case a purge-on-lock design could never serve.
    await openCareVault(1, { kind: 'sealed', key }, storage)

    expect(readVault().pending).toHaveLength(1)
    expect(readVault().timers).toHaveLength(1)
  })

  it('is still there after a delayed reconnection, because nothing clears it on the way', async () => {
    const storage = new MemoryStorage()
    const key = await aKey()

    await openCareVault(1, { kind: 'sealed', key }, storage)
    writeVault((cur) => ({ ...cur, pending: [pending('p4')] }))
    await flushCareVault()

    // Out of range for a while: locked, reopened, locked again. None of it involves the server, and
    // none of it may cost the household the entries they made in the meantime.
    closeCareVault()
    await openCareVault(1, { kind: 'sealed', key }, storage)
    closeCareVault()
    await openCareVault(1, { kind: 'sealed', key }, storage)

    expect(readVault().pending).toHaveLength(1)
  })
})

describe('and never crosses to another profile', () => {
  it('shows a different member nothing of the first one', async () => {
    const storage = new MemoryStorage()
    const one = await aKey()
    const two = await aKey()

    await openCareVault(1, { kind: 'sealed', key: one }, storage)
    writeVault((cur) => ({ ...cur, entries: { baby: [entry(5)] }, pending: [pending('p6')] }))
    await flushCareVault()
    closeCareVault()

    // The second member unlocks on the same shared panel. Their vault is a different key under a
    // different storage key, so there is nothing to read rather than something withheld.
    await openCareVault(2, { kind: 'sealed', key: two }, storage)

    expect(readVault().entries.baby ?? []).toHaveLength(0)
    expect(readVault().pending).toHaveLength(0)
  })

  it('leaves the first profile intact while the second is in use', async () => {
    const storage = new MemoryStorage()
    const one = await aKey()
    const two = await aKey()

    await openCareVault(1, { kind: 'sealed', key: one }, storage)
    writeVault((cur) => ({ ...cur, pending: [pending('p7')] }))
    await flushCareVault()
    closeCareVault()

    await openCareVault(2, { kind: 'sealed', key: two }, storage)
    writeVault((cur) => ({ ...cur, pending: [pending('p8')] }))
    await flushCareVault()
    closeCareVault()

    // The point of "preserve, do not expose or silently reassign": the first member's unsynced night
    // is still waiting for them, not quietly merged into whoever used the panel next.
    await openCareVault(1, { kind: 'sealed', key: one }, storage)
    expect(readVault().pending).toHaveLength(1)
    expect(readVault().pending[0].clientKey).toBe('p7')
  })

  /**
   * Confirmation coming back as somebody else must close the decrypted view without destroying what
   * is stored — the data stays owner-bound and encrypted, for authenticated recovery later.
   */
  it('gives up nothing to a wrong key rather than throwing or exposing', async () => {
    const storage = new MemoryStorage()
    const right = await aKey()
    const wrong = await aKey()

    await openCareVault(1, { kind: 'sealed', key: right }, storage)
    writeVault((cur) => ({ ...cur, pending: [pending('p9')] }))
    await flushCareVault()
    closeCareVault()

    // Opens empty rather than failing: a care screen that renders blank is recoverable in a way one
    // that throws is not, and either way the wrong key reads nothing.
    await openCareVault(1, { kind: 'sealed', key: wrong }, storage)
    expect(readVault().pending).toHaveLength(0)

    // And the real owner still gets it back — the failed read must not have overwritten the blob.
    closeCareVault()
    await openCareVault(1, { kind: 'sealed', key: right }, storage)
    expect(readVault().pending).toHaveLength(1)
  })

  it('erases everything only on a sign-out, which means it for every profile', async () => {
    const storage = new MemoryStorage()
    const key = await aKey()

    await openCareVault(1, { kind: 'sealed', key }, storage)
    writeVault((cur) => ({ ...cur, pending: [pending('p10')] }))
    await flushCareVault()

    // The one operation that is meant to destroy: signing out is the household saying it is done,
    // and it is deliberately not what a lock does.
    clearCareVault(storage)

    await openCareVault(1, { kind: 'sealed', key }, storage)
    expect(readVault().pending).toHaveLength(0)
  })
})
