import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api, setPrivateNetworkConfirmed } from './client'

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

beforeEach(() => {
  // These tests are about the deadline, not the identity boundary, so the boundary is opened for
  // them. Left closed they never reach `fetch` at all — which is the boundary working, and would
  // make every deadline assertion pass for the wrong reason.
  setPrivateNetworkConfirmed(true)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  // Closed again between tests: the default state of a fresh panel is unconfirmed, and a test that
  // leaked it open would hide exactly the regression this exists to catch.
  setPrivateNetworkConfirmed(false)
})

/**
 * No private request may start before the server has said who is signed in.
 *
 * The reconnect regression Hermes asked for. The failure it guards against is not a call that
 * returns the wrong data — it is a call that *starts* while the panel is device-only or
 * mid-transition, and lands after the cookie has been replaced.
 */
describe('the identity boundary', () => {
  it('refuses a private call before confirmation, without reaching the network', () => {
    setPrivateNetworkConfirmed(false)
    const calls = stubSilentFetch()

    return api.getUpcoming(7).then(
      () => { throw new Error('the call should have been refused') },
      (err) => {
        expect(err).toBeInstanceOf(ApiError)
        // Status 0, the same as a refused connection: every caller already handles that, so an
        // unconfirmed panel degrades exactly as an unreachable one rather than needing eleven
        // providers to learn a new failure mode.
        expect((err as ApiError).status).toBe(0)
        expect(calls).toHaveLength(0)
      },
    )
  })

  it('still allows the calls confirmation itself depends on', () => {
    setPrivateNetworkConfirmed(false)
    const calls = stubSilentFetch()

    // Gating these would make the boundary unopenable: the picker draws before anybody signs in, and
    // asking "who am I" is how the panel finds out it may open the boundary at all.
    void api.getSession()
    void api.listProfiles()

    expect(calls).toHaveLength(2)
  })

  it('closes again when confirmation is lost', () => {
    setPrivateNetworkConfirmed(true)
    setPrivateNetworkConfirmed(false)
    const calls = stubSilentFetch()

    // A lock, a sign-out, an expired cookie or a profile switch all close it. Losing confirmation
    // matters as much as gaining it — the whole finding was requests outliving their identity.
    return api.getUpcoming(7).catch(() => {
      expect(calls).toHaveLength(0)
    })
  })
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
