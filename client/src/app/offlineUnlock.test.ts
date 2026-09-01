import { describe, expect, it } from 'vitest'
import { clearEnrolment, enrol, isEnrolled, lockoutSeconds, unlockOffline } from './offlineUnlock'

class MemoryStorage {
  readonly values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
}

/**
 * Checking a PIN with no server to ask.
 *
 * The two ways this can be wrong are both serious and point in opposite directions: admit the wrong
 * four digits and the line between two household members has stopped existing; refuse the right
 * ones and somebody is locked out of the care log at 3am, which is the failure the whole offline
 * effort exists to prevent. These pin down both edges, and the wait that sits between them.
 */

describe('enrolment', () => {
  it('opens for the PIN the server agreed to', async () => {
    const storage = new MemoryStorage()
    await enrol(1, '1234', storage)

    const result = await unlockOffline(1, '1234', storage)

    expect(result.ok).toBe(true)
  })

  it('refuses every other PIN', async () => {
    const storage = new MemoryStorage()
    await enrol(1, '1234', storage)

    expect(await unlockOffline(1, '1235', storage)).toMatchObject({ ok: false, kind: 'wrong-pin' })
  })

  /* The line between two members: one person's four digits must not open another's cache. */
  it('never opens a different profile', async () => {
    const storage = new MemoryStorage()
    await enrol(1, '1234', storage)
    await enrol(2, '9999', storage)

    expect(await unlockOffline(2, '1234', storage)).toMatchObject({ ok: false, kind: 'wrong-pin' })
    expect(await unlockOffline(1, '9999', storage)).toMatchObject({ ok: false, kind: 'wrong-pin' })
  })

  /*
   * "Nothing to check" is a different sentence from "that is wrong", and the Lock screen has to say
   * so: no amount of retyping fixes a profile that has never signed in on this device.
   */
  it('reports an unenrolled profile as such rather than as a wrong PIN', async () => {
    const storage = new MemoryStorage()

    expect(await unlockOffline(7, '1234', storage)).toMatchObject({ ok: false, kind: 'not-enrolled' })
    expect(isEnrolled(7, storage)).toBe(false)
  })

  it('hands back a key that actually decrypts what it encrypted', async () => {
    const storage = new MemoryStorage()
    const enrolled = await enrol(1, '1234', storage)
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, enrolled, new TextEncoder().encode('one bottle, 3 oz'),
    )

    const result = await unlockOffline(1, '1234', storage)
    if (!result.ok) throw new Error('expected the PIN to open')
    const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, result.key, sealed)

    expect(new TextDecoder().decode(opened)).toBe('one bottle, 3 oz')
  })

  /*
   * <b>The one that guards a silent data loss.</b> Every ordinary online sign-in re-enrols, and if
   * that minted a fresh data key each time it would re-seal the vault under something the stored
   * blob was not written with — quietly discarding the offline log, entries queued but not yet sent
   * among them. The same PIN must keep the same key.
   */
  it('keeps the same key when the same PIN enrols again', async () => {
    const storage = new MemoryStorage()
    const first = await enrol(1, '1234', storage)
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, first, new TextEncoder().encode('one bottle, 3 oz'),
    )

    const second = await enrol(1, '1234', storage)
    const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, second, sealed)

    expect(new TextDecoder().decode(opened)).toBe('one bottle, 3 oz')
  })

  /*
   * And the counterpart: a server-confirmed sign-in must not be counted as a failed attempt just
   * because the enrolment here is stale. Counting it would lock out the one person known to be
   * right.
   */
  it('does not spend an attempt when a changed PIN re-enrols', async () => {
    const storage = new MemoryStorage()
    await enrol(1, '1234', storage)
    for (let i = 0; i < 4; i += 1) await unlockOffline(1, '0000', storage)

    await enrol(1, '5678', storage)

    expect(lockoutSeconds(1, storage)).toBeNull()
    for (let i = 0; i < 4; i += 1) {
      expect(await unlockOffline(1, '0000', storage)).toMatchObject({ kind: 'wrong-pin' })
    }
  })

  /*
   * A PIN changed on another device reaches here at the next online sign-in, and the old digits have
   * to stop working at that moment rather than lingering beside the new ones.
   */
  it('replaces the old PIN when the profile enrols again', async () => {
    const storage = new MemoryStorage()
    await enrol(1, '1234', storage)
    await enrol(1, '5678', storage)

    expect(await unlockOffline(1, '1234', storage)).toMatchObject({ ok: false, kind: 'wrong-pin' })
    expect(await unlockOffline(1, '5678', storage)).toMatchObject({ ok: true })
  })

  /* The same PIN on two devices must not produce the same stored bytes. */
  it('salts each enrolment separately', async () => {
    const a = new MemoryStorage()
    const b = new MemoryStorage()
    await enrol(1, '1234', a)
    await enrol(1, '1234', b)

    expect(a.getItem('homehub.offlineunlock.v1')).not.toBe(b.getItem('homehub.offlineunlock.v1'))
  })

  it('stores neither the PIN nor anything that reads like it', async () => {
    const storage = new MemoryStorage()
    await enrol(1, '4821', storage)

    expect(storage.getItem('homehub.offlineunlock.v1')).not.toContain('4821')
  })
})

describe('the wait after wrong digits', () => {
  const at = 1_700_000_000_000

  it('lets a mistyped PIN be retyped without punishment', async () => {
    const storage = new MemoryStorage()
    await enrol(1, '1234', storage, at)

    for (let i = 0; i < 4; i += 1) {
      expect(await unlockOffline(1, '0000', storage, at)).toMatchObject({ kind: 'wrong-pin' })
    }
    expect(lockoutSeconds(1, storage, at)).toBeNull()
  })

  it('starts waiting once the free attempts are spent', async () => {
    const storage = new MemoryStorage()
    await enrol(1, '1234', storage, at)

    for (let i = 0; i < 4; i += 1) await unlockOffline(1, '0000', storage, at)
    const fifth = await unlockOffline(1, '0000', storage, at)

    expect(fifth).toMatchObject({ ok: false, kind: 'locked-out', retryAfterSeconds: 30 })
  })

  /* Persisted, or a reload would be the way around it. */
  it('keeps the wait across a reload, and refuses the right PIN while it runs', async () => {
    const storage = new MemoryStorage()
    await enrol(1, '1234', storage, at)
    for (let i = 0; i < 5; i += 1) await unlockOffline(1, '0000', storage, at)

    expect(await unlockOffline(1, '1234', storage, at + 1_000))
      .toMatchObject({ ok: false, kind: 'locked-out' })
    expect(lockoutSeconds(1, storage, at + 1_000)).toBe(29)
  })

  it('reopens on its own, and the right PIN then works', async () => {
    const storage = new MemoryStorage()
    await enrol(1, '1234', storage, at)
    for (let i = 0; i < 5; i += 1) await unlockOffline(1, '0000', storage, at)

    expect(await unlockOffline(1, '1234', storage, at + 31_000)).toMatchObject({ ok: true })
  })

  it('doubles the wait for each failure past the first', async () => {
    const storage = new MemoryStorage()
    await enrol(1, '1234', storage, at)
    for (let i = 0; i < 5; i += 1) await unlockOffline(1, '0000', storage, at)

    const sixth = await unlockOffline(1, '0000', storage, at + 31_000)

    expect(sixth).toMatchObject({ kind: 'locked-out', retryAfterSeconds: 60 })
  })

  /* A correct PIN is the end of the matter — the next mistype starts from zero again. */
  it('forgets the failures once somebody gets in', async () => {
    const storage = new MemoryStorage()
    await enrol(1, '1234', storage, at)
    for (let i = 0; i < 4; i += 1) await unlockOffline(1, '0000', storage, at)

    await unlockOffline(1, '1234', storage, at)
    for (let i = 0; i < 4; i += 1) await unlockOffline(1, '0000', storage, at)

    expect(lockoutSeconds(1, storage, at)).toBeNull()
  })
})

describe('clearing', () => {
  /* Signing out takes the data key with it, so what is left behind opens for nobody. */
  it('leaves nothing that could open the cache', async () => {
    const storage = new MemoryStorage()
    await enrol(1, '1234', storage)
    await enrol(2, '5678', storage)

    clearEnrolment(1, storage)

    expect(await unlockOffline(1, '1234', storage)).toMatchObject({ kind: 'not-enrolled' })
    expect(await unlockOffline(2, '5678', storage)).toMatchObject({ ok: true })

    clearEnrolment(undefined, storage)
    expect(await unlockOffline(2, '5678', storage)).toMatchObject({ kind: 'not-enrolled' })
  })
})
