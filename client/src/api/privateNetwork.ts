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

/**
 * Announced when an authenticated call is refused because the session is gone.
 *
 * An event rather than a direct call, because this module must not import a React provider;
 * `SessionProvider` listens and locks, which lands on the picker that fixes it.
 */
export const SESSION_LOST_EVENT = 'homehub:session-lost'

/** Once per outage. A page-load storm of 401s is one lost session, not twenty. */
let sessionLostAnnounced = false

/** Called once a session exists again, so the next genuine expiry is announced. */
export function armSessionLostNotice(): void {
  sessionLostAnnounced = false
}

/**
 * Signing in with the wrong PIN answers 401 and means nothing about the session that made it.
 *
 * Exact operations, for the same reason the allowlist is: `path.includes('/pin')` would excuse a 401
 * from anything with `/pin` anywhere in it, and an excused 401 is a session loss that never reaches
 * the lock screen.
 */
function isAuthenticationAttempt(method: string, path: string): boolean {
  const operation = `${method} ${normalisePath(path)}`
  return operation === 'POST /session'
    || operation === 'DELETE /session'
    || /^(PUT|DELETE) \/profiles\/\d+\/pin$/.test(operation)
}

/**
 * Every authenticated response passes through here, and a 401 on one closes the boundary.
 *
 * <b>Three of the four authenticated paths used to skip this.</b> The JSON helper announced a lost
 * session on a 401; Assist streaming did not, Assist cancellation swallowed every response and every
 * error, and server TTS read a 401 as "TTS is not configured" and quietly fell back to the browser
 * voice. So a panel whose cookie had expired could keep a stream open, cancel into the void and go on
 * speaking, while the one path that noticed was the one nobody had touched — and the privacy
 * transition a lost session is supposed to trigger never happened.
 *
 * Centralised at the transport because that is the only place all four meet. A rule at each call
 * site is one three of them had already failed to follow.
 */
function noteAuthenticatedResponse(method: string, path: string, status: number): void {
  if (status !== 401) return
  // A wrong PIN is not a lost session. Everything else that answers 401 is.
  if (isAuthenticationAttempt(method, path)) return
  if (sessionLostAnnounced) return
  sessionLostAnnounced = true
  window.dispatchEvent(new Event(SESSION_LOST_EVENT))
}

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
/**
 * The confirmed subject, and the epoch its requests belong to.
 *
 * <b>A Boolean was not enough, and the gap it left is the finding.</b> `authorizedFetch` checked one
 * module-global flag *at the moment it started* and never looked again, so a request begun under one
 * identity could land under another: the flag says "somebody is confirmed", not "the same somebody
 * who asked for this". Between a request starting and its body being read, a member can lock, sign
 * out, switch profile, or be revoked — and the cookie sent with the reply is the new one.
 *
 * The epoch advances on every one of those transitions. A request captures it when it starts and is
 * checked against it when it finishes, so a reply that outlived its identity is discarded rather than
 * handed to a caller who will render it.
 */
let subject: { profileId: number | null; epoch: number } | null = null

/** Advanced by every transition. Never reused, so a stale capture can only ever mismatch. */
let currentEpoch = 0

/**
 * Every authenticated request in flight, so a transition can abort and await them.
 *
 * <b>Aborting is not enough on its own — the drain is the point.</b> `abort()` returns immediately
 * and the request's own `catch`/`finally` has not run yet, so a caller that replaced the cookie right
 * after aborting would still be racing the teardown it just asked for. Holding each request's
 * settlement lets a transition wait until nothing is still processing a body.
 */
const inFlight = new Set<{ controller: AbortController; settled: Promise<void> }>()

let confirmed = false

/**
 * Called by `SessionProvider` when confirmation is gained or lost.
 *
 * <b>Lost matters as much as gained.</b> A lock, a sign-out, an expired cookie or a profile switch
 * all close the boundary again, and the finding this exists to close was precisely that requests
 * outlived the identity they were issued for.
 */
export function setPrivateNetworkConfirmed(next: boolean, profileId: number | null = null): void {
  // Every change of confirmation is a transition, including confirming: signing in replaces the
  // cookie exactly as signing out does, and a request begun before it must not be honoured after.
  currentEpoch += 1
  confirmed = next
  subject = next ? { profileId, epoch: currentEpoch } : null
}

/**
 * Close the boundary, abort everything in flight, and wait for it to finish unwinding.
 *
 * Awaited by `SessionProvider` before a sign-in, sign-out, lock, profile switch or revocation
 * replaces the cookie. The order is the whole of it: close first so nothing new starts, abort what
 * is already running, then wait — a transition that returns while a body is still being read has not
 * actually transitioned.
 */
export async function closeAndDrainPrivateNetwork(): Promise<void> {
  setPrivateNetworkConfirmed(false)
  const pending = [...inFlight]
  for (const entry of pending) entry.controller.abort()
  await Promise.allSettled(pending.map((entry) => entry.settled))
}

/**
 * Who the boundary is currently open for, and in which epoch. Null when it is shut.
 *
 * Read by the transport so a refusal can say *whose* request outlived *whose* session, which is the
 * difference between a log line somebody can act on and one that only says a request was dropped.
 */
export function confirmedSubject(): { profileId: number | null; epoch: number } | null {
  return subject
}

/** How many authenticated requests are in flight. For tests and for reasoning about a drain. */
export function inFlightPrivateRequests(): number {
  return inFlight.size
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
  // Captured at the start and checked at the end. The identity that authorised this request is the
  // only one it may be answered under.
  const startedFor = subject
  const startedIn = currentEpoch
  const controller = new AbortController()
  // The caller's own signal still works — the watchdog deadline in `request`, and the assist
  // stream's Stop. Neither may be lost by being wrapped in this one.
  const signal = init?.signal
    ? AbortSignal.any([controller.signal, init.signal])
    : controller.signal

  let settle: () => void = () => {}
  const entry = { controller, settled: new Promise<void>((resolve) => { settle = resolve }) }
  inFlight.add(entry)

  try {
    const res = await fetch(`/api${path}`, {
      // Since AUDIT A1 the session cookie is what authorises every one of these, so "cookies travel"
      // stopped being an incidental property of relative fetches and became what the API depends on.
      credentials: 'same-origin',
      ...init,
      signal,
    })

    /*
     * The reply arrived under a different identity than the one that asked.
     *
     * Refused rather than returned, and refused *before* the body is read: the response was produced
     * for whoever the cookie names now, and handing it back would render one member's data inside
     * another's session. This is the race the epoch exists for — a lock or a profile switch that
     * lands between a request starting and finishing.
     */
    if (startedIn !== currentEpoch) {
      throw new PrivateNetworkError(
        `${method} ${normalisePath(path)} outlived the session it was sent for `
        + `(profile ${startedFor?.profileId ?? 'none'}, epoch ${startedIn}; now epoch ${currentEpoch})`)
    }

    noteAuthenticatedResponse(method, path, res.status)
    return res
  } finally {
    inFlight.delete(entry)
    settle()
  }
}
