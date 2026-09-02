import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  armSessionLostNotice,
  authorizedFetch,
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

describe('what may precede confirmation', () => {
  it('allows exactly the operations that establish or inspect the session shell', () => {
    // Each of these has a reason that is true before anybody has authenticated: the picker must
    // draw, "am I signed in" must be answerable when the answer is no, and signing in and out are
    // how the boundary opens and closes.
    expect(isPreConfirmationOperation('GET', '/profiles/picker')).toBe(true)
    expect(isPreConfirmationOperation('GET', '/session')).toBe(true)
    expect(isPreConfirmationOperation('POST', '/session')).toBe(true)
    expect(isPreConfirmationOperation('DELETE', '/session')).toBe(true)
  })

  it('defaults an unstated method to GET, as fetch does', () => {
    expect(normaliseMethod(undefined)).toBe('GET')
    expect(isPreConfirmationOperation(undefined, '/profiles/picker')).toBe(true)
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
    expect(isPreConfirmationOperation('GET', '/profiles')).toBe(false)
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
    expect(normalisePath('/profiles/picker?x=1')).toBe('/profiles/picker')
    expect(isPreConfirmationOperation('GET', '/profiles/picker?x=1')).toBe(true)
    expect(isPreConfirmationOperation('POST', '/profiles/picker?x=1')).toBe(false)
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

    await expect(authorizedFetch('/pantry')).rejects.toBeInstanceOf(PrivateNetworkError)
    // The claim is not "the request failed" — it is that no request was made.
    expect(fetched).not.toHaveBeenCalled()
  })

  it('lets an allowed operation through, and prefixes /api', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(url); return new Response('[]') }))

    await authorizedFetch('/profiles/picker')

    // Prefixed here rather than by each caller, so a caller cannot accidentally authorise a
    // different origin by naming a full URL.
    expect(urls).toEqual(['/api/profiles/picker'])
  })

  it('opens for everything once confirmed, and shuts again when confirmation is lost', async () => {
    const fetched = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetched)

    setPrivateNetworkConfirmed(true)
    await authorizedFetch('/pantry')
    expect(fetched).toHaveBeenCalledOnce()

    // A lock, a sign-out, an expired cookie, or a confirmation that came back as somebody else.
    setPrivateNetworkConfirmed(false)
    await expect(authorizedFetch('/pantry')).rejects.toBeInstanceOf(PrivateNetworkError)
    expect(fetched).toHaveBeenCalledOnce()
  })

  it('agrees with the predicate, so neither can drift from the other', () => {
    setPrivateNetworkConfirmed(false)
    expect(isPrivateNetworkAllowed('GET', '/profiles/picker')).toBe(true)
    expect(isPrivateNetworkAllowed('GET', '/profiles')).toBe(false)
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
    await authorizedFetch('/assist/chat/stream', { method: 'POST' })

    expect(seen).toHaveLength(1)
    stop()
  })

  it('says it once per outage, not once per request', async () => {
    setPrivateNetworkConfirmed(true)
    armSessionLostNotice()
    const { seen, stop } = listen()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))

    // A page-load storm of 401s is one lost session, not twenty.
    await authorizedFetch('/pantry')
    await authorizedFetch('/tasks')
    await authorizedFetch('/voice/speak', { method: 'POST' })

    expect(seen).toHaveLength(1)
    stop()
  })

  it('stays quiet for a wrong PIN, which says nothing about the session', async () => {
    setPrivateNetworkConfirmed(true)
    armSessionLostNotice()
    const { seen, stop } = listen()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))

    await authorizedFetch('/session', { method: 'POST' })
    await authorizedFetch('/profiles/1/pin', { method: 'PUT' })

    expect(seen).toHaveLength(0)
    stop()
  })

  it('does not excuse a 401 merely because the path contains /pin', async () => {
    setPrivateNetworkConfirmed(true)
    armSessionLostNotice()
    const { seen, stop } = listen()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))

    // The old exclusion was `path.includes('/pin')`, which would have excused this. An excused 401 is
    // a session loss that never reaches the lock screen.
    await authorizedFetch('/pantry/pinned')

    expect(seen).toHaveLength(1)
    stop()
  })
})
