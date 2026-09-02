import { closeAndDrainPrivateNetwork } from '../api/privateNetwork'
import { closeQueueExecution } from './writeQueue'
import { closeCareVault } from '../screens/care/careOffline'
import { closeQueueStore } from './queueStore'

/**
 * Ending one identity's authority over the device, in the order the parts have to happen in.
 *
 * <b>Split out of `SessionProvider` because the order is the security property, and an order living
 * inside a component is one no test can hold.</b> The same reasoning as `sessionBoundary.ts`: the
 * provider keeps the wiring, the rule lives where it can be exercised.
 *
 * <b>What was wrong.</b> Every transition closed the stores first and let the transport catch up. A
 * lock or a detected session loss advanced the generation, closed the vault and the queue, and set
 * `locked` — and the request layer was closed later, by the React effect watching `locked`. Between
 * those two moments an authenticated body or Assist stream that was already running kept full
 * admission, so a private result could reach state after the transition that was supposed to have
 * ended its authority. React's commit schedule is not a security barrier.
 *
 * <b>The three steps, and why they are in this order.</b>
 *
 * 1. <b>Close admission and abort, synchronously.</b> `closeAndDrainPrivateNetwork` and
 *    `closeQueueExecution` both do their real work — shut the gate, advance the epoch, abort what is
 *    in flight — before their first `await`, so authority ends on the line that calls this rather
 *    than at the next render.
 * 2. <b>Await the settlement.</b> `abort()` returns before the request's own unwinding has happened,
 *    and a transition that proceeds into that gap is racing the teardown it just asked for.
 * 3. <b>Close the stores, last.</b> An operation still unwinding belongs to the old owner and has a
 *    durability decision left to make — a queued write deciding whether it stays queued. Closing
 *    first strands that decision, which is how a write that the server had already accepted would be
 *    left in the queue to be sent again.
 */
export function endSessionAuthority(): Promise<void> {
  return Promise.allSettled([closeAndDrainPrivateNetwork(), closeQueueExecution()])
    .then(() => { closePrivateStores() })
}

/**
 * Close both durable private stores, leaving what is sealed on the device.
 *
 * Closing is not erasing — see `careVault`. Exported for the boot paths, which decide that no store
 * should be open at all and have nothing in flight to drain; every *transition* goes through
 * {@link endSessionAuthority} instead, and the difference is exactly the drain.
 */
export function closePrivateStores(): void {
  closeCareVault()
  closeQueueStore()
}
