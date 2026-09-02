import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  authorizedFetch,
  isPreConfirmationOperation,
  isPrivateNetworkAllowed,
  normaliseMethod,
  normalisePath,
  PrivateNetworkError,
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

    await expect(authorizedFetch('/pantry')).rejects.toBeInstanceOf(PrivateNetworkError)
    // The claim is not "the request failed" — it is that no request was made.
    expect(fetched).not.toHaveBeenCalled()
  })

  it('lets an allowed operation through, and prefixes /api', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(url); return new Response('[]') }))

    await authorizedFetch('/profiles')

    // Prefixed here rather than by each caller, so a caller cannot accidentally authorise a
    // different origin by naming a full URL.
    expect(urls).toEqual(['/api/profiles'])
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
    expect(isPrivateNetworkAllowed('GET', '/profiles')).toBe(true)
    expect(isPrivateNetworkAllowed('POST', '/profiles')).toBe(false)
    setPrivateNetworkConfirmed(true)
    expect(isPrivateNetworkAllowed('POST', '/profiles')).toBe(true)
  })
})
