import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api } from './client'

/**
 * A server that accepts the connection and then says nothing — the state a phone is in when it has
 * signal but no route to the house.
 *
 * Not the same as a refusal: `fetch` rejects promptly when a connection is refused, and that path
 * was always handled. This one resolves nothing and rejects nothing until something aborts it.
 */
function stubSilentFetch() {
  const calls: { url: string; signal?: AbortSignal | null }[] = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, signal: init?.signal })
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })
  }))
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('the request deadline', () => {
  /*
   * <b>This is the pump panel coming back dead.</b> Every control on a running session is disabled
   * while a write is in flight, which is right; what was wrong is that the flight had no end. A
   * PAUSE sent from a phone that had left the house never resolved and never rejected, so SWITCH
   * NOW, PAUSE, FINISH and CANCEL stayed dimmed for the life of the mount — the session was on
   * screen, counting, and could not be reached at all.
   */
  it('ends a call the server never answers, as the unreachable it is', async () => {
    vi.useFakeTimers()
    stubSilentFetch()

    const pending = api.careTimer('conrad', 'Pump', 'pause')
    const settled = vi.fn()
    void pending.then(settled, settled)

    await vi.advanceTimersByTimeAsync(9_000)
    expect(settled).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2_000)
    // Status 0 is what a refused connection already raised, so every caller's existing offline
    // handling answers this without knowing the difference.
    await expect(pending).rejects.toMatchObject({ name: 'ApiError', status: 0 })
    await expect(pending).rejects.toBeInstanceOf(ApiError)
  })

  /* Reading a photo is slow because of what it does, not because anything is wrong. */
  it('leaves the model-backed calls a great deal longer', async () => {
    vi.useFakeTimers()
    stubSilentFetch()

    const pending = api.readRecipePhoto({ imageBase64: 'x', mediaType: 'image/jpeg' })
    const settled = vi.fn()
    void pending.then(settled, settled)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(settled).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(61_000)
    await expect(pending).rejects.toMatchObject({ name: 'ApiError', status: 0 })
  })
})
