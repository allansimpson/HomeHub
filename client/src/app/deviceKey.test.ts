import { beforeEach, describe, expect, it } from 'vitest'
import { clearDeviceKeys, deviceKeyFor, memoryDeviceKeyBackend } from './deviceKey'
import type { DeviceKeyBackend } from './deviceKey'

/**
 * The key a profile with no PIN seals its records under — HH-05.
 *
 * The claim being tested is narrow and worth stating exactly: what the device holds is a key the
 * browser will *use* and will not hand over. That is what separates this from writing a base64 key
 * beside the ciphertext it opens, which is the shape the finding required it not to be.
 *
 * The node harness has WebCrypto and no IndexedDB, which is the same shape as the degraded browser
 * this has to survive — so the injected backend serves both purposes.
 */

let backend: DeviceKeyBackend

beforeEach(() => {
  backend = memoryDeviceKeyBackend()
})

describe('the key itself', () => {
  it('cannot be exported, so storage yields a handle and not a secret', async () => {
    const key = await deviceKeyFor(1, backend)

    expect(key).not.toBeNull()
    expect(key!.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('raw', key!)).rejects.toThrow()
  })

  it('seals and opens, which is the only thing it is for', async () => {
    const key = await deviceKeyFor(1, backend)
    const iv = crypto.getRandomValues(new Uint8Array(12))

    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key!, new TextEncoder().encode('Bottle 120ml'),
    )
    const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key!, sealed)

    expect(new TextDecoder().decode(opened)).toBe('Bottle 120ml')
  })
})

describe('per profile, and stable', () => {
  it('returns the same key on every ask, so a sealed blob keeps opening', async () => {
    const first = await deviceKeyFor(1, backend)
    const second = await deviceKeyFor(1, backend)

    expect(second).toBe(first)
  })

  /*
   * Two callers inside one tick — a boot read and an unlock both reaching for the key — must get the
   * same one. Two unserialised generates would each mint a key, the second would overwrite the first,
   * and whichever blob had been sealed under the loser would silently stop opening.
   */
  it('gives concurrent askers one key rather than racing two into existence', async () => {
    const [a, b, c] = await Promise.all([
      deviceKeyFor(1, backend), deviceKeyFor(1, backend), deviceKeyFor(1, backend),
    ])

    expect(b).toBe(a)
    expect(c).toBe(a)
  })

  it('gives two profiles two keys, so one cannot open the other\'s records', async () => {
    const mine = await deviceKeyFor(1, backend)
    const theirs = await deviceKeyFor(2, backend)
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, mine!, new TextEncoder().encode('private'),
    )

    await expect(
      crypto.subtle.decrypt({ name: 'AES-GCM', iv }, theirs!, sealed),
    ).rejects.toThrow()
  })
})

describe('forgetting', () => {
  it('drops one profile\'s key and leaves the others', async () => {
    const mine = await deviceKeyFor(1, backend)
    const theirs = await deviceKeyFor(2, backend)

    await clearDeviceKeys(1, backend)

    expect(await deviceKeyFor(1, backend)).not.toBe(mine)
    expect(await deviceKeyFor(2, backend)).toBe(theirs)
  })

  it('drops every profile\'s key, which is what signing out means', async () => {
    const mine = await deviceKeyFor(1, backend)
    const theirs = await deviceKeyFor(2, backend)

    await clearDeviceKeys(undefined, backend)

    expect(await deviceKeyFor(1, backend)).not.toBe(mine)
    expect(await deviceKeyFor(2, backend)).not.toBe(theirs)
  })
})

/**
 * A browser that cannot hold a key at all — no IndexedDB, a private-mode window that refuses to open
 * one, a panel served over plain HTTP with no `crypto.subtle`.
 *
 * The answer is null, and every caller reads null as "this session remembers in memory only". There
 * is no path from here that ends in a private record being written out in the clear.
 */
describe('a device that cannot hold a key', () => {
  const refusing: DeviceKeyBackend = {
    get: () => Promise.reject(new Error('no store here')),
    put: () => Promise.reject(new Error('no store here')),
    remove: () => Promise.reject(new Error('no store here')),
  }

  it('answers null rather than throwing or improvising', async () => {
    expect(await deviceKeyFor(1, refusing)).toBeNull()
  })

  it('lets a clear pass quietly, since a key nobody can read is inert', async () => {
    await expect(clearDeviceKeys(1, refusing)).resolves.toBeUndefined()
  })
})
