import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  authorizedOperation, closeAndDrainPrivateNetwork, inFlightPrivateRequests,
  isPrivateNetworkAllowed, PrivateNetworkError, setPrivateNetworkConfirmed,
} from '../api/privateNetwork'
import { closePrivateStores, endSessionAuthority } from './sessionAuthority'
import { isCareVaultOpen, openCareVault } from '../screens/care/careOffline'
import { flushQueueStore, isQueueStoreOpen, openQueueStore, sealedQueueStore } from './queueStore'
import { persistAhead, setQueueIdentity } from './writeQueue'
import type { QueuedOp } from './writeQueue'
import type { QueueStorage } from './queueStore'

class MemoryStorage implements QueueStorage {
  readonly values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  get length() { return this.values.size }
}

const aKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])

const careOp = (id: string): QueuedOp => ({
  id,
  ownerProfileId: 2,
  domain: 'care',
  method: 'POST',
  path: '/care/children/1/entries',
  body: { type: 'Bottle', volumeMl: 120 },
  label: 'Bottle 120ml for Wren',
  createdAt: 10,
})

/** A response whose body the test releases by hand, so a lock can land mid-read. */
const suspendedBody = () => {
  let release!: (text: string) => void
  const body = new Promise<string>((resolve) => { release = resolve })
  return {
    res: { ok: true, status: 200, statusText: 'OK', headers: new Headers(), text: () => body } as unknown as Response,
    release: (text: string) => release(text),
  }
}

/**
 * A transition ends authority now, and lets go of the stores afterwards — RR-03.
 *
 * <b>What was wrong.</b> `lockNow` and the session-loss handler closed the vault and the queue,
 * advanced the generation, and set `locked` — and left the request layer to be closed later, by the
 * React effect watching `locked`. Between those two moments an authenticated body or Assist stream
 * that was already running kept full admission. A private result could reach state after the
 * transition that was supposed to have ended its authority, because React's commit schedule was
 * standing in for a security barrier.
 *
 * The provider cannot be rendered in this Node harness, so the ordering is tested where it now lives.
 * Each test below is the shape of the browser evidence: something suspended, a transition landing on
 * top of it, and the question of what is true in between.
 */

beforeEach(async () => {
  vi.stubGlobal('window', new EventTarget())
  closePrivateStores()
  setQueueIdentity(null)
  await closeAndDrainPrivateNetwork()
})

describe('ending authority', () => {
  it('refuses new authenticated work synchronously, before anything is awaited', async () => {
    setPrivateNetworkConfirmed(true, 2)
    expect(isPrivateNetworkAllowed('GET', '/care/entries')).toBe(true)

    // Not awaited. The claim is that admission is already shut on the next line.
    const ending = endSessionAuthority()

    expect(isPrivateNetworkAllowed('GET', '/care/entries')).toBe(false)
    await ending
  })

  it('aborts a suspended body and does not hand its result back', async () => {
    setPrivateNetworkConfirmed(true, 2)
    const { res, release } = suspendedBody()
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      // A real body read is abortable; the abort is what ends this one.
      init?.signal?.addEventListener('abort', () => release(''))
      return res
    }))

    const reading = authorizedOperation('/care/entries', undefined, (r) => r.text())
      .then(() => 'delivered', () => 'refused')
    await Promise.resolve()
    await Promise.resolve()
    expect(inFlightPrivateRequests()).toBe(1)

    await endSessionAuthority()

    expect(await reading).toBe('refused')
    expect(inFlightPrivateRequests()).toBe(0)
  })

  /*
   * The ordering that the previous version had backwards. An operation still unwinding belongs to the
   * old owner and has a durability decision left to make — a queued write deciding whether it stays
   * queued. Closing the store first strands that decision.
   */
  it('does not close the stores until what was in flight has settled', async () => {
    const storage = new MemoryStorage()
    await openQueueStore(2, await aKey(), storage)
    await openCareVault(2, { kind: 'sealed', key: await aKey() }, storage)
    setPrivateNetworkConfirmed(true, 2)

    const { res, release } = suspendedBody()
    let openWhileUnwinding: boolean | null = null
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => {
        // The moment the request is told to stop, its store must still be there to record into.
        openWhileUnwinding = isQueueStoreOpen() && isCareVaultOpen()
        release('')
      })
      return res
    }))

    const reading = authorizedOperation('/care/entries', undefined, (r) => r.text()).catch(() => undefined)
    await Promise.resolve()
    await Promise.resolve()

    await endSessionAuthority()
    await reading

    expect(openWhileUnwinding).toBe(true)
    expect(isQueueStoreOpen()).toBe(false)
    expect(isCareVaultOpen()).toBe(false)
  })

  it('closes both stores once it returns, leaving the sealed blobs behind', async () => {
    const storage = new MemoryStorage()
    const key = await aKey()
    await openQueueStore(2, key, storage)
    persistAhead(sealedQueueStore, careOp('a'))
    await flushQueueStore()
    await openCareVault(2, { kind: 'sealed', key }, storage)

    await endSessionAuthority()

    expect(isQueueStoreOpen()).toBe(false)
    expect(isCareVaultOpen()).toBe(false)
    // Closing is not erasing: the writes are still there for the next unlock.
    expect(storage.getItem('homehub.writequeue.sealed.v1.2')).not.toBeNull()
  })

  it('leaves the boundary shut, so nothing starts while the panel is locked', async () => {
    setPrivateNetworkConfirmed(true, 2)
    vi.stubGlobal('fetch', vi.fn())

    await endSessionAuthority()

    await expect(authorizedOperation('/care/entries', undefined, (r) => r.text()))
      .rejects.toBeInstanceOf(PrivateNetworkError)
  })

  /*
   * A stream is the longest-lived authenticated operation the panel has, and the one an idle lock is
   * most likely to interrupt — an Assist reply still being written while nobody is at the panel.
   */
  it('ends an Assist stream rather than letting it deliver into the next session', async () => {
    setPrivateNetworkConfirmed(true, 2)
    let push!: (chunk: string) => void
    let fail!: () => void
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (c) => controller.enqueue(new TextEncoder().encode(c))
        fail = () => controller.error(new DOMException('aborted', 'AbortError'))
      },
    })
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      // What a real `fetch` body does when its request is aborted: the stream errors and the pending
      // `read()` rejects. A hand-built `ReadableStream` has no such link, so it is wired here.
      init?.signal?.addEventListener('abort', () => fail())
      return {
        ok: true, status: 200, statusText: 'OK', headers: new Headers(), body: stream,
      } as unknown as Response
    }))

    const frames: string[] = []
    const streaming = authorizedOperation('/assist/chat/stream', { method: 'POST' }, async (r) => {
      const reader = r.body!.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        frames.push(decoder.decode(value))
      }
    }).catch(() => 'ended')

    push('data: one\n\n')
    await Promise.resolve()
    await Promise.resolve()
    expect(inFlightPrivateRequests()).toBe(1)

    await endSessionAuthority()

    expect(await streaming).toBe('ended')
    expect(frames).toEqual(['data: one\n\n'])
    expect(inFlightPrivateRequests()).toBe(0)
  })

  it('is safe to call when nothing is running, which every lock on a quiet panel is', async () => {
    await expect(endSessionAuthority()).resolves.toBeUndefined()
    await expect(endSessionAuthority()).resolves.toBeUndefined()
  })
})
