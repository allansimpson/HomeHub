import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  armSessionLostNotice,
  authorizedOperation,
  authorizedSend,
  CREDENTIAL_REJECTED_HEADER,
  closeAndDrainPrivateNetwork,
  confirmedSubject,
  inFlightPrivateRequests,
  isPreConfirmationOperation,
  isPrivateNetworkAllowed,
  normaliseMethod,
  normalisePath,
  PrivateNetworkError,
  SESSION_LOST_EVENT,
  setPrivateNetworkConfirmed,
} from './privateNetwork'

/**
 * The pre-confirmation allowlist, which is the entire client-side identity boundary.
 *
 * <b>The version this replaces matched path prefixes, and that was the defect.</b>
 * `startsWith('/profiles')` reads as "the picker may draw the roster" and means "anything under
 * /profiles, by any method" — so an unlocked-but-unconfirmed panel could create members, change
 * roles and set PINs. Every test in the first group below passed against that build too, because
 * they only asked whether the *allowed* things were allowed.
 */

afterEach(() => {
  setPrivateNetworkConfirmed(false)
  vi.unstubAllGlobals()
})

/**
 * The request half of an operation, for assertions about what does or does not reach the network.
 *
 * Written out here rather than exported from the module on purpose. `authorizedFetch` used to be the
 * public primitive and handed a `Response` back the moment headers arrived, which is the hole H1
 * names: everything the reply caused then happened outside the transport's sight. The tests that only
 * care whether a request was *made* still want that shape, and nothing in the app may have it.
 */
const requestOnly = (path: string, init?: RequestInit) =>
  authorizedOperation(path, init, async (res) => res)

describe('what may precede confirmation', () => {
  it('allows exactly the operations that establish or inspect the session shell', () => {
    // Each of these has a reason that is true before anybody has authenticated: the picker must
    // draw, "am I signed in" must be answerable when the answer is no, and signing in and out are
    // how the boundary opens and closes.
    expect(isPreConfirmationOperation('GET', '/profiles')).toBe(true)
    expect(isPreConfirmationOperation('GET', '/session')).toBe(true)
    expect(isPreConfirmationOperation('POST', '/session')).toBe(true)
    expect(isPreConfirmationOperation('DELETE', '/session')).toBe(true)
  })

  it('defaults an unstated method to GET, as fetch does', () => {
    expect(normaliseMethod(undefined)).toBe('GET')
    expect(isPreConfirmationOperation(undefined, '/profiles')).toBe(true)
  })

  it('is case-insensitive about the method and nothing else', () => {
    expect(isPreConfirmationOperation('get', '/session')).toBe(true)
    // Paths are not lowercased: routes are case-sensitive on the server, and folding them here would
    // authorise something the server would treat as a different endpoint.
    expect(isPreConfirmationOperation('GET', '/Session')).toBe(false)
  })
})

describe('what the prefix version wrongly admitted', () => {
  /**
   * The whole reason the unit of authorisation is a method *and* an exact path. Reading the roster
   * to offer a sign-in does not license writing to it.
   */
  it('refuses every write under /profiles', () => {
    expect(isPreConfirmationOperation('POST', '/profiles')).toBe(false)
    expect(isPreConfirmationOperation('PUT', '/profiles/1')).toBe(false)
    expect(isPreConfirmationOperation('DELETE', '/profiles/1')).toBe(false)
    expect(isPreConfirmationOperation('PUT', '/profiles/1/pin')).toBe(false)
    expect(isPreConfirmationOperation('DELETE', '/profiles/1/pin')).toBe(false)
    expect(isPreConfirmationOperation('POST', '/profiles/1/lock')).toBe(false)
  })

  it('refuses the full roster, which carries the household security policy', () => {
    // H5: `GET /profiles` returns role, PIN presence, idle-lock and persistent-login policy and
    // display order — a map of who to attack and how well they are defended. The picker gets four
    // fields from its own endpoint; this one is authenticated.
    expect(isPreConfirmationOperation('GET', '/profiles/detail')).toBe(false)
  })

  it('refuses a descendant merely because it shares a prefix', () => {
    // `/sessions-elsewhere` is not `/session`, and `/profiles/1` is not `/profiles`. A prefix cannot
    // tell those apart; an exact path does not have to.
    expect(isPreConfirmationOperation('GET', '/profiles/1')).toBe(false)
    expect(isPreConfirmationOperation('GET', '/sessions')).toBe(false)
    expect(isPreConfirmationOperation('GET', '/session/refresh')).toBe(false)
  })

  it('refuses an alternate method on an allowed path', () => {
    expect(isPreConfirmationOperation('PUT', '/session')).toBe(false)
    expect(isPreConfirmationOperation('PATCH', '/profiles')).toBe(false)
  })
})

describe('normalisation cannot be used to widen authorisation', () => {
  it('ignores a query string', () => {
    // A query selects data; it does not name a different operation. And it must not be able to turn
    // a denied route into an allowed one by making it *look* like a prefix match.
    expect(normalisePath('/profiles?x=1')).toBe('/profiles')
    expect(isPreConfirmationOperation('GET', '/profiles?x=1')).toBe(true)
    expect(isPreConfirmationOperation('POST', '/profiles?x=1')).toBe(false)
    expect(isPreConfirmationOperation('GET', '/pantry?location=/session')).toBe(false)
  })

  it('ignores a fragment and a trailing slash', () => {
    expect(isPreConfirmationOperation('GET', '/session#x')).toBe(true)
    expect(isPreConfirmationOperation('GET', '/session/')).toBe(true)
    // But a trailing slash cannot invent a match that was not there.
    expect(isPreConfirmationOperation('GET', '/profiles/1/')).toBe(false)
  })
})

describe('the transport primitive', () => {
  it('refuses a private operation before opening a connection', async () => {
    const fetched = vi.fn()
    vi.stubGlobal('fetch', fetched)

    await expect(requestOnly('/pantry')).rejects.toBeInstanceOf(PrivateNetworkError)
    // The claim is not "the request failed" — it is that no request was made.
    expect(fetched).not.toHaveBeenCalled()
  })

  it('lets an allowed operation through, and prefixes /api', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(url); return new Response('[]') }))

    await requestOnly('/profiles')

    // Prefixed here rather than by each caller, so a caller cannot accidentally authorise a
    // different origin by naming a full URL.
    expect(urls).toEqual(['/api/profiles'])
  })

  it('opens for everything once confirmed, and shuts again when confirmation is lost', async () => {
    const fetched = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetched)

    setPrivateNetworkConfirmed(true)
    await requestOnly('/pantry')
    expect(fetched).toHaveBeenCalledOnce()

    // A lock, a sign-out, an expired cookie, or a confirmation that came back as somebody else.
    setPrivateNetworkConfirmed(false)
    await expect(requestOnly('/pantry')).rejects.toBeInstanceOf(PrivateNetworkError)
    expect(fetched).toHaveBeenCalledOnce()
  })

  it('agrees with the predicate, so neither can drift from the other', () => {
    setPrivateNetworkConfirmed(false)
    expect(isPrivateNetworkAllowed('GET', '/profiles')).toBe(true)
    expect(isPrivateNetworkAllowed('GET', '/profiles/detail')).toBe(false)
    setPrivateNetworkConfirmed(true)
    expect(isPrivateNetworkAllowed('POST', '/profiles')).toBe(true)
  })
})


/**
 * A 401 on any authenticated path closes the session boundary — H4.
 *
 * <b>Three of the four authenticated transports used to skip this.</b> The JSON helper announced a
 * lost session; Assist streaming did not, Assist cancellation swallowed every response and every
 * error, and server TTS read a 401 as "TTS is not configured" and fell back to the browser voice. A
 * panel whose cookie had expired could keep a stream open, cancel into the void, and go on talking,
 * while the privacy transition a lost session is meant to trigger never happened.
 *
 * Asserted at the transport because that is the only place all four meet. A rule at each call site is
 * one three of them had already failed to follow.
 */
describe('a 401 closes the session boundary', () => {
  /**
   * The harness is Node and has no `window`, so one is stubbed.
   *
   * An `EventTarget` rather than a mock: the announcement is a real DOM event with a real listener,
   * so "was it announced" is answered by the same mechanism `SessionProvider` uses to hear it, not by
   * a spy agreeing with the code that called it.
   */
  const listen = () => {
    const target = new EventTarget()
    vi.stubGlobal('window', target)
    const seen: Event[] = []
    const onLost = (e: Event) => seen.push(e)
    target.addEventListener(SESSION_LOST_EVENT, onLost)
    return { seen, stop: () => target.removeEventListener(SESSION_LOST_EVENT, onLost) }
  }

  it('announces on an authenticated 401, whatever the transport', async () => {
    setPrivateNetworkConfirmed(true)
    armSessionLostNotice()
    const { seen, stop } = listen()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))

    // The Assist stream's own path — one of the three that used to say nothing.
    await requestOnly('/assist/chat/stream', { method: 'POST' })

    expect(seen).toHaveLength(1)
    stop()
  })

  it('says it once per outage, not once per request', async () => {
    setPrivateNetworkConfirmed(true)
    armSessionLostNotice()
    const { seen, stop } = listen()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))

    // A page-load storm of 401s is one lost session, not twenty.
    await requestOnly('/pantry')
    await requestOnly('/tasks')
    await requestOnly('/voice/speak', { method: 'POST' })

    expect(seen).toHaveLength(1)
    stop()
  })

  it('stays quiet for a wrong PIN, which says nothing about the session', async () => {
    setPrivateNetworkConfirmed(true)
    armSessionLostNotice()
    const { seen, stop } = listen()
    // The server marks its own credential refusals. Both of these are somebody typing four wrong
    // digits, and neither says anything about the cookie that carried the request.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', {
      status: 401, headers: { [CREDENTIAL_REJECTED_HEADER]: 'credential-rejected' },
    })))

    await requestOnly('/session', { method: 'POST' })
    await requestOnly('/profiles/1/pin', { method: 'PUT' })

    expect(seen).toHaveLength(0)
    stop()
  })

  /*
   * HH-03. The PIN-management routes used to be excused by path and method alone, so the two
   * different things they answer 401 about were treated as one.
   *
   * A member changing their PIN on a panel whose cookie has expired is the ordinary way to reach
   * this: the request is refused for the session, not for the digits, and the excuse meant nothing
   * noticed. The panel stayed unlocked over the household's private screens with no session behind
   * them, because the first call to find out happened to be the one route told not to care.
   */
  it('announces an unmarked 401 from a PIN route, which is a lost session and not a wrong PIN', async () => {
    setPrivateNetworkConfirmed(true)
    armSessionLostNotice()
    const { seen, stop } = listen()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))

    await requestOnly('/profiles/1/pin', { method: 'PUT' })

    expect(seen).toHaveLength(1)
    stop()
  })

  it('announces an unmarked 401 from sign-in too, rather than trusting the path', async () => {
    setPrivateNetworkConfirmed(true)
    armSessionLostNotice()
    const { seen, stop } = listen()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))

    await requestOnly('/session', { method: 'POST' })

    expect(seen).toHaveLength(1)
    stop()
  })

  it('reads the marker case-insensitively and refuses anything else as a mark', async () => {
    setPrivateNetworkConfirmed(true)
    armSessionLostNotice()
    const { seen, stop } = listen()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response('', {
      status: 401,
      // A value that is not the agreed one is not a mark. Fail-closed: the boundary closes.
      headers: { [CREDENTIAL_REJECTED_HEADER]: url.includes('bogus') ? 'something-else' : 'Credential-Rejected' },
    })))

    await requestOnly('/session', { method: 'POST' })
    expect(seen).toHaveLength(0)

    await requestOnly('/bogus', { method: 'POST' })
    expect(seen).toHaveLength(1)
    stop()
  })

  it('announces for a send with no body read, which is the cancel path', async () => {
    setPrivateNetworkConfirmed(true)
    armSessionLostNotice()
    const { seen, stop } = listen()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))

    await authorizedSend('/assist/chat/turns/x/cancel', { method: 'POST' })

    expect(seen).toHaveLength(1)
    stop()
  })

  it('does not excuse a 401 merely because the path contains /pin', async () => {
    setPrivateNetworkConfirmed(true)
    armSessionLostNotice()
    const { seen, stop } = listen()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))

    // The old exclusion was `path.includes('/pin')`, which would have excused this. An excused 401 is
    // a session loss that never reaches the lock screen.
    await requestOnly('/pantry/pinned')

    expect(seen).toHaveLength(1)
    stop()
  })
})


/**
 * Requests are bound to the identity that authorised them, and transitions drain — H2.
 *
 * <b>A Boolean checked at the start was the gap.</b> `authorizedFetch` asked "is somebody confirmed"
 * when it began and never again, which is not the same as "the same somebody who asked for this".
 * Between a request starting and its body being read, a member can lock, sign out, switch profile or
 * be revoked — and the cookie sent with the reply is the new one.
 */
describe('subject and epoch binding', () => {
  it('names who the boundary is open for, not merely that it is', () => {
    setPrivateNetworkConfirmed(true, 7)
    expect(confirmedSubject()?.profileId).toBe(7)

    setPrivateNetworkConfirmed(false)
    expect(confirmedSubject()).toBeNull()
  })

  it('discards a reply that arrived after the identity changed', async () => {
    setPrivateNetworkConfirmed(true, 1)

    // The response resolves only once the test releases it, so the transition can be made to land in
    // the window between the request starting and its reply being handled — which is the race.
    let release!: (r: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { release = resolve })))

    const pending = requestOnly('/pantry')

    // Somebody else unlocks while it is out.
    setPrivateNetworkConfirmed(true, 2)
    release(new Response('{"secret":"first member\'s"}'))

    // Refused rather than returned, and refused before the body is read: that response was produced
    // for whoever the cookie names now.
    await expect(pending).rejects.toBeInstanceOf(PrivateNetworkError)
  })

  it('treats confirming as a transition too, because signing in also replaces the cookie', async () => {
    setPrivateNetworkConfirmed(false)
    setPrivateNetworkConfirmed(true, 1)
    const first = confirmedSubject()?.epoch

    setPrivateNetworkConfirmed(true, 1)
    expect(confirmedSubject()?.epoch).not.toBe(first)
  })
})

describe('draining a transition', () => {
  it('aborts what is in flight and waits for it to unwind', async () => {
    setPrivateNetworkConfirmed(true, 1)

    // A request that never answers on its own — the state a panel is in when it has signal but no
    // route to the house. Only the abort can end it.
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
    })))

    const pending = requestOnly('/pantry').catch(() => 'ended')
    expect(inFlightPrivateRequests()).toBe(1)

    await closeAndDrainPrivateNetwork()

    // The claim is not "abort was called" — it is that nothing is still processing when the drain
    // returns. A transition that proceeds into that gap is racing the teardown it asked for.
    expect(inFlightPrivateRequests()).toBe(0)
    expect(await pending).toBe('ended')
  })

  it('leaves the boundary shut afterwards, so nothing new starts', async () => {
    setPrivateNetworkConfirmed(true, 1)
    await closeAndDrainPrivateNetwork()
    vi.stubGlobal('fetch', vi.fn())

    await expect(requestOnly('/pantry')).rejects.toBeInstanceOf(PrivateNetworkError)
  })
})


/**
 * An authenticated operation is tracked until everything it causes has happened — HH-01.
 *
 * <b>The transport used to let go at the response headers.</b> The request left `inFlight`, its drain
 * promise settled, and a lock or a profile switch waiting on that drain was told the panel was quiet.
 * It was not: an ordinary JSON body was still being read, an Assist stream was still delivering deltas
 * and firing `onDone`, and a queued write was still classifying its answer and deciding whether to
 * stay durable — all under the identity the transition had just revoked.
 *
 * Headers are the middle of an authenticated operation. These say so.
 */
describe('the operation, not the fetch, is what a transition waits for', () => {
  /** A response whose body is released by the test, so a transition can be made to land mid-read. */
  const suspendedBody = () => {
    let release!: (text: string) => void
    const body = new Promise<string>((resolve) => { release = resolve })
    const res = {
      ok: true, status: 200, statusText: 'OK', headers: new Headers(),
      text: () => body,
    } as unknown as Response
    return { res, release }
  }

  it('stays in flight while the body is still being read', async () => {
    setPrivateNetworkConfirmed(true, 1)
    const { res, release } = suspendedBody()
    vi.stubGlobal('fetch', vi.fn(async () => res))

    const reading = authorizedOperation('/care/entries', undefined, (r) => r.text())
    // Let the fetch resolve, so the operation is past headers and into the body.
    await Promise.resolve()
    await Promise.resolve()

    // The claim: headers arriving did not end it.
    expect(inFlightPrivateRequests()).toBe(1)

    release('{"feeds":[]}')
    await reading
    expect(inFlightPrivateRequests()).toBe(0)
  })

  it('does not let a profile switch drain to empty while a body is outstanding', async () => {
    setPrivateNetworkConfirmed(true, 1)
    const { res, release } = suspendedBody()
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      // A real body read is abortable, so the drain's abort is what ends it.
      init?.signal?.addEventListener('abort', () => release(''))
      return res
    }))

    const reading = authorizedOperation('/care/entries', undefined, (r) => r.text()).catch(() => 'ended')
    await Promise.resolve()
    await Promise.resolve()
    expect(inFlightPrivateRequests()).toBe(1)

    // The transition. It must not return until the body has finished, because everything that body
    // settles into belongs to the member who is being switched away from.
    await closeAndDrainPrivateNetwork()

    expect(inFlightPrivateRequests()).toBe(0)
    expect(await reading).toBe('ended')
  })

  it('refuses a body that finished after the identity changed, before its value is handed back', async () => {
    setPrivateNetworkConfirmed(true, 1)
    const { res, release } = suspendedBody()
    vi.stubGlobal('fetch', vi.fn(async () => res))

    const reading = authorizedOperation('/care/entries', undefined, (r) => r.text())
    await Promise.resolve()
    await Promise.resolve()

    // Somebody else unlocks while the first member's body is still arriving.
    setPrivateNetworkConfirmed(true, 2)
    release('{"secret":"first member\'s"}')

    // The epoch is checked again at the last point before the value becomes the caller's, which is
    // the only place that can catch a transition landing *during* the read rather than before it.
    await expect(reading).rejects.toBeInstanceOf(PrivateNetworkError)
  })

  it('tracks a stream for its whole life, not for its first frame', async () => {
    setPrivateNetworkConfirmed(true, 1)
    let push!: (chunk: string) => void
    let finish!: () => void
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => controller.enqueue(new TextEncoder().encode(chunk))
        finish = () => controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK', headers: new Headers(), body: stream,
    } as unknown as Response)))

    const frames: string[] = []
    const streaming = authorizedOperation('/assist/chat/stream', { method: 'POST' }, async (r) => {
      const reader = r.body!.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        frames.push(decoder.decode(value))
      }
    })

    push('data: one\n\n')
    await Promise.resolve()
    await Promise.resolve()
    // A stream is the longest-lived authenticated operation this app has, and was the least covered.
    expect(inFlightPrivateRequests()).toBe(1)

    finish()
    await streaming
    expect(frames).toEqual(['data: one\n\n'])
    expect(inFlightPrivateRequests()).toBe(0)
  })
})
