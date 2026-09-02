/**
 * The client half of the identity boundary: which network operations may run before the server has
 * confirmed who is asking.
 *
 * <b>Deny by default, and exact.</b> The first version of this matched a list of path prefixes, which
 * looked adequate and was not: `startsWith('/profiles')` admitted `POST /profiles`,
 * `PUT /profiles/{id}`, `DELETE /profiles/{id}`, `/profiles/{id}/pin` and `/profiles/{id}/lock` — so
 * an unlocked-but-unconfirmed panel could create members, change roles and set PINs. The picker
 * needing to read the roster before anybody signs in does not license writing to it, and a prefix
 * cannot tell those apart.
 *
 * So the unit of authorisation is a **method and an exact path**, both normalised. A query string
 * cannot widen it, a trailing slash cannot dodge it, and a descendant route is a different operation
 * that has to be listed on its own or be refused.
 *
 * <b>Why a module of its own.</b> `client.ts` holds the JSON helper, `writeQueue.ts` has its own
 * durable transport with abort and drain semantics that must not be routed through that helper, and
 * `speech.ts` streams audio. All three need the same answer to the same question, and none of them
 * should be importing another's transport to get it.
 */

/** Thrown instead of opening a connection. Never carries a response, because there was not one. */
export class PrivateNetworkError extends Error {
  constructor(operation: string) {
    super(`Refused before the network: ${operation} needs a confirmed session.`)
    this.name = 'PrivateNetworkError'
  }
}

/**
 * The operations a panel may perform before its identity is confirmed, as `METHOD /path`.
 *
 * <b>Every entry needs a reason that is true before authentication.</b>
 *
 * `GET /profiles/picker` — the picker draws the roster before anybody has signed in; there is no way
 * to offer a sign-in without it. It carries an id, a name, an initial and whether a keypad is
 * needed. <b>It is deliberately not `GET /profiles`</b>, which was on this list and returned the full
 * shape: role, PIN presence, idle-lock and persistent-login policy and display order — a map of who
 * to attack and how well they are defended, handed to anyone who could reach the panel. That
 * endpoint is authenticated now.
 *
 * `GET /session` — "is this device signed in", which has to be answerable when the answer is no.
 *
 * `POST /session` — signing in. This *is* the confirmation step; gating it would make the boundary
 * unopenable.
 *
 * `DELETE /session` — signing out, including recovering from a stale session. A panel that cannot
 * sign out of a session it cannot use is stuck.
 *
 * <b>Health and build are deliberately absent</b>, and were dead entries in the list this replaces.
 * Nothing routes them through an authorised transport: `ConnectionProvider` fetches `/api/health`
 * and `UpdateProvider` fetches `/build.json` directly, both unauthenticated by design and both
 * required to work on a panel where every private feed is gone.
 */
const PRE_CONFIRMATION_OPERATIONS: ReadonlySet<string> = new Set([
  'GET /profiles/picker',
  'GET /session',
  'POST /session',
  'DELETE /session',
])

/**
 * A path reduced to the thing being authorised.
 *
 * Query and fragment are dropped: `?location=Fridge` selects data, it does not name a different
 * operation, and letting it participate would mean `/profiles?x=1` had to be reasoned about
 * separately from `/profiles`. A trailing slash is dropped for the same reason — `/session/` is not
 * a second endpoint, and treating it as one is how a deny-list gets walked around.
 */
export function normalisePath(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0] ?? ''
  const trimmed = withoutQuery.length > 1 && withoutQuery.endsWith('/')
    ? withoutQuery.slice(0, -1)
    : withoutQuery
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

/** `GET` when unstated, which is what `fetch` does. */
export function normaliseMethod(method: string | undefined): string {
  return (method ?? 'GET').toUpperCase()
}

/** Whether this exact operation is one of the few that may precede confirmation. */
export function isPreConfirmationOperation(method: string | undefined, path: string): boolean {
  return PRE_CONFIRMATION_OPERATIONS.has(`${normaliseMethod(method)} ${normalisePath(path)}`)
}

/**
 * Whether the server has confirmed the caller's identity and security version.
 *
 * Module-level rather than a hook, because the callers are not all components: a durable write queue
 * and an audio stream need the same answer. `SessionProvider` owns the value and nothing else may
 * set it.
 */
let confirmed = false

/**
 * Called by `SessionProvider` when confirmation is gained or lost.
 *
 * <b>Lost matters as much as gained.</b> A lock, a sign-out, an expired cookie or a profile switch
 * all close the boundary again, and the finding this exists to close was precisely that requests
 * outlived the identity they were issued for.
 */
export function setPrivateNetworkConfirmed(next: boolean): void {
  confirmed = next
}

export function isPrivateNetworkConfirmed(): boolean {
  return confirmed
}

/** Whether this operation may run right now — confirmed, or one of the few that need not be. */
export function isPrivateNetworkAllowed(method: string | undefined, path: string): boolean {
  return confirmed || isPreConfirmationOperation(method, path)
}

/**
 * The one way to reach an authenticated HomeHub endpoint.
 *
 * <b>A single primitive rather than a check at each call site.</b> Checks at call sites are a rule
 * somebody has to remember; this is a rule they have to circumvent. A future caller that reaches for
 * `fetch` directly is refused by not being here at all, rather than by being forgotten.
 *
 * Prefixes `/api` so callers name operations the way the policy does, and so a caller cannot
 * accidentally authorise a different origin.
 */
export async function authorizedFetch(path: string, init?: RequestInit): Promise<Response> {
  const method = normaliseMethod(init?.method)
  if (!isPrivateNetworkAllowed(method, path)) {
    throw new PrivateNetworkError(`${method} ${normalisePath(path)}`)
  }
  return fetch(`/api${path}`, {
    // Since AUDIT A1 the session cookie is what authorises every one of these, so "cookies travel"
    // stopped being an incidental property of relative fetches and became what the API depends on.
    credentials: 'same-origin',
    ...init,
  })
}
