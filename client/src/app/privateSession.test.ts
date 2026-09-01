import { describe, expect, it } from 'vitest'
import { privateSessionMode } from './PrivateSession'

/**
 * The lock as an execution boundary rather than a rendering one, in the three states Hermes set out.
 *
 * These are states the panel actually passes through, not permutations of three booleans: a cold
 * boot, a locked panel, a phone unlocked out of range, and a session the server has confirmed.
 */
describe('privateSessionMode', () => {
  it('is locked while locked, however confirmed the profile is', () => {
    // The whole finding in one assertion: being drawn or not drawn was never the question.
    expect(privateSessionMode(true, 1, false)).toBe('locked')
    expect(privateSessionMode(true, 1, true)).toBe('locked')
  })

  it('is locked before anybody is selected', () => {
    // The cold-boot frame, before the session call answers.
    expect(privateSessionMode(false, null, false)).toBe('locked')
  })

  /**
   * <b>Device-only is not confirmed, and an unreachable server does not make it so.</b>
   *
   * The first version of this treated it as fully private because there was nothing to fetch.
   * Hermes rejected that reasoning outright: connectivity returns while stale cookies and polling
   * effects are still live, and that window is where an old identity's request lands under a new
   * one's cookie. The capability here is the local encrypted Care vault, and nothing on the network.
   */
  it('is offlineCare when unlocked but unconfirmed', () => {
    expect(privateSessionMode(false, 1, true)).toBe('offlineCare')
  })

  it('is confirmed only when unlocked and the server has said who this is', () => {
    expect(privateSessionMode(false, 1, false)).toBe('confirmed')
  })

  it('passes through locked between two members rather than straight across', () => {
    // A switch goes via the lock, so there is no frame in which the tree is confirmed for one member
    // while the session already says another.
    expect(privateSessionMode(true, 2, false)).toBe('locked')
  })
})
