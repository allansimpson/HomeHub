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


/**
 * The reconnect regression: a panel coming back from device-only starts no private request until the
 * server has said who is asking.
 *
 * <b>Written as a sequence rather than as states, because the defect was a sequence.</b> Asserting
 * "refused while unconfirmed" and "allowed once confirmed" separately would both pass against a
 * build that opened the boundary a moment early — and a moment early is the entire finding: the
 * window where a request begun under the old identity lands under the new one's cookie.
 */
describe('coming back from device-only', () => {
  it('starts nothing private until identity is confirmed, then starts everything', async () => {
    setPrivateNetworkConfirmed(false)
    const calls = stubSilentFetch()

    // Out of range and unlocked against the device. The panel believes it knows who this is; nothing
    // has agreed with it.
    await Promise.allSettled([api.getUpcoming(7), api.getPantry(), api.getTasks()])
    expect(calls.map((c) => c.url)).toHaveLength(0)

    // The connection returns. Only the calls confirmation itself needs may run — and they are what
    // opens the boundary, so gating them would make it unopenable.
    void api.getSession()
    expect(calls).toHaveLength(1)

    // The server has answered and `SessionProvider` has agreed the identity and its security version.
    setPrivateNetworkConfirmed(true)
    void api.getUpcoming(7)
    expect(calls).toHaveLength(2)
  })

  it('shuts again the moment confirmation is withdrawn, mid-flight or not', async () => {
    setPrivateNetworkConfirmed(true)
    const calls = stubSilentFetch()

    void api.getUpcoming(7)
    expect(calls).toHaveLength(1)

    // A lock, a sign-out, an expired cookie, or a confirmation that came back as somebody else. The
    // call already in flight is somebody else's problem — a response nobody is mounted to receive —
    // but no *new* one may start.
    setPrivateNetworkConfirmed(false)
    await Promise.allSettled([api.getUpcoming(7), api.getPantry()])

    expect(calls).toHaveLength(1)
  })
})


/**
 * Every authenticated network path is behind the boundary, including the ones that do not go through
 * the JSON helper.
 *
 * <b>These are the paths the first version missed.</b> Assist streaming, Assist cancellation and the
 * house voice each called `fetch` directly — reasonably, since each needs streaming, a fire-and-forget
 * POST, or audio rather than JSON — and each therefore sat outside a boundary that looked complete.
 * The proof each test makes is not "the call failed" but "no call was made".
 */
describe('the raw-transport call sites', () => {
  it('starts no Assist stream while unconfirmed', async () => {
    setPrivateNetworkConfirmed(false)
    const calls = stubSilentFetch()

    await api.streamAssistTurn({ text: 'hello' } as never, {} as never).catch(() => {})

    expect(calls).toHaveLength(0)
  })

  it('sends no Assist cancellation while unconfirmed', async () => {
    setPrivateNetworkConfirmed(false)
    const calls = stubSilentFetch()

    // Fire-and-forget by design, so this must not throw at the call site either — a Stop that
    // explodes is worse than one that quietly has nothing to cancel.
    await Promise.resolve(api.cancelAssistTurn('turn-1')).catch(() => {})

    expect(calls).toHaveLength(0)
  })

  it('refuses the profile writes the prefix allowlist used to admit', async () => {
    setPrivateNetworkConfirmed(false)
    const calls = stubSilentFetch()

    // Each of these was reachable before confirmation under `startsWith('/profiles')`: creating a
    // member, renaming or re-roling one, deleting one, and setting or clearing a PIN.
    await Promise.allSettled([
      api.createProfile('Intruder', 'I'),
      api.updateProfile(1, { role: 'Admin' } as never),
      api.deleteProfile(1),
      api.setPin(1, '0000'),
      api.clearPin(1),
    ])

    expect(calls).toHaveLength(0)
  })

  it('still lets the picker read the roster, which is why the list exists at all', () => {
    setPrivateNetworkConfirmed(false)
    const calls = stubSilentFetch()

    void api.listProfiles()

    expect(calls).toHaveLength(1)
  })
})
