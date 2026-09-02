/**
 * Which identity boundary the panel is on, counted rather than described.
 *
 * <b>The gap this closes.</b> `SessionProvider.refresh` reads the session, awaits, and then reopens
 * the request boundary from what it read. Between those two moments the boundary can *close* — a
 * lock, a sign-out, an expired cookie, a switch to somebody else — and the refresh would go on to
 * finish and reopen it anyway, from a session the panel had already revoked. What it captured was
 * `locked` at the moment it started, which is a copy of a decision rather than a claim on it, and a
 * stale copy reopening a shut boundary is the one direction that must never happen quietly.
 *
 * <b>A counter, and specifically not a flag or a closure.</b> A flag answers "is the panel locked
 * now", which is the wrong question: two transitions can leave it in the same state it started in —
 * sign out, sign back in — and a flow that slept through both must still be refused, because the
 * cookie it was issued under is gone. Only a number that never repeats can say "the world moved"
 * rather than "the world differs". And a closure over the value at capture time is what was there
 * before; it is the thing being replaced, not a way to implement this.
 *
 * <b>How it is used.</b> A transition calls {@link SessionBoundary.begin} synchronously, at the moment
 * its intent is expressed and before it awaits anything, so nothing can start under the old number
 * after the new one exists. An asynchronous flow captures {@link SessionBoundary.current} at its start
 * and asks {@link SessionBoundary.holds} before it touches identity, the request boundary, or the
 * private stores — at every await point, not merely the first, because each one is a fresh window.
 *
 * Refusing is always safe. The flow that superseded it has already decided, and a boundary left shut
 * is a PIN prompt rather than a leak.
 */
export interface SessionBoundary {
  /** Open a new generation. Called synchronously by every transition, before it awaits anything. */
  begin(): number
  /** The generation running now. Captured by an asynchronous flow when it starts. */
  current(): number
  /** Whether a flow that began in this generation may still act. */
  holds(began: number): boolean
}

export function createSessionBoundary(): SessionBoundary {
  let generation = 0
  return {
    begin: () => (generation += 1),
    current: () => generation,
    holds: (began) => began === generation,
  }
}
